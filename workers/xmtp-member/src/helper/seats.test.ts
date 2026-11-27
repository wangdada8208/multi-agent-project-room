import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSeatStore,
  createSeatSupervisor,
  seatEnv,
  SEAT_PORT_BASE,
  type SupervisorDeps,
} from "./seats.ts";
import type { EngineConfig } from "../engines/types.ts";
import type { HelperConfig, LocalAgent, SeatRecord } from "./types.ts";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-seats-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function seatRecord(seatId: string, over: Partial<SeatRecord> = {}): SeatRecord {
  return {
    seatId,
    agentKey: "claude-code",
    roomId: "room-1",
    roomName: "一号房",
    agentUsername: "agent-x",
    xmtpWalletKey: "0x" + "11".repeat(32),
    xmtpDbEncryptionKey: "0x" + "22".repeat(32),
    xmtpAddress: "0x" + "a".repeat(40),
    xmtpGroupId: null,
    allowedSenders: ["0x" + "b".repeat(40)],
    agentToken: "agent-token-xyz",
    consolePort: SEAT_PORT_BASE,
    createdAt: "2026-11-17T00:00:00.000Z",
    ...over,
  };
}

test("SeatStore: seat.json 0600 / dirs 0700，往返一致", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const rec = seatRecord("s-1");
    await store.save(rec);
    assert.deepEqual(await store.get("s-1"), rec);
    assert.deepEqual(await store.list(), [rec]);
    assert.equal((await stat(path.join(root, "seats", "s-1", "seat.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, "seats", "s-1"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, "seats"))).mode & 0o777, 0o700);
  });
});

test("SeatStore: 文件或目录权限不对时拒绝读取（S5）", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    await store.save(seatRecord("s-1"));
    const file = path.join(root, "seats", "s-1", "seat.json");
    await chmod(file, 0o644);
    await assert.rejects(() => store.get("s-1"), /permissions too open/);
    await assert.rejects(() => store.list(), /permissions too open/);
    await chmod(file, 0o600);
    await chmod(path.join(root, "seats", "s-1"), 0o755);
    await assert.rejects(() => store.get("s-1"), /permissions too open/);
  });
});

test("SeatStore.nextFreePort 跳过已有席位占用的端口", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    assert.equal(await store.nextFreePort(), SEAT_PORT_BASE);
    await store.save(seatRecord("s-1", { consolePort: SEAT_PORT_BASE }));
    assert.equal(await store.nextFreePort(), SEAT_PORT_BASE + 1);
    await store.save(seatRecord("s-2", { roomId: "room-2", consolePort: SEAT_PORT_BASE + 1 }));
    assert.equal(await store.nextFreePort(), SEAT_PORT_BASE + 2);
  });
});

test("SeatStore.remove 删除整个席位目录", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    await store.save(seatRecord("s-1"));
    await store.remove("s-1");
    assert.equal(await store.get("s-1"), null);
    assert.deepEqual(await store.list(), []);
  });
});

const CLAUDE_AGENT: LocalAgent = {
  key: "claude-code",
  kind: "claude-code",
  displayName: "Claude Code",
  source: "detected",
  binaryPath: "/usr/bin/claude",
  version: "2.1.0",
  loginState: "likely-ready",
};

const PATHS = { dbDir: "/db/seat-1", statePath: "/state/seat-1/loop.json" };

