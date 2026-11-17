import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "./cliEngines.ts";

const NODE = process.execPath;

async function withSandbox(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "mapr-runcli-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseRun(dir: string, code: string, extra: Partial<Parameters<typeof runCli>[0]> = {}) {
  return {
    argv: [NODE, "-e", code],
    stdin: "",
    cwd: dir,
    signal: AbortSignal.timeout(30_000),
    env: { PATH: process.env.PATH },
    maxOutputBytes: 64 * 1024,
    ...extra,
  };
}

test("runCli captures stdout and exit code without a shell", async () => {
  await withSandbox(async (dir) => {
    const result = await runCli(
      baseRun(dir, `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log("echo:"+d)})`, {
        stdin: "hello prompt",
      })
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "echo:hello prompt");
    assert.equal(result.truncated, false);
  });
});

test("runCli reports non-zero exit code and stderr", async () => {
  await withSandbox(async (dir) => {
    const result = await runCli(baseRun(dir, `console.error("boom");process.exit(3)`));
    assert.equal(result.code, 3);
    assert.match(result.stderr, /boom/);
  });
});

test("runCli truncates stdout beyond maxOutputBytes", async () => {
  await withSandbox(async (dir) => {
    const result = await runCli(
      baseRun(dir, `console.log("x".repeat(100000))`, { maxOutputBytes: 1024 })
    );
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 1024);
  });
});

test("runCli abort kills the child and rejects with AbortError (S8)", async () => {
  await withSandbox(async (dir) => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = runCli(baseRun(dir, `setTimeout(()=>{},60000)`, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(promise, (err: any) => {
      assert.equal(err.name, "AbortError");
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `child should be dead quickly after abort, took ${elapsed}ms`);
  });
});

test("runCli escalates to SIGKILL when the child ignores SIGTERM", async () => {
  await withSandbox(async (dir) => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = runCli(
      baseRun(dir, `process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)`, { signal: controller.signal })
    );
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(promise, (err: any) => {
      assert.equal(err.name, "AbortError");
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 5_000 && elapsed < 15_000, `SIGKILL after ~5s grace, took ${elapsed}ms`);
  });
});

test("runCli passes only the supplied env to the child", async () => {
  await withSandbox(async (dir) => {
    const result = await runCli(
      baseRun(dir, `console.log(JSON.stringify({w:process.env.XMTP_WALLET_KEY||null,h:process.env.HUB_TOKEN||null,p:typeof process.env.PATH}))`, {
        env: { PATH: process.env.PATH },
      })
    );
    const seen = JSON.parse(result.stdout);
    assert.equal(seen.w, null);
    assert.equal(seen.h, null);
    assert.equal(seen.p, "string");
  });
});
