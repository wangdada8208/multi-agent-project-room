import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DetectDeps } from "./knownAgents.ts";
import { checkpointFromVerification, signLedgerCheckpoint, type SignedLedgerCheckpoint } from "../activity.ts";
import type { HubSafeActivityEvent } from "../hubContracts.generated.ts";
import { appendLedger, buildLedgerEntry, verifyLedger } from "../ledger.ts";
import { writeJsonSecure } from "../secureFile.ts";
import { createSeatStore, type SeatStore, type SeatSupervisor } from "./seats.ts";
import { HelperHttpError } from "./server.ts";
import type { HelperConfig, SeatRecord } from "./types.ts";
import { createHubClient, type HubClient } from "./hubClient.ts";
import { createHelperRuntime, parseUpArgs, restoreSeats } from "./up.ts";

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
        async reportActivity() { return { accepted: 0, duplicates: 0 }; },
        async reportCheckpoints() { return { accepted: 0, duplicates: 0 }; },
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

// ── WP5：心跳暂停/恢复对账 + WP9 房间元数据同步 ──

function seatFixture(seatId: string, over: Partial<SeatRecord> = {}): SeatRecord {
  return {
    seatId,
    agentKey: "claude-code",
    roomId: "room-1",
    roomName: "一号房",
    agentUsername: "agent-1",
    xmtpWalletKey: "0x" + "11".repeat(32),
    xmtpDbEncryptionKey: "0x" + "22".repeat(32),
    xmtpAddress: "0x" + "a".repeat(40),
    xmtpGroupId: null,
    allowedSenders: [],
    agentToken: "tok-1",
    consolePort: 8791,
    createdAt: "2026-11-20T00:00:00.000Z",
    ...over,
  };
}

function fakeSup(store: SeatStore): { calls: { starts: string[]; stops: string[] }; supervisor: SeatSupervisor } {
  const calls = { starts: [] as string[], stops: [] as string[] };
  const started = new Set<string>();
  const supervisor: SeatSupervisor = {
    async start(id) {
      calls.starts.push(id);
      started.add(id);
    },
    async stop(id) {
      calls.stops.push(id);
      started.delete(id);
    },
    async stopAll() {
      started.clear();
    },
    async views() {
      return (await store.list()).map((r) => ({
        seatId: r.seatId,
        agentKey: r.agentKey,
        roomId: r.roomId,
        roomName: r.roomName,
        xmtpAddress: r.xmtpAddress,
        consolePort: r.consolePort,
        status: started.has(r.seatId) ? ("running" as const) : ("stopped" as const),
        lastError: null,
        pausedAt: r.pausedAt ?? null,
      }));
    },
  };
  return { calls, supervisor };
}

function fakeHubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    async pair() {
      throw new Error("pair not expected");
    },
    async listRooms() {
      return [];
    },
    async createSeat() {
      throw new Error("unexpected");
    },
    async getSeat() {
      return { xmtp_group_id: null, group_status: "pending" as const };
    },
    async refreshAgentToken() {
      return { agent_token: "new" };
    },
    async deleteSeat() {},
    async heartbeat() {
      return { revoked: false, seats_to_stop: [] };
    },
    async reportActivity() {
      return { accepted: 0, duplicates: 0 };
    },
    async reportCheckpoints() {
      return { accepted: 0, duplicates: 0 };
    },
    ...overrides,
  };
}

test("heartbeat：seats_to_pause 只停进程不删数据；Hub 端恢复后自动重启", async () => {
  await withTmp(async (rootDir) => {
    await writePairedConfig(rootDir);
    const store = createSeatStore(rootDir);
    await store.save(seatFixture("seat-1"));
    const ledgerFile = path.join(rootDir, "seats", "seat-1", "state", "ledger.jsonl");
    await appendLedger(ledgerFile, buildLedgerEntry({ now: new Date("2026-11-20T00:00:00Z"), kind: "action_queued" }));
    const sup = fakeSup(store);
    let pauseList: string[] = ["seat-1"];
    const rt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: EMPTY_DETECT,
      supervisor: sup.supervisor,
      hubClientFactory: () =>
        fakeHubClient({
          heartbeat: async () => ({ revoked: false, seats_to_stop: [], seats_to_pause: pauseList }),
        }),
    });

    await rt.heartbeat();
    const rec = await rt.store.get("seat-1");
    assert.ok(rec, "暂停绝不能删除席位数据");
    assert.ok(rec.pausedAt);
    assert.equal(rec.pausedSource, "hub");
    assert.deepEqual(sup.calls.stops, ["seat-1"]);
    assert.deepEqual(sup.calls.starts, []);
    assert.ok((await stat(path.join(rootDir, "seats", "seat-1", "seat.json"))).isFile());
    assert.ok((await stat(ledgerFile)).isFile());

    // Hub 端恢复（不再出现在列表里）→ 清标记并重新拉起。
    pauseList = [];
    await rt.heartbeat();
    const rec2 = await rt.store.get("seat-1");
    assert.equal(rec2?.pausedAt, null);
    assert.equal(rec2?.pausedSource, null);
    assert.deepEqual(sup.calls.starts, ["seat-1"]);
  });
});