test("seatEnv: HUB_TOKEN 是 agent_token，父进程秘密不下发，只放行白名单键", () => {
  const seat = seatRecord("seat-1", { xmtpGroupId: "grp-1" });
  const engine: EngineConfig = {
    kind: "claude-code",
    binaryPath: "/usr/bin/claude",
    sandboxDir: "/sandbox/seat-1",
    timeoutMs: 120_000,
    model: "sonnet",
    bwrapRoDirs: ["/ro1"],
    bwrapRwDirs: ["/rw1", "/rw2"],
  };
  const env = seatEnv(seat, CLAUDE_AGENT, engine, { hubOrigin: "https://hub.example" }, PATHS, "dev");
  assert.equal(env.HUB_TOKEN, "agent-token-xyz");
  assert.equal(env.HUB_BASE_URL, "https://hub.example");
  assert.equal(env.HUB_ROOM_ID, "room-1");
  assert.equal(env.MAPR_HELPER_SEAT_ID, seat.seatId);
  assert.equal(env.XMTP_WALLET_KEY, seat.xmtpWalletKey);
  assert.equal(env.XMTP_DB_ENCRYPTION_KEY, seat.xmtpDbEncryptionKey);
  assert.equal(env.XMTP_DB_DIRECTORY, "/db/seat-1");
  assert.equal(env.XMTP_LOOP_STATE_PATH, "/state/seat-1/loop.json");
  assert.equal(env.XMTP_ALLOWED_SENDERS, seat.allowedSenders.join(","));
  assert.equal(env.XMTP_ALLOW_GROUP_MEMBERS, "1");
  assert.equal(env.XMTP_MENTION_ONLY, "1");
  assert.equal(env.XMTP_GROUP_ID, "grp-1");
  assert.equal(env.OWNER_NOTES_PORT, String(seat.consolePort));
  assert.equal(env.MEMBER_AGENT_KIND, "claude-code");
  assert.equal(env.MEMBER_AGENT_BIN, "/usr/bin/claude");
  assert.equal(env.MEMBER_AGENT_SANDBOX_DIR, "/sandbox/seat-1");
  assert.equal(env.MEMBER_AGENT_MODEL, "sonnet");
  assert.equal(env.MEMBER_AGENT_BWRAP_RO, "/ro1");
  assert.equal(env.MEMBER_AGENT_BWRAP_RW, ["/rw1", "/rw2"].join(path.delimiter));
  const expected = new Set([
    "PATH", "HOME", "LANG",
    "XMTP_SELF_NAME", "XMTP_ENV", "XMTP_WALLET_KEY", "XMTP_DB_ENCRYPTION_KEY", "XMTP_DB_DIRECTORY",
    "XMTP_LOOP_STATE_PATH", "XMTP_ALLOWED_SENDERS", "XMTP_ALLOW_GROUP_MEMBERS", "XMTP_MENTION_ONLY", "XMTP_GROUP_ID",
    "HUB_BASE_URL", "HUB_ROOM_ID", "HUB_TOKEN", "MAPR_HELPER_SEAT_ID", "OWNER_NOTES_PORT",
    "MEMBER_AGENT_KIND", "MEMBER_AGENT_TIMEOUT_MS", "MEMBER_AGENT_BIN", "MEMBER_AGENT_SANDBOX_DIR",
    "MEMBER_AGENT_MODEL", "MEMBER_AGENT_BWRAP_RO", "MEMBER_AGENT_BWRAP_RW",
  ]);
  for (const key of Object.keys(env)) {
    assert.ok(expected.has(key), `unexpected env key: ${key}`);
  }
  // 父进程里可能存在的秘密绝不下发
  assert.equal(env.MAPR_HELPER_TOKEN, undefined);
  assert.equal(env.MEMBER_MODEL_API_KEY, undefined);
  assert.equal(env.MEMBER_AGENT_API_KEY, undefined);
});

test("seatEnv: openai-compatible 与 webhook 种类各有自己的 MEMBER_AGENT_*", () => {
  const seat = seatRecord("seat-1");
  const helper = { hubOrigin: "https://hub.example" };
  const manualAgent: LocalAgent = {
    key: "manual:abc",
    kind: "openai-compatible",
    displayName: "Grok",
    source: "manual",
    loginState: "unknown",
  };
  const oc = seatEnv(
    seat,
    manualAgent,
    { kind: "openai-compatible", baseUrl: "https://api.x.ai/v1", apiKey: "k", model: "grok-4", timeoutMs: 120_000 },
    helper,
    PATHS,
    "production"
  );
  assert.equal(oc.MEMBER_AGENT_BASE_URL, "https://api.x.ai/v1");
  assert.equal(oc.MEMBER_AGENT_API_KEY, "k");
  assert.equal(oc.MEMBER_AGENT_MODEL, "grok-4");
  assert.equal(oc.XMTP_ENV, "production");
  // 群号为空时不写 XMTP_GROUP_ID
  assert.equal(oc.XMTP_GROUP_ID, undefined);
  const wh = seatEnv(
    seat,
    { ...manualAgent, kind: "webhook" },
    { kind: "webhook", url: "https://bot.example/ask", secret: "s", timeoutMs: 120_000 },
    helper,
    PATHS,
    "dev"
  );
  assert.equal(wh.MEMBER_AGENT_WEBHOOK_URL, "https://bot.example/ask");
  assert.equal(wh.MEMBER_AGENT_WEBHOOK_SECRET, "s");
});

