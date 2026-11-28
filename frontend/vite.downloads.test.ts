import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, preview } from "vite";

let root: string;
const frontend = fileURLToPath(new URL(".", import.meta.url));
const archive = gzipSync("synthetic download fixture");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "parlor-downloads-test-"));
  for (const dir of [root, join(root, "dist")]) {
    const assets = dir === root ? join(dir, "public") : dir;
    await mkdir(join(assets, "downloads"), { recursive: true });
    await writeFile(join(dir, "index.html"), "<html><body>Parlor SPA</body></html>");
    await writeFile(join(assets, "downloads", "present.tar.gz"), archive);
    for (const script of ["install.sh", "install.ps1"]) {
      await copyFile(join(frontend, "public", script), join(assets, script));
    }
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each(["dev", "preview"])("serves installers and real archives and returns 404 for missing downloads in Vite %s", async (mode) => {
  const config = { configFile: join(frontend, "vite.config.ts"), root, logLevel: "silent" as const };
  const listen = { host: "127.0.0.1", port: 0 };
  const server = mode === "dev"
    ? await (await createServer({ ...config, server: { ...listen, ws: false } })).listen()
    : await preview({ ...config, preview: listen });

  try {
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite did not listen on a TCP port");
    const web = `http://127.0.0.1:${address.port}`;
    for (const [script, start] of [["install.sh", "#!/bin/sh"], ["install.ps1", "#"]]) {
      const response = await fetch(`${web}/${script}`);
      expect(response.status).toBe(200);
      expect((await response.text()).startsWith(start)).toBe(true);
    }
    const present = await fetch(`${web}/downloads/present.tar.gz`);
    expect(present.status).toBe(200);
    expect(Buffer.from(await present.arrayBuffer())).toEqual(archive);

    for (const method of ["GET", "HEAD"]) {
      const missing = await fetch(`${web}/downloads/missing.tar.gz?t=1`, {
        method, headers: { Accept: "text/html,*/*" },
      });
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type") ?? "").not.toContain("text/html");
    }
    const spa = await fetch(`${web}/agents`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("Parlor SPA");
  } finally {
    await server.close();
  }
});
