import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildExpandedPath, detectLocalAgents, type DetectDeps } from "./knownAgents.ts";

async function withTmpHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "mapr-known-agents-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("buildExpandedPath preserves existing PATH, deduplicates, and sorts nvm versions descending", async () => {
  await withTmpHome(async (home) => {
    for (const ver of ["v18.20.0", "v22.2.0", "v22.14.0", "v20.18.1"]) {
      await mkdir(path.join(home, ".nvm/versions/node", ver, "bin"), { recursive: true });
    }
    const expanded = buildExpandedPath(
      { PATH: `/usr/bin:/bin:${home}/.local/bin:/usr/bin` },
      home,
      "darwin"
    );
    const parts = expanded.split(":");

    // Preserves existing order and deduplicates /usr/bin and ~/.local/bin
    assert.equal(parts[0], "/usr/bin");
    assert.equal(parts[1], "/bin");
    assert.equal(parts[2], `${home}/.local/bin`);
    assert.equal(parts.filter((p) => p === "/usr/bin").length, 1);
    assert.equal(parts.filter((p) => p === `${home}/.local/bin`).length, 1);

    // Appends all expected user and system binary directories
    for (const expected of [
      `${home}/.npm-global/bin`,
      `${home}/.volta/bin`,
      `${home}/.bun/bin`,
      `${home}/.cargo/bin`,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]) {
      assert.ok(parts.includes(expected), `missing ${expected}`);
    }

    // NVM versions sorted descending so newest Node wins
    const i2214 = parts.indexOf(`${home}/.nvm/versions/node/v22.14.0/bin`);
    const i2202 = parts.indexOf(`${home}/.nvm/versions/node/v22.2.0/bin`);
    const i2018 = parts.indexOf(`${home}/.nvm/versions/node/v20.18.1/bin`);
    const i1820 = parts.indexOf(`${home}/.nvm/versions/node/v18.20.0/bin`);
    assert.ok(i2214 > -1 && i2202 > -1 && i2018 > -1 && i1820 > -1);
    assert.ok(i2214 < i2202 && i2202 < i2018 && i2018 < i1820);
  });
});

test("buildExpandedPath leaves win32 PATH untouched", () => {
  assert.equal(
    buildExpandedPath({ PATH: "C:\\Windows\\System32;C:\\Node" }, "C:\\Users\\Alice", "win32"),
    "C:\\Windows\\System32;C:\\Node"
  );
});

test("detectLocalAgents uses hasDarwinSandbox on darwin and falls back to hasBwrap otherwise", async () => {
  const baseDeps = {
    async findOnPath(bin: string) {
      if (bin === "codex") return "/opt/homebrew/bin/codex";
      if (bin === "claude") return "/Users/u/.local/bin/claude";
      return null;
    },
    async readVersion(bin: string) {
      return bin.endsWith("codex") ? "codex 0.20.0" : "claude 2.1.0";
    },
    async exists(marker: string) {
      return marker === ".codex/auth.json" || marker === ".claude/.credentials.json";
    },
  };

  // macOS with sandbox-exec available -> codex is likely-ready
  const darwinReady = await detectLocalAgents(
    {
      ...baseDeps,
      platform: "darwin",
      hasBwrap: async () => false,
      hasDarwinSandbox: async () => true,
    },
    null
  );
  assert.equal(darwinReady.find((a) => a.key === "codex")?.loginState, "likely-ready");
  assert.equal(darwinReady.find((a) => a.key === "claude-code")?.loginState, "likely-ready");

  // macOS without sandbox-exec -> codex is unknown
  const darwinMissing = await detectLocalAgents(
    {
      ...baseDeps,
      platform: "darwin",
      hasBwrap: async () => false,
      hasDarwinSandbox: async () => false,
    },
    null
  );
  assert.equal(darwinMissing.find((a) => a.key === "codex")?.loginState, "unknown");

  // macOS when hasDarwinSandbox is omitted falls back to hasBwrap
  let bwrapChecked = false;
  const darwinFallback: DetectDeps = {
    ...baseDeps,
    platform: "darwin",
    hasBwrap: async () => {
      bwrapChecked = true;
      return true;
    },
  };
  const fallbackList = await detectLocalAgents(darwinFallback, null);
  assert.equal(bwrapChecked, true);
  assert.equal(fallbackList.find((a) => a.key === "codex")?.loginState, "likely-ready");

  // Linux without bwrap -> codex is unknown
  const linuxNoBwrap = await detectLocalAgents(
    {
      ...baseDeps,
      platform: "linux",
      hasBwrap: async () => false,
      hasDarwinSandbox: async () => true,
    },
    null
  );
  assert.equal(linuxNoBwrap.find((a) => a.key === "codex")?.loginState, "unknown");
});

