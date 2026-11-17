import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { engineConfigFromEnv } from "./index.ts";
import { bwrapWrap, childEnv, claudeArgv, codexArgv, geminiArgv, toolchainDirs } from "./cliEngines.ts";
import { httpModelEngine, openAiCompatibleEngine, webhookEngine } from "./httpEngines.ts";
import { createHmac } from "node:crypto";

const SANDBOX = "/tmp/mapr-test-sandbox";

test("engineConfigFromEnv: no engine env returns null (listen only)", () => {
  assert.equal(engineConfigFromEnv({}), null);
});

test("engineConfigFromEnv: legacy MEMBER_MODEL_* becomes http-model", () => {
  const config = engineConfigFromEnv({
    MEMBER_MODEL_URL: "https://model.example/complete",
    MEMBER_MODEL_API_KEY: "k",
  });
  assert.deepEqual(config, {
    kind: "http-model",
    url: "https://model.example/complete",
    apiKey: "k",
    timeoutMs: 120_000,
  });
});

test("engineConfigFromEnv: half-set legacy env throws instead of silently listening", () => {
  assert.throws(() => engineConfigFromEnv({ MEMBER_MODEL_URL: "https://x" }), /set together/);
});

test("engineConfigFromEnv: unknown kind throws", () => {
  assert.throws(() => engineConfigFromEnv({ MEMBER_AGENT_KIND: "skynet" }), /unknown MEMBER_AGENT_KIND/);
});

test("engineConfigFromEnv: cli kinds require absolute bin and sandbox", () => {
  assert.throws(
    () => engineConfigFromEnv({ MEMBER_AGENT_KIND: "claude-code" }),
    /MEMBER_AGENT_BIN/
  );
  assert.throws(
    () =>
      engineConfigFromEnv({
        MEMBER_AGENT_KIND: "claude-code",
        MEMBER_AGENT_BIN: "claude",
        MEMBER_AGENT_SANDBOX_DIR: SANDBOX,
      }),
    /absolute path/
  );
  const config = engineConfigFromEnv({
    MEMBER_AGENT_KIND: "codex",
    MEMBER_AGENT_BIN: "/usr/bin/codex",
    MEMBER_AGENT_SANDBOX_DIR: SANDBOX,
    MEMBER_AGENT_MODEL: "gpt-5",
    MEMBER_AGENT_TIMEOUT_MS: "30000",
  });
  assert.deepEqual(config, {
    kind: "codex",
    binaryPath: "/usr/bin/codex",
    sandboxDir: SANDBOX,
    timeoutMs: 30_000,
    model: "gpt-5",
  });
});

test("engineConfigFromEnv: openai-compatible requires base/key/model", () => {
  assert.throws(
    () =>
      engineConfigFromEnv({
        MEMBER_AGENT_KIND: "openai-compatible",
        MEMBER_AGENT_BASE_URL: "https://api.x.ai/v1",
      }),
    /MEMBER_AGENT_API_KEY/
  );
  const config = engineConfigFromEnv({
    MEMBER_AGENT_KIND: "openai-compatible",
    MEMBER_AGENT_BASE_URL: "https://api.x.ai/v1",
    MEMBER_AGENT_API_KEY: "xai-key",
    MEMBER_AGENT_MODEL: "grok-4",
  });
  assert.equal(config?.kind, "openai-compatible");
});

test("engineConfigFromEnv: webhook requires url and secret", () => {
  const config = engineConfigFromEnv({
    MEMBER_AGENT_KIND: "webhook",
    MEMBER_AGENT_WEBHOOK_URL: "https://bot.example/ask",
    MEMBER_AGENT_WEBHOOK_SECRET: "s",
  });
  assert.deepEqual(config, {
    kind: "webhook",
    url: "https://bot.example/ask",
    secret: "s",
    timeoutMs: 120_000,
  });
});

test("engineConfigFromEnv: invalid timeout throws", () => {
  assert.throws(
    () => engineConfigFromEnv({ MEMBER_AGENT_TIMEOUT_MS: "soon" }),
    /MEMBER_AGENT_TIMEOUT_MS/
  );
});

test("claudeArgv matches the documented pure-chat invocation", () => {
  const argv = claudeArgv({
    kind: "claude-code",
    binaryPath: "/usr/bin/claude",
    sandboxDir: SANDBOX,
    timeoutMs: 1000,
    model: "sonnet",
  });
  assert.deepEqual(argv, [
    "/usr/bin/claude",
    "-p",
    "--output-format", "json",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--no-session-persistence",
    "--model", "sonnet",
  ]);
});

