import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDarwinSeatbeltProfile,
  codexEngine,
  createCodexEngine,
  DARWIN_SANDBOX_EXEC,
  escapeSbplString,
  geminiCliEngine,
  minimalEnv,
  type CliRun,
} from "./cliEngines.ts";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-cli-engines-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("minimalEnv includes binary dirname and POSIX fallback paths without leaking host API keys", () => {
  const hostEnv: NodeJS.ProcessEnv = {
    HOME: "/Users/alice",
    LANG: "zh_CN.UTF-8",
    TERM: "xterm-256color",
    PATH: "/usr/bin:/bin",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-openai-secret",
    GEMINI_API_KEY: "gemini-secret",
    XMTP_WALLET_KEY: "0xdeadbeef",
    HUB_TOKEN: "hub-secret-token",
    MAPR_HELPER_TOKEN: "mhp-secret",
  };

  const env = minimalEnv(hostEnv, "/Users/alice/.nvm/versions/node/v22.14.0/bin/claude", "darwin");
  const pathParts = (env.PATH || "").split(":");

  assert.equal(pathParts[0], "/Users/alice/.nvm/versions/node/v22.14.0/bin");
  for (const expected of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/Users/alice/.local/bin"]) {
    assert.ok(pathParts.includes(expected), `expected ${expected} in minimalEnv PATH`);
  }

  // Never leaks host API keys or internal tokens
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.XMTP_WALLET_KEY, undefined);
  assert.equal(env.HUB_TOKEN, undefined);
  assert.equal(env.MAPR_HELPER_TOKEN, undefined);
  assert.equal(env.HOME, "/Users/alice");
  assert.equal(env.LANG, "zh_CN.UTF-8");
});

test("escapeSbplString escapes quotes/backslashes and rejects control characters", () => {
  assert.equal(escapeSbplString('/Users/a"b\\c'), '/Users/a\\"b\\\\c');
  for (const bad of ["/tmp/bad\npath", "/tmp/bad\x00path", "/tmp/bad\x1fpath", "/tmp/bad\x7fpath"]) {
    assert.throws(() => escapeSbplString(bad), /invalid path for sandbox profile/);
    assert.throws(
      () => buildDarwinSeatbeltProfile(bad, undefined, [], "/Users/alice"),
      /invalid path for sandbox profile/
    );
  }
});