test("heartbeat：seats_to_stop 仍是物理删除，与 pause 语义严格分离", async () => {
  await withTmp(async (rootDir) => {
    await writePairedConfig(rootDir);
    const store = createSeatStore(rootDir);
    await store.save(seatFixture("seat-1"));
    const ledgerFile = path.join(rootDir, "seats", "seat-1", "state", "ledger.jsonl");
    await appendLedger(ledgerFile, buildLedgerEntry({ now: new Date("2026-11-20T00:00:00Z"), kind: "action_queued" }));
    assert.ok((await stat(ledgerFile)).isFile());
    const sup = fakeSup(store);
    const rt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: EMPTY_DETECT,
      supervisor: sup.supervisor,
      hubClientFactory: () =>
        fakeHubClient({
          heartbeat: async () => ({ revoked: false, seats_to_stop: ["seat-1"], seats_to_pause: ["seat-1"] }),
        }),
    });
    await rt.heartbeat();
    assert.equal(await rt.store.get("seat-1"), null);
    await assert.rejects(() => stat(path.join(rootDir, "seats", "seat-1")));
    await assert.rejects(() => stat(ledgerFile), { code: "ENOENT" });
  });
});

test("heartbeat retries a disconnect and clears only paired data on a confirmed invalidation", async () => {
  await withTmp(async (rootDir) => {
    await writePairedConfig(rootDir);
    await writeFile(path.join(rootDir, "unrelated"), "keep");
    const store = createSeatStore(rootDir);
    await store.save(seatFixture("seat-1"));
    const sup = fakeSup(store);
    let calls = 0;
    const runtime = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: EMPTY_DETECT,
      supervisor: sup.supervisor,
      hubClientFactory: (origin, token) => createHubClient(origin, token, async () => {
        calls++;
        if (calls === 1) throw new Error("disconnected");
        return Response.json({ detail: "Helper token invalid" }, { status: 401 });
      }),
    });
    await runtime.heartbeat();
    assert.ok((await store.get("seat-1"))?.agentToken);
    assert.ok(runtime.deps.config()?.helperToken);
    await Promise.all([runtime.heartbeat(), runtime.heartbeat()]);
    assert.equal(await store.get("seat-1"), null);
    assert.equal(runtime.deps.config()?.helperToken, "");
    assert.equal(await readFile(path.join(rootDir, "unrelated"), "utf8"), "keep");
    await runtime.heartbeat();
    assert.equal(calls, 2);
  });
});

test("heartbeat：本机手动暂停（pausedSource=local）不被 Hub 对账解除", async () => {
  await withTmp(async (rootDir) => {
    await writePairedConfig(rootDir);
    const store = createSeatStore(rootDir);
    await store.save(
      seatFixture("seat-1", { pausedAt: "2026-11-20T01:00:00.000Z", pausedSource: "local" })
    );
    const sup = fakeSup(store);
    const rt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: EMPTY_DETECT,
      supervisor: sup.supervisor,
      hubClientFactory: () =>
        fakeHubClient({
          heartbeat: async () => ({ revoked: false, seats_to_stop: [], seats_to_pause: [] }),
        }),
    });
    await rt.heartbeat();
    const rec = await rt.store.get("seat-1");
    assert.ok(rec?.pausedAt, "local 暂停只有本机 resume 能解除");
    assert.equal(rec?.pausedSource, "local");
    assert.deepEqual(sup.calls.starts, []);
  });
});

test("heartbeat：rooms 元数据按 settings_version 写进席位 state 目录（0600 原子）", async () => {
  await withTmp(async (rootDir) => {
    await writePairedConfig(rootDir);
    const store = createSeatStore(rootDir);
    await store.save(seatFixture("seat-1", { roomId: "room-1" }));
    await store.save(seatFixture("seat-2", { roomId: "room-2" }));
    const sup = fakeSup(store);
    let rooms: { id: string; settings_version: number; settings_json: Record<string, unknown> | null }[] = [];
    const rt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: EMPTY_DETECT,
      supervisor: sup.supervisor,
      hubClientFactory: () =>
        fakeHubClient({
          heartbeat: async () => ({ revoked: false, seats_to_stop: [], rooms }),
        }),
    });

    const file1 = path.join(rootDir, "seats", "seat-1", "state", "hub-room-settings.json");
    rooms = [{ id: "room-1", settings_version: 2, settings_json: { house_rules: { scopes: { "gmail.send": "cannot" } } } }];
    await rt.heartbeat();
    const written = JSON.parse(await readFile(file1, "utf8"));
    assert.equal(written.settings_version, 2);
    assert.deepEqual(written.settings_json, { house_rules: { scopes: { "gmail.send": "cannot" } } });
    assert.equal((await stat(file1)).mode & 0o777, 0o600);
    // 其他房间的席位不写这份元数据
    await assert.rejects(() => stat(path.join(rootDir, "seats", "seat-2", "state", "hub-room-settings.json")));

    // 同版本不覆盖（本机改过的内容原样保留）
    await writeFile(file1, JSON.stringify({ settings_version: 2, settings_json: { sentinel: true } }), { encoding: "utf8" });
    await rt.heartbeat();
    assert.deepEqual(JSON.parse(await readFile(file1, "utf8")).settings_json, { sentinel: true });

    // 版本回退也不覆盖
    rooms = [{ id: "room-1", settings_version: 1, settings_json: { house_rules: { scopes: {} } } }];
    await rt.heartbeat();
    assert.deepEqual(JSON.parse(await readFile(file1, "utf8")).settings_json, { sentinel: true });

    // 版本前进才重写
    rooms = [{ id: "room-1", settings_version: 3, settings_json: { template_key: "planning" } }];
    await rt.heartbeat();
    const v3 = JSON.parse(await readFile(file1, "utf8"));
    assert.equal(v3.settings_version, 3);
    assert.deepEqual(v3.settings_json, { template_key: "planning" });
  });
});