test("codexArgv matches the documented non-interactive invocation", () => {
  const argv = codexArgv(
    { kind: "codex", binaryPath: "/usr/bin/codex", sandboxDir: SANDBOX, timeoutMs: 1000 },
    "/tmp/out.txt"
  );
  assert.deepEqual(argv, [
    "/usr/bin/codex",
    "exec",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "-C", SANDBOX,
    "-o", "/tmp/out.txt",
    "-",
  ]);
});

test("bwrapWrap masks every home then re-exposes only the allowlist", () => {
  const inner = codexArgv(
    { kind: "codex", binaryPath: process.execPath, sandboxDir: SANDBOX, timeoutMs: 1000 },
    "/tmp/out.txt"
  );
  // CODEX_HOME 要真实存在才会下发可写挂载；用临时目录避免依赖本机路径。
  const tmp = mkdtempSync(path.join(tmpdir(), "mapr-bwrap-test-"));
  const codexHome = path.join(tmp, "codexhome");
  const extraRw = path.join(tmp, "magpie");
  mkdirSync(codexHome);
  mkdirSync(extraRw);
  const argv = bwrapWrap(inner, {
    bwrapPath: "/usr/bin/bwrap",
    binaryPath: process.execPath,
    sandboxDir: SANDBOX,
    codexHome,
    homeDir: "/data",
    extraRwDirs: [extraRw],
  });
  assert.equal(argv[0], "/usr/bin/bwrap");
  const joined = argv.join(" ");
  assert.ok(joined.includes("--unshare-all"));
  assert.ok(joined.includes("--share-net"), "model API needs the shared network");
  assert.ok(joined.includes("--ro-bind / /"), "root is read-only visible");
  assert.ok(joined.includes("--tmpfs /home"), "all users' homes masked");
  assert.ok(joined.includes("--tmpfs /root"), "root's home masked");
  assert.ok(joined.includes("--tmpfs /data"), "non-standard home masked");
  assert.ok(joined.includes(`--bind ${SANDBOX} ${SANDBOX}`), "sandbox must be writable");
  assert.ok(joined.includes(`--bind ${codexHome} ${codexHome}`), "CODEX_HOME writable");
  assert.ok(joined.includes(`--bind ${extraRw} ${extraRw}`), "extra rw dir exposed");
  assert.deepEqual(argv.slice(-inner.length), inner, "inner argv appended verbatim");

  const homeUnderSlashHome = bwrapWrap(inner, {
    bwrapPath: "/usr/bin/bwrap",
    binaryPath: process.execPath,
    sandboxDir: SANDBOX,
    codexHome: null,
    homeDir: "/home/u",
  }).join(" ");
  assert.ok(!homeUnderSlashHome.includes("--tmpfs /home/u"), "/home already covers it");
});

test("toolchainDirs mounts the install tree but never home itself", () => {
  // 在临时目录里搭 script → exec target 链：bin/codex 是包装脚本，
  // exec 到 versions 下的真实二进制，断言链的两级目录都被跟随。
  const tmp = mkdtempSync(path.join(tmpdir(), "mapr-toolchain-test-"));
  const wrapper = path.join(tmp, "deps", "bin", "codex");
  const target = path.join(tmp, "codex", "versions", "1.0", "codex-real");
  mkdirSync(path.dirname(wrapper), { recursive: true });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "binary");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${target}" "$@"\n`);
  const dirs = toolchainDirs(wrapper, "/home/u");
  assert.ok(dirs.includes(path.join(tmp, "deps", "bin")));
  assert.ok(dirs.includes(path.join(tmp, "deps")));
  assert.ok(dirs.some((d) => d.includes("codex/versions")), "exec target parent dir is followed");
  assert.deepEqual(toolchainDirs("/usr/bin/codex", "/home/u"), []);
  assert.deepEqual(toolchainDirs("/home/u", "/home/u"), []);
  assert.deepEqual(toolchainDirs("/bin/sh", "/home/u"), []);
});

test("geminiArgv passes prompt and optional model", () => {
  const argv = geminiArgv(
    { kind: "gemini-cli", binaryPath: "/usr/bin/gemini", sandboxDir: SANDBOX, timeoutMs: 1000, model: "g" },
    "hello"
  );
  assert.deepEqual(argv, ["/usr/bin/gemini", "-p", "hello", "-m", "g"]);
});

test("childEnv passes only the whitelist, never XMTP or hub secrets", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "en_US.UTF-8",
    TERM: "xterm",
    ANTHROPIC_API_KEY: "anthropic-key",
    ANTHROPIC_BASE_URL: "https://gw.example",
    OPENAI_API_KEY: "openai-key",
    CODEX_HOME: "/home/u/.codex",
    XMTP_WALLET_KEY: "wallet-secret",
    XMTP_DB_ENCRYPTION_KEY: "db-secret",
    HUB_TOKEN: "hub-secret",
    MEMBER_MODEL_API_KEY: "model-secret",
    MAPR_HELPER_TOKEN: "helper-secret",
  };
  assert.deepEqual(childEnv("claude-code", parent), {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "en_US.UTF-8",
    TERM: "xterm",
    ANTHROPIC_API_KEY: "anthropic-key",
    ANTHROPIC_BASE_URL: "https://gw.example",
  });
  assert.deepEqual(childEnv("codex", parent), {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "en_US.UTF-8",
    TERM: "xterm",
    OPENAI_API_KEY: "openai-key",
    CODEX_HOME: "/home/u/.codex",
  });
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

