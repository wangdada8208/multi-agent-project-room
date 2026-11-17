import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DetectDeps } from "./knownAgents.ts";
import { HelperHttpError } from "./server.ts";
import type { HelperConfig, SeatRecord } from "./types.ts";
import { createHelperRuntime, parseUpArgs } from "./up.ts";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-up-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writePairedConfig(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);
  const cfg: HelperConfig = {
    hubOrigin: "https://hub.example",
    helperId: "helper-1",
    helperToken: "mhp_1.secret",
    deviceName: "dev-box",
    ownerUserId: "u-1",
    ownerDisplayName: "Alice",
    manualAgents: [],
  };
  const cfgPath = path.join(rootDir, "helper.json");
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(cfgPath, 0o600);
}

const EMPTY_DETECT: DetectDeps = {
  platform: "linux",
  findOnPath: async () => null,
  readVersion: async () => null,
  exists: async () => false,
  hasBwrap: async () => false,
  hasDarwinSandbox: async () => false,
};

test("parseUpArgs：默认生产 Hub 与 ~/.mapr，默认打开浏览器", () => {
  const o = parseUpArgs({}, {}, "/home/u");
  assert.equal(o.hubOrigin, "https://hub.wangdada8208.xyz");
  assert.equal(o.rootDir, path.join("/home/u", ".mapr"));
  assert.equal(o.openBrowser, true);
  assert.equal(o.pairCode, undefined);
});

test("parseUpArgs：命令行优先于环境变量，hub 末尾斜线去掉", () => {
  const o = parseUpArgs(
    { hub: "http://127.0.0.1:8000/", pair: "mpc_x", dir: "/tmp/m", "no-browser": "true" },
    { MAPR_HUB_ORIGIN: "http://ignored" },
    "/home/u"
  );
  assert.equal(o.hubOrigin, "http://127.0.0.1:8000");
  assert.equal(o.pairCode, "mpc_x");
  assert.equal(o.rootDir, "/tmp/m");
  assert.equal(o.openBrowser, false);
});

test("parseUpArgs：环境变量兜底；--browser=false 也关浏览器", () => {
  const e = parseUpArgs({}, { MAPR_HUB_ORIGIN: "http://hub.dev", MAPR_DIR: "/tmp/m2" }, "/home/u");
  assert.equal(e.hubOrigin, "http://hub.dev");
  assert.equal(e.rootDir, "/tmp/m2");
  const b = parseUpArgs({ browser: "false" }, {}, "/home/u");
  assert.equal(b.openBrowser, false);
});

test("parseUpArgs：拒绝非 http(s) 的 hub 地址", () => {
  assert.throws(() => parseUpArgs({ hub: "ftp://x" }, {}, "/h"), /--hub/);
  assert.throws(() => parseUpArgs({ hub: "not-a-url" }, {}, "/h"), /--hub/);
});

test("addManualAgent：允许 HTTPS 与本机回环 HTTP（Ollama/Muse），拒绝公网明文 HTTP，密钥 0600 分离存储", async () => {
  await withTmp(async (rootDir) => {
    await writePairedConfig(rootDir);
    const rt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: EMPTY_DETECT,
    });
    assert.ok(rt.deps.addManualAgent);

    const ollama = await rt.deps.addManualAgent({
      kind: "openai-compatible",
      displayName: "Ollama Local",
      baseUrl: "http://127.0.0.1:11434/v1/",
      model: "qwen2.5:14b",
      apiKey: "ollama-local-key",
    });
    assert.match(ollama.key, /^manual:/);
    assert.equal(ollama.displayName, "Ollama Local");

    const grok = await rt.deps.addManualAgent({
      kind: "openai-compatible",
      displayName: "Grok",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-3-mini",
      apiKey: "xai-top-secret-key",
    });
    assert.match(grok.key, /^manual:/);

    await assert.rejects(
      () =>
        rt.deps.addManualAgent!({
          kind: "openai-compatible",
          displayName: "Bad Remote HTTP",
          baseUrl: "http://api.example.com/v1",
          model: "m1",
          apiKey: "k1",
        }),
      (err: unknown) => err instanceof HelperHttpError && err.status === 400
    );

    await assert.rejects(
      () =>
        rt.deps.addManualAgent!({
          kind: "openai-compatible",
          displayName: "SSRF Userinfo",
          baseUrl: "http://127.0.0.1:80@evil.com/v1",
          model: "m1",
          apiKey: "k1",
        }),
      (err: unknown) => err instanceof HelperHttpError && err.status === 400
    );

    const cfgRaw = await readFile(path.join(rootDir, "helper.json"), "utf8");
    assert.ok(!cfgRaw.includes("xai-top-secret-key"), "helper.json must never store apiKey");

    const secretPath = path.join(rootDir, "agents", `${grok.key.replace(/[^A-Za-z0-9-]/g, "-")}.secret`);
    const st = await stat(secretPath);
    assert.equal(st.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(secretPath, "utf8")), { apiKey: "xai-top-secret-key" });
  });
});