test("restoreSeats：pausedAt 非空的席位不自动拉起", async () => {
  await withTmp(async (rootDir) => {
    const store = createSeatStore(rootDir);
    await store.save(seatFixture("seat-paused", { pausedAt: "2026-11-20T02:00:00.000Z", pausedSource: "hub" }));
    await store.save(seatFixture("seat-active"));
    const sup = fakeSup(store);
    await restoreSeats(store, sup.supervisor, () => {});
    assert.deepEqual(sup.calls.starts, ["seat-active"]);
  });
});

test("heartbeat：增量上报安全元数据事件与签名检查点，跳过重复且容忍 Hub 失败", async () => {
  await withTmp(async (rootDir) => {
    await writePairedConfig(rootDir);
    const store = createSeatStore(rootDir);
    const seat = seatFixture("seat-1", { roomId: "room-1" });
    await store.save(seat);
    const stateDir = path.join(rootDir, "seats", "seat-1", "state");
    const ledgerFile = path.join(stateDir, "ledger.jsonl");
    const cpFile = path.join(stateDir, "ledger-checkpoint.json");

    await appendLedger(
      ledgerFile,
      buildLedgerEntry({
        now: new Date("2026-11-20T10:00:00.000Z"),
        kind: "action_queued",
        requestId: "req-1",
        peer: seat.xmtpAddress,
        scope: "gmail.send",
      })
    );
    const v1 = await verifyLedger(ledgerFile);
    const cp1 = await signLedgerCheckpoint(
      checkpointFromVerification(v1, { room_id: "room-1", stream_id: seat.xmtpAddress }),
      seat.xmtpWalletKey
    );
    await writeJsonSecure(cpFile, cp1);

    const uploadedEvents: HubSafeActivityEvent[][] = [];
    const uploadedCps: SignedLedgerCheckpoint[][] = [];
    let failUpload = true;
    const sup = fakeSup(store);
    const rt = await createHelperRuntime({
      hubOrigin: "https://hub.example",
      rootDir,
      detectDeps: EMPTY_DETECT,
      supervisor: sup.supervisor,
      hubClientFactory: () =>
        fakeHubClient({
          reportActivity: async (events) => {
            if (failUpload) throw new Error("hub 503");
            uploadedEvents.push(events);
            return { accepted: events.length, duplicates: 0 };
          },
          reportCheckpoints: async (cps) => {
            if (failUpload) throw new Error("hub 503");
            uploadedCps.push(cps);
            return { accepted: cps.length, duplicates: 0 };
          },
        }),
    });

    // 失败不崩 heartbeat，且游标不推进。
    await rt.heartbeat();
    assert.equal(uploadedEvents.length, 0);
    assert.equal(uploadedCps.length, 0);

    // 恢复后补传全部增量且绝不带禁传字段。
    failUpload = false;
    await rt.heartbeat();
    assert.equal(uploadedCps.length, 1);
    assert.equal(uploadedCps[0][0].head_seq, 1);
    assert.equal(uploadedEvents.length, 1);
    assert.equal(uploadedEvents[0][0].stream_seq, 1);
    for (const forbidden of ["payload", "content", "params", "params_hash", "digest"]) {
      assert.equal(forbidden in uploadedEvents[0][0], false);
    }

    // 无新条目时不重复上报。
    await rt.heartbeat();
    assert.equal(uploadedCps.length, 1);
    assert.equal(uploadedEvents.length, 1);

    // 追加第 2 条后仅增量上报 seq=2。
    await appendLedger(
      ledgerFile,
      buildLedgerEntry({
        now: new Date("2026-11-20T10:01:00.000Z"),
        kind: "action_finished",
        requestId: "req-1",
        peer: seat.xmtpAddress,
        scope: "gmail.send",
      })
    );
    await rt.heartbeat();
    assert.equal(uploadedEvents.length, 2);
    assert.equal(uploadedEvents[1].length, 1);
    assert.equal(uploadedEvents[1][0].stream_seq, 2);
  });
});