const NO_SIGNAL = { signal: AbortSignal.timeout(60_000) };

test("openai-compatible engine posts chat/completions and returns content", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const fetchImpl = (async (input: any, init: any) => {
    seenUrl = String(input);
    seenAuth = init.headers.Authorization;
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
  }) as typeof fetch;
  const engine = openAiCompatibleEngine(
    { kind: "openai-compatible", baseUrl: "https://api.x.ai/v1/", apiKey: "k", model: "grok-4", timeoutMs: 1000 },
    fetchImpl
  );
  assert.equal(await engine.reply({ prompt: "yo", ...NO_SIGNAL }), "hi");
  assert.equal(seenUrl, "https://api.x.ai/v1/chat/completions");
  assert.equal(seenAuth, "Bearer k");
});

test("openai-compatible engine rejects non-https baseUrl", async () => {
  const engine = openAiCompatibleEngine(
    { kind: "openai-compatible", baseUrl: "http://api.x.ai/v1", apiKey: "k", model: "m", timeoutMs: 1000 }
  );
  await assert.rejects(() => engine.reply({ prompt: "yo", ...NO_SIGNAL }), /must be https/);
});

test("openai-compatible engine error does not leak apiKey or response body", async () => {
  const engine = openAiCompatibleEngine(
    { kind: "openai-compatible", baseUrl: "https://api.x.ai/v1", apiKey: "SECRET-KEY-123", model: "m", timeoutMs: 1000 },
    fakeFetch(500, { error: "SECRET-KEY-123 internal detail" })
  );
  await assert.rejects(
    () => engine.reply({ prompt: "yo", ...NO_SIGNAL }),
    (err: any) => {
      assert.match(err.message, /status 500/);
      assert.equal(err.message.includes("SECRET-KEY-123"), false);
      return true;
    }
  );
});

test("openai-compatible engine rejects missing content field", async () => {
  const engine = openAiCompatibleEngine(
    { kind: "openai-compatible", baseUrl: "https://api.x.ai/v1", apiKey: "k", model: "m", timeoutMs: 1000 },
    fakeFetch(200, { choices: [{ message: {} }] })
  );
  await assert.rejects(() => engine.reply({ prompt: "yo", ...NO_SIGNAL }), /missing choices/);
});

test("webhook engine signs the body with HMAC-SHA256", async () => {
  let seenSignature = "";
  let seenBody = "";
  const fetchImpl = (async (_input: any, init: any) => {
    seenSignature = init.headers["X-MAPR-Signature"];
    seenBody = init.body;
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  }) as typeof fetch;
  const engine = webhookEngine(
    { kind: "webhook", url: "https://bot.example/ask", secret: "s3cret", timeoutMs: 1000 },
    fetchImpl
  );
  assert.equal(await engine.reply({ prompt: "ping", ...NO_SIGNAL }), "ok");
  const expected = createHmac("sha256", "s3cret").update(JSON.stringify({ prompt: "ping" })).digest("hex");
  assert.equal(seenSignature, expected);
  assert.deepEqual(JSON.parse(seenBody), { prompt: "ping" });
});

test("webhook engine error does not leak secret", async () => {
  const engine = webhookEngine(
    { kind: "webhook", url: "https://bot.example/ask", secret: "TOP-SECRET", timeoutMs: 1000 },
    fakeFetch(403, "TOP-SECRET denied")
  );
  await assert.rejects(
    () => engine.reply({ prompt: "yo", ...NO_SIGNAL }),
    (err: any) => {
      assert.equal(err.message.includes("TOP-SECRET"), false);
      return true;
    }
  );
});

test("http-model engine preserves the legacy channel", async () => {
  let seenAuth = "";
  const fetchImpl = (async (_input: any, init: any) => {
    seenAuth = init.headers.Authorization;
    return new Response(JSON.stringify({ text: "legacy ok" }), { status: 200 });
  }) as typeof fetch;
  const engine = httpModelEngine(
    { kind: "http-model", url: "https://model.example/complete", apiKey: "legacy-key", timeoutMs: 1000 },
    fetchImpl
  );
  assert.equal(await engine.reply({ prompt: "yo", ...NO_SIGNAL }), "legacy ok");
  assert.equal(seenAuth, "Bearer legacy-key");
});