test("removeManualAgent：有活跃席位时返回 409，清空席位后删除元数据与 .secret 文件", async () => {
  await withTmp(async (rootDir) => {
    await writePairedConfig(rootDir);
    const rt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: EMPTY_DETECT,
    });
    const added = await rt.deps.addManualAgent!({
      kind: "webhook",
      displayName: "Grokbot Bridge",
      url: "http://127.0.0.1:9001/grokbot",
      secret: "bridge-hmac-secret",
    });
    const secretPath = path.join(rootDir, "agents", `${added.key.replace(/[^A-Za-z0-9-]/g, "-")}.secret`);

    await assert.rejects(
      () => rt.deps.removeManualAgent!("claude-code"),
      (err: unknown) => err instanceof HelperHttpError && err.status === 400 && err.message === "invalid_agent_key"
    );

    const seat: SeatRecord = {
      seatId: "seat-1",
      agentKey: added.key,
      roomId: "room-1",
      roomName: "Room 1",
      agentUsername: "bot-1",
      xmtpWalletKey: "0x" + "11".repeat(32),
      xmtpDbEncryptionKey: "0x" + "22".repeat(32),
      xmtpAddress: "0x" + "a".repeat(40),
      xmtpGroupId: null,
      allowedSenders: [],
      agentToken: "tok",
      consolePort: 8791,
      createdAt: "2026-11-18T00:00:00.000Z",
    };
    await rt.store.save(seat);

    await assert.rejects(
      () => rt.deps.removeManualAgent!(added.key),
      (err: unknown) => err instanceof HelperHttpError && err.status === 409 && err.message === "agent_has_active_seats"
    );
    assert.ok((await stat(secretPath)).isFile(), ".secret must remain when removal is blocked by active seat");

    await rt.store.remove("seat-1");
    await rt.deps.removeManualAgent!(added.key);
    await assert.rejects(() => stat(secretPath));
    assert.equal((await rt.deps.agents()).some((a) => a.key === added.key), false);

    await assert.rejects(
      () => rt.deps.removeManualAgent!(added.key),
      (err: unknown) => err instanceof HelperHttpError && err.status === 404 && err.message === "agent_not_found"
    );
  });
});