test("defaultDetectDeps discovers ~/.local/bin CLIs even when service PATH omits user dirs", async () => {
  await withTmpHome(async (home) => {
    const localBin = path.join(home, ".local/bin");
    await mkdir(localBin, { recursive: true });
    const fakeClaude = path.join(localBin, "claude");
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(fakeClaude, `#!${process.execPath}\nconsole.log("claude 9.9.9-test");\n`, "utf8");
    await chmod(fakeClaude, 0o755);

    const prevHome = process.env.HOME;
    const prevPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const { defaultDetectDeps } = await import("./knownAgents.ts");
      const deps = defaultDetectDeps();
      const found = await deps.findOnPath("claude");
      assert.equal(found, fakeClaude);
      const ver = await deps.readVersion(fakeClaude, ["--version"]);
      assert.equal(ver, "claude 9.9.9-test");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});

test("parseMagpieLs 解析托管/未托管行", async () => {
  const { parseMagpieLs } = await import("./knownAgents.ts");
  const rows = parseMagpieLs([
    "  Claude Code       server/group/ds-v4.1-flash[1m]  ·  effort —    ~/.claude/settings.json",
    "  Codex             —  ·  effort —                                 ~/.codex/config.toml",
    "  MiniMax Code      magpie/group/cursor-grok-4.7-500k              ~/.minimax/config.yaml",
    "  T3 Code           provider —                                     ~/.t3/userdata/settings.json",
    "  Claude Desktop    not detected                                   ",
    "  表头不属于任何 Agent",
  ]);
  assert.deepEqual(rows, [
    { name: "Claude Code", model: "server/group/ds-v4.1-flash" },
    { name: "Codex", model: null },
    { name: "MiniMax Code", model: "group/cursor-grok-4.7-500k" },
    { name: "T3 Code", model: null },
  ]);
});

test("detectLocalAgents：Magpie 托管的 Claude 免登录态，其余托管 Agent 经网关列出", async () => {
  const deps: DetectDeps = {
    platform: "linux",
    findOnPath: async (bin) =>
      bin === "claude" ? "/usr/local/bin/claude" : bin === "magpie" ? "/usr/local/bin/magpie" : null,
    readVersion: async () => "claude 2.1.0",
    exists: async () => false, // claude 没有任何登录标记
    hasBwrap: async () => false,
    runLines: async (_bin, args) =>
      args[0] === "ls"
        ? [
            "  Claude Code       server/group/ds-v4.1-flash[1m]  ·  effort —    ~/.claude/settings.json",
            "  MiniMax Code      magpie/group/cursor-grok-4.7-500k              ~/.minimax/config.yaml",
            "  Codex             —  ·  effort —                                 ~/.codex/config.toml",
          ]
        : null,
    readJsonFile: async (rel) =>
      rel === "magpie/config/gateway.json" ? { addr: "127.0.0.1:3425" } : null,
  };
  const list = await detectLocalAgents(deps, null);
  const claude = list.find((a) => a.key === "claude-code");
  assert.equal(claude?.loginState, "likely-ready");
  const mm = list.find((a) => a.key === "magpie:minimax-code");
  assert.equal(mm?.kind, "openai-compatible");
  assert.equal(mm?.displayName, "MiniMax Code");
  assert.equal(mm?.baseUrl, "http://127.0.0.1:3425/v1");
  assert.equal(mm?.model, "group/cursor-grok-4.7-500k");
  // Codex 未被托管且没有二进制 → 不出现
  assert.equal(list.find((a) => a.key === "codex"), undefined);
});

test("detectLocalAgents：没有 magpie 或缺 runLines/readJsonFile 时行为不变", async () => {
  const noMagpie: DetectDeps = {
    platform: "linux",
    findOnPath: async (bin) => (bin === "claude" ? "/usr/local/bin/claude" : null),
    readVersion: async () => "claude 2.1.0",
    exists: async () => false,
    hasBwrap: async () => false,
  };
  const list = await detectLocalAgents(noMagpie, null);
  assert.equal(list.length, 1);
  assert.equal(list[0].loginState, "needs-login");
});

test("detectLocalAgents：cli-agent 规格表里的 CLI 可被探测并标 kind/loginState", async () => {
  const deps: DetectDeps = {
    platform: "linux",
    findOnPath: async (bin) =>
      bin === "opencode" ? "/opt/npm/bin/opencode" : bin === "dsh" ? "/usr/local/bin/dsh" : null,
    readVersion: async (p) => (p.includes("opencode") ? "opencode 1.2.3" : "dsh 4.5.6"),
    exists: async (p) => p === ".local/share/opencode/auth.json",
    hasBwrap: async () => true,
  };
  const list = await detectLocalAgents(deps, null);
  const oc = list.find((a) => a.key === "opencode");
  assert.equal(oc?.kind, "cli-agent");
  assert.equal(oc?.displayName, "OpenCode");
  assert.equal(oc?.loginState, "likely-ready");
  const dsh = list.find((a) => a.key === "dsh");
  assert.equal(dsh?.kind, "cli-agent");
  assert.equal(dsh?.loginState, "needs-login"); // .dsh 不存在
});

test("detectLocalAgents：Magpie 托管的 cli-agent 用本体席位，不再重复发网关条目", async () => {
  const deps: DetectDeps = {
    platform: "linux",
    findOnPath: async (bin) =>
      bin === "dsh" ? "/usr/local/bin/dsh" : bin === "magpie" ? "/usr/local/bin/magpie" : null,
    readVersion: async () => "dsh 4.5.6",
    exists: async () => false, // dsh 自身无登录标记
    hasBwrap: async () => true,
    runLines: async (_bin, args) =>
      args[0] === "ls"
        ? [
            "  DeepSeek Harness  magpie/server/group/gpt-6-luna  ·  thinking —  ~/.dsh/profiles/web/cordis.patch.yml",
            "  Qoder             —  ·  effort —                                 ~/.qoder/settings.json",
          ]
        : null,
    readJsonFile: async (rel) => (rel === "magpie/config/gateway.json" ? { addr: "127.0.0.1:3425" } : null),
  };
  const list = await detectLocalAgents(deps, null);
  const dsh = list.find((a) => a.key === "dsh");
  assert.equal(dsh?.kind, "cli-agent");
  assert.equal(dsh?.loginState, "likely-ready"); // Magpie 托管 → 免自身登录态
  // 本体已探测到 → 不再发 magpie:dsh 重复条目
  assert.equal(list.find((a) => a.key === "magpie:dsh"), undefined);
  assert.equal(list.find((a) => a.key === "magpie:deepseek-harness"), undefined);
});