// ── SeatSupervisor（真子进程）──

const FAKE_AGENT: LocalAgent = {
  key: "claude-code",
  kind: "claude-code",
  displayName: "Claude Code",
  source: "detected",
  binaryPath: "/usr/bin/claude",
  loginState: "likely-ready",
};

function fakeDeps(root: string, memberEntry: string, over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
    store: createSeatStore(root),
    helper: () => ({ hubOrigin: "https://hub.example" }) as HelperConfig,
    agents: async () => [FAKE_AGENT],
    engineFor: async (): Promise<EngineConfig> => ({
      kind: "http-model",
      url: "http://127.0.0.1/x",
      apiKey: "k",
      timeoutMs: 1000,
    }),
    memberEntry,
    rootDir: root,
    xmtpEnv: "dev",
    restartDelayMs: () => 10,
    ...over,
  };
}

async function waitFor(cond: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("condition not met in time");
}

test("SeatSupervisor: 成员进程崩溃按退避重启，连续 5 次后放弃", async () => {
  await withTmp(async (root) => {
    // 假成员：每次启动在 XMTP 数据目录写一行（这个环境变量与引擎种类无关，目录由
    // supervisor 在 spawn 前建好），然后立刻退出(1)。
    // .mjs 而不是 .ts：tmpdir 没有 package.json，模块类型不靠猜。
    const member = path.join(root, "crash-member.mjs");
    await writeFile(
      member,
      `import { appendFileSync } from "node:fs";
       appendFileSync(process.env.XMTP_DB_DIRECTORY + "/hits.log", "x\\n");
       process.exit(1);`,
      "utf8"
    );
    const store = createSeatStore(root);
    await store.save(seatRecord("s-1"));
    const sup = createSeatSupervisor(fakeDeps(root, member));
    await sup.start("s-1");
    const hitsLog = path.join(root, "seats", "s-1", "xmtp", "hits.log");
    await waitFor(async () => {
      try {
        return (await readFile(hitsLog, "utf8")).trim().split("\n").length >= 5;
      } catch {
        return false;
      }
    });
    const view = (await sup.views()).find((v) => v.seatId === "s-1");
    assert.equal(view?.status, "crashed");
    assert.match(view?.lastError ?? "", /exit code 1/);
    assert.match(view?.lastError ?? "", /gave up/);
    // 再等一拍，确认没有第 6 次重启
    await new Promise((r) => setTimeout(r, 300));
    const hits = (await readFile(hitsLog, "utf8")).trim().split("\n").length;
    assert.equal(hits, 5);
  });
});

test("SeatSupervisor.stopAll 杀掉全部席位进程", async () => {
  await withTmp(async (root) => {
    const member = path.join(root, "alive-member.mjs");
    await writeFile(
      member,
      `import { writeFileSync } from "node:fs";
       writeFileSync(process.env.XMTP_DB_DIRECTORY + "/pid", String(process.pid));
       setInterval(() => {}, 1000);`,
      "utf8"
    );
    const store = createSeatStore(root);
    await store.save(seatRecord("s-1"));
    await store.save(seatRecord("s-2", { roomId: "room-2", consolePort: SEAT_PORT_BASE + 1 }));
    const sup = createSeatSupervisor(fakeDeps(root, member));
    await sup.start("s-1");
    await sup.start("s-2");
    const pids: number[] = [];
    await waitFor(async () => {
      pids.length = 0;
      for (const id of ["s-1", "s-2"]) {
        try {
          pids.push(Number(await readFile(path.join(root, "seats", id, "xmtp", "pid"), "utf8")));
        } catch {
          // 文件还没写出来
        }
      }
      return pids.length === 2;
    });
    await sup.stopAll();
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    }
    const views = await sup.views();
    assert.deepEqual(views.map((v) => v.status).sort(), ["stopped", "stopped"]);
  });
});