test("testAgent：探测本机 CLI 登录态、验证手动 Agent 连通性并在异常时脱敏密钥", async () => {
  await withTmp(async (rootDir) => {
    await writePairedConfig(rootDir);

    const detectWithCli: DetectDeps = {
      platform: "darwin",
      findOnPath: async (bin) => {
        if (bin === "claude") return "/opt/homebrew/bin/claude";
        if (bin === "gemini") return "/opt/homebrew/bin/gemini";
        if (bin === "codex") return "/opt/homebrew/bin/codex";
        return null;
      },
      readVersion: async () => "1.2.3",
      exists: async (p: string) => p.includes(".claude") || p.includes(".codex"),
      hasDarwinSandbox: async () => false,
    };

    let failFetchWithSecret = false;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (failFetchWithSecret) {
        throw new Error(`connect refused with Authorization: ${String((init?.headers as any)?.Authorization)} and sk-super-secret-token`);
      }
      if (url.endsWith("/chat/completions")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      const rawBody = String(init?.body ?? "");
      const sig = String((init?.headers as Record<string, string>)?.["X-MAPR-Signature"] ?? "");
      const expected = createHmac("sha256", "wh-secret-999").update(rawBody).digest("hex");
      assert.equal(sig, expected);
      return new Response(JSON.stringify({ text: "OK from bridge" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const rt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: detectWithCli,
      platform: "darwin",
      fetchImpl: fakeFetch,
      checkExecutable: async () => true,
    });

    const claudeRes = await rt.deps.testAgent!("claude-code");
    assert.equal(claudeRes.ok, true);
    assert.match(claudeRes.detail, /1\.2\.3/);

    const geminiRes = await rt.deps.testAgent!("gemini-cli");
    assert.equal(geminiRes.ok, false);
    assert.match(geminiRes.detail, /登录/);

    const codexRes = await rt.deps.testAgent!("codex");
    assert.equal(codexRes.ok, false);
    assert.match(codexRes.detail, /sandbox-exec/);

    const oai = await rt.deps.addManualAgent!({
      kind: "openai-compatible",
      displayName: "Local Gateway",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "muse-default",
      apiKey: "sk-super-secret-token",
    });
    const oaiOk = await rt.deps.testAgent!(oai.key);
    assert.equal(oaiOk.ok, true);
    assert.match(oaiOk.detail, /OK/);

    failFetchWithSecret = true;
    const oaiFail = await rt.deps.testAgent!(oai.key);
    assert.equal(oaiFail.ok, false);
    assert.ok(!oaiFail.detail.includes("sk-super-secret-token"), `secret leaked in error detail: ${oaiFail.detail}`);
    failFetchWithSecret = false;

    const wh = await rt.deps.addManualAgent!({
      kind: "webhook",
      displayName: "Muse Bridge",
      url: "http://127.0.0.1:9002/muse",
      secret: "wh-secret-999",
    });
    const whOk = await rt.deps.testAgent!(wh.key);
    assert.equal(whOk.ok, true);
    assert.match(whOk.detail, /OK from bridge/);

    await assert.rejects(
      () => rt.deps.testAgent!("manual:nonexistent"),
      (err: unknown) => err instanceof HelperHttpError && err.status === 404
    );
  });
});

test("re-pairing & config validation：helperToken 为空（已吊销）时 addManualAgent 返回 409 not_paired，且传 pairCode 可重新配对并保留手动 Agent", async () => {
  await withTmp(async (rootDir) => {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await chmod(rootDir, 0o700);
    const revokedCfg: HelperConfig = {
      hubOrigin: "https://hub.example",
      helperId: "",
      helperToken: "",
      deviceName: "dev-box",
      ownerUserId: "u-1",
      ownerDisplayName: "Alice",
      manualAgents: [
        {
          key: "manual:existing-1",
          kind: "openai-compatible",
          displayName: "Saved Grok",
          baseUrl: "https://api.x.ai/v1",
          model: "grok-3-mini",
        },
      ],
    };
    const cfgPath = path.join(rootDir, "helper.json");
    await writeFile(cfgPath, JSON.stringify(revokedCfg, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(cfgPath, 0o600);

    const unpairedRt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: EMPTY_DETECT,
    });

    await assert.rejects(
      () =>
        unpairedRt.deps.addManualAgent!({
          kind: "openai-compatible",
          displayName: "Blocked",
          baseUrl: "https://api.x.ai/v1",
          model: "grok-3-mini",
          apiKey: "sk-123",
        }),
      (err: unknown) => err instanceof HelperHttpError && err.status === 409 && err.message === "not_paired"
    );

    await assert.rejects(
      () => unpairedRt.deps.removeManualAgent!("manual:existing-1"),
      (err: unknown) => err instanceof HelperHttpError && err.status === 409 && err.message === "not_paired"
    );

    let pairCalls = 0;
    const repairedRt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      pairCode: "mpc_repair.code123",
      rootDir,
      detectDeps: EMPTY_DETECT,
      hubClientFactory: () => ({
        async pair(code) {
          pairCalls++;
          assert.equal(code, "mpc_repair.code123");
          return {
            helper_id: "helper-repaired",
            helper_token: "mhp_repaired.newsecret",
            owner_user_id: "u-2",
            owner_display_name: "Bob",
          };
        },
        async listRooms() { return []; },
        async createSeat() { throw new Error("unexpected"); },
        async getSeat() { throw new Error("unexpected"); },
        async refreshAgentToken() { throw new Error("unexpected"); },
        async deleteSeat() {},
        async heartbeat() { return { revoked: false, seats_to_stop: [] }; },
      }),
    });

    assert.equal(pairCalls, 1);
    assert.equal(repairedRt.deps.config()?.helperToken, "mhp_repaired.newsecret");
    assert.equal(repairedRt.deps.config()?.ownerDisplayName, "Bob");
    assert.equal(repairedRt.deps.config()?.manualAgents.length, 1);
    assert.equal(repairedRt.deps.config()?.manualAgents[0].key, "manual:existing-1");

    // Malformed non-http hubOrigin in helper.json must be rejected
    const badCfgPath = path.join(rootDir, "helper.json");
    await writeFile(
      badCfgPath,
      JSON.stringify({ ...revokedCfg, hubOrigin: "javascript:alert(1)" }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
    await chmod(badCfgPath, 0o600);
    await assert.rejects(
      () => createHelperRuntime({ hubOrigin: "https://hub.example", rootDir, detectDeps: EMPTY_DETECT }),
      /malformed/
    );
  });
});