test("buildDarwinSeatbeltProfile denies sensitive dot-dirs before re-allowing sandboxDir and extraRwDirs", () => {
  const realMap: Record<string, string> = {
    "/Users/alice": "/System/Volumes/Data/Users/alice",
    "/Users/alice/.mapr/sandbox/seat-1": "/System/Volumes/Data/Users/alice/.mapr/sandbox/seat-1",
    "/var/link-rw": "/private/var/link-rw",
    "/tmp/with trailing space ": "/private/tmp/with trailing space ",
  };
  const profile = buildDarwinSeatbeltProfile(
    "/Users/alice/.mapr/sandbox/seat-1",
    undefined,
    ["/var/link-rw::/tmp/with trailing space :"],
    "/Users/alice",
    (p) => realMap[p] ?? p
  );

  assert.match(profile, /\(version 1\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(literal "\/dev\/null"\)/);
  assert.match(profile, /\(subpath "\/tmp"\)/);
  assert.match(profile, /\(subpath "\/private\/tmp"\)/);
  assert.match(profile, /\(subpath "\/var\/folders"\)/);
  assert.match(profile, /\(subpath "\/private\/var\/folders"\)/);

  const denyReadIdx = profile.indexOf("(deny file-read*");
  const allowSandboxReadIdx = profile.indexOf("(allow file-read*\n");
  assert.ok(denyReadIdx > 0, "must emit (deny file-read* ...) block");
  assert.ok(
    allowSandboxReadIdx > denyReadIdx,
    "(allow file-read* ...) for sandboxDir must follow (deny file-read* ...)"
  );

  const denyReadBlock = profile.slice(denyReadIdx, allowSandboxReadIdx);
  for (const rel of [".mapr", ".ssh", ".aws", ".gnupg", ".config/gcloud"]) {
    assert.ok(
      denyReadBlock.includes(`(subpath "/Users/alice/${rel}")`),
      `expected raw home ${rel} denied in file-read*`
    );
    assert.ok(
      denyReadBlock.includes(`(subpath "/System/Volumes/Data/Users/alice/${rel}")`),
      `expected realpath home ${rel} denied in file-read*`
    );
  }
  for (const cliAuthDir of [".codex", ".claude", ".gemini"]) {
    assert.ok(
      !denyReadBlock.includes(cliAuthDir),
      `must NOT deny CLI auth dir ${cliAuthDir}`
    );
  }

  const allowWriteIdx = profile.indexOf("(deny file-write*)");
  const allowReadBlock = profile.slice(allowSandboxReadIdx, allowWriteIdx);
  for (const expectedReadable of [
    "/Users/alice/.mapr/sandbox/seat-1",
    "/System/Volumes/Data/Users/alice/.mapr/sandbox/seat-1",
    "/var/link-rw",
    "/private/var/link-rw",
    "/tmp/with trailing space ",
    "/private/tmp/with trailing space ",
  ]) {
    assert.ok(
      allowReadBlock.includes(`(subpath "${expectedReadable}")`),
      `expected ${expectedReadable} in allow file-read* block`
    );
    assert.ok(
      profile.slice(allowWriteIdx).includes(`(subpath "${expectedReadable}")`),
      `expected ${expectedReadable} in allow file-write* block`
    );
  }
});

test("codexEngine on darwin verifies /usr/bin/sandbox-exec and invokes Seatbelt profile with resolved realpath", async () => {
  await withTmp(async (tmp) => {
    const realSandbox = path.join(tmp, "real-sandbox");
    const linkSandbox = path.join(tmp, "link-sandbox");
    await mkdir(realSandbox, { recursive: true });
    await symlink(realSandbox, linkSandbox);

    let checkedPath = "";
    let seenRun: CliRun | null = null;

    const engine = createCodexEngine(
      {
        kind: "codex",
        binaryPath: "/opt/homebrew/bin/codex",
        sandboxDir: linkSandbox,
        timeoutMs: 15_000,
        model: "o4-mini",
      },
      {
        platform: "darwin",
        accessImpl: (filePath) => {
          checkedPath = filePath;
        },
        env: { HOME: "/Users/dev", PATH: "/usr/bin:/bin" },
        runCliImpl: async (run) => {
          seenRun = run;
          const outIdx = run.argv.indexOf("-o");
          assert.ok(outIdx > 0, "codexArgv must pass -o <outFile>");
          const outFile = run.argv[outIdx + 1];
          await writeFile(outFile, "macOS sandbox reply\n", "utf8");
          return { code: 0, stdout: "", stderr: "", truncated: false };
        },
      }
    );

    const reply = await engine.reply({
      prompt: "hello codex",
      signal: AbortSignal.timeout(10_000),
    });

    assert.equal(checkedPath, DARWIN_SANDBOX_EXEC);
    assert.equal(reply, "macOS sandbox reply");
    assert.ok(seenRun);
    const argv = (seenRun as CliRun).argv;
    assert.equal(argv[0], DARWIN_SANDBOX_EXEC);
    assert.equal(argv[1], "-p");
    const profile = argv[2];
    assert.ok(profile.includes('(subpath "/Users/dev/.mapr")'), "denies HOME/.mapr reads");
    assert.ok(profile.includes(`(subpath "${linkSandbox}")`), "raw sandboxDir allowed");
    assert.ok(profile.includes(`(subpath "${realSandbox}")`), "realpath sandboxDir allowed");
    assert.ok(profile.includes("(deny file-write*)"), "global file-write denied");
    assert.equal(argv[3], "/opt/homebrew/bin/codex");
    assert.equal(argv[4], "exec");
    assert.ok(((seenRun as CliRun).env.PATH || "").includes("/opt/homebrew/bin"));
  });
});

test("codexEngine on darwin throws when /usr/bin/sandbox-exec is missing or non-executable", () => {
  assert.throws(
    () =>
      codexEngine(
        {
          kind: "codex",
          binaryPath: "/opt/homebrew/bin/codex",
          sandboxDir: "/tmp/s",
          timeoutMs: 5_000,
        },
        {
          platform: "darwin",
          accessImpl: () => {
            throw new Error("ENOENT");
          },
        }
      ),
    /sandbox-exec/
  );
});

test("codexEngine on linux still requires bubblewrap", () => {
  assert.throws(
    () =>
      codexEngine(
        {
          kind: "codex",
          binaryPath: "/usr/bin/codex",
          sandboxDir: "/tmp/s",
          timeoutMs: 5_000,
        },
        {
          platform: "linux",
          findBwrapImpl: () => null,
        }
      ),
    /bubblewrap/
  );
});

test("geminiCliEngine creates non-empty sandboxDir with 0700 and falls back to os.tmpdir() when empty", async () => {
  await withTmp(async (tmp) => {
    const nestedSandbox = path.join(tmp, "gemini-seat", "sandbox");
    let seenCwd = "";
    const engineWithSandbox = geminiCliEngine(
      {
        kind: "gemini-cli",
        binaryPath: "/usr/local/bin/gemini",
        sandboxDir: nestedSandbox,
        timeoutMs: 10_000,
      },
      {
        env: { HOME: tmp, PATH: "/usr/bin:/bin" },
        runCliImpl: async (run) => {
          seenCwd = run.cwd;
          return { code: 0, stdout: "gemini isolated ok\n", stderr: "", truncated: false };
        },
      }
    );

    const out = await engineWithSandbox.reply({
      prompt: "ping",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(out, "gemini isolated ok");
    assert.equal(seenCwd, nestedSandbox);
    const st = await stat(nestedSandbox);
    assert.ok(st.isDirectory());
    if (process.platform !== "win32") {
      assert.equal(st.mode & 0o777, 0o700);
    }

    let fallbackCwd = "";
    const engineWithoutSandbox = geminiCliEngine(
      {
        kind: "gemini-cli",
        binaryPath: "/usr/local/bin/gemini",
        sandboxDir: "",
        timeoutMs: 10_000,
      },
      {
        env: { HOME: tmp, PATH: "/usr/bin:/bin" },
        runCliImpl: async (run) => {
          fallbackCwd = run.cwd;
          return { code: 0, stdout: "fallback ok\n", stderr: "", truncated: false };
        },
      }
    );
    await engineWithoutSandbox.reply({
      prompt: "ping",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(fallbackCwd, os.tmpdir());
  });
});
