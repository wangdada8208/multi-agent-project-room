#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface CliIO {
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

function parseArgs(args: string[]): { command: string; subCommand?: string; flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let i = 0;
  const command = args[i++] || "";
  let subCommand: string | undefined;

  if (command === "identity" && args[i] === "create") {
    subCommand = args[i++];
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = "true";
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { command, subCommand, flags, positional };
}

export async function runCli(args: string[], io: CliIO = { stdout: (m) => console.log(m), stderr: (m) => console.error(m) }): Promise<number> {
  const { command, subCommand, flags, positional } = parseArgs(args);
  const port = flags.port || process.env.OWNER_NOTES_PORT || "8787";

  try {
    if (command === "identity" && subCommand === "create") {
      const dir = flags.dir || ".";
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      const dbKey = "0x" + randomBytes(32).toString("hex");

      const envContent = [
        `XMTP_WALLET_KEY=${key}`,
        `XMTP_DB_ENCRYPTION_KEY=${dbKey}`,
        `XMTP_ENV=dev`,
        "",
      ].join("\n");

      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, ".env"), envContent, { encoding: "utf8", mode: 0o600, flag: "wx" });

      io.stdout(JSON.stringify({ address: account.address.toLowerCase() }));
      return 0;
    }

    if (command === "start") {
      const envFile = flags.env || ".env";
      const indexPath = path.resolve(import.meta.dirname, "index.ts");
      const child = spawn(process.execPath, ["--env-file=" + envFile, "--experimental-strip-types", indexPath], {
        stdio: "inherit",
      });
      return new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 0));
      });
    }

    if (command === "request") {
      const to = flags.to || "";
      const scope = flags.scope || "calendar.free_busy";
      const date_from = flags.from || "";
      const date_to = flags["to-date"] || "";
      const purpose = flags.purpose || "";

      const res = await fetch(`http://127.0.0.1:${port}/api/requests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MAPR-Owner": "1",
        },
        body: JSON.stringify({ to, scope, date_from, date_to, purpose }),
      });
      const data = await res.json();
      io.stdout(JSON.stringify(data));
      return res.ok ? 0 : 1;
    }

    if (command === "consents") {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: {
          "X-MAPR-Owner": "1",
        },
      });
      const data = (await res.json()) as any;
      io.stdout(JSON.stringify(data.consents || []));
      return res.ok ? 0 : 1;
    }

    if (command === "approve") {
      const id = positional[0] || flags.id || "";
      const res = await fetch(`http://127.0.0.1:${port}/api/consents/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: {
          "X-MAPR-Owner": "1",
        },
      });
      const data = await res.json();
      io.stdout(JSON.stringify(data));
      return res.ok ? 0 : 1;
    }

    if (command === "deny") {
      const id = positional[0] || flags.id || "";
      const res = await fetch(`http://127.0.0.1:${port}/api/consents/${encodeURIComponent(id)}/deny`, {
        method: "POST",
        headers: {
          "X-MAPR-Owner": "1",
        },
      });
      const data = await res.json();
      io.stdout(JSON.stringify(data));
      return res.ok ? 0 : 1;
    }

    if (command === "task") {
      const to = flags.to || "";
      const goal = flags.goal || "";
      const acceptanceRaw = flags.acceptance || "";
      const acceptance = acceptanceRaw.split(",").map((s) => s.trim()).filter(Boolean);

      const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MAPR-Owner": "1",
        },
        body: JSON.stringify({ to, goal, acceptance }),
      });
      const data = await res.json();
      io.stdout(JSON.stringify(data));
      return res.ok ? 0 : 1;
    }

    io.stderr(JSON.stringify({ ok: false, reason: "unknown_command", command }));
    return 1;
  } catch (err: any) {
    io.stderr(JSON.stringify({ ok: false, reason: err.message || "error" }));
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
