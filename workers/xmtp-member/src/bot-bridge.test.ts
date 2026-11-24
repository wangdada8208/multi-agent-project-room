import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { verifyMessage, type Hex } from "viem";
import { formatInboundLine, parseBridgeArgs, runBridge } from "./bot-bridge.ts";

test("parseBridgeArgs 兼容邀请链接和裸令牌，默认使用 dev", () => {
  const full = parseBridgeArgs(["--invite", "https://hub.example/rooms/r1?invite=token%2Bvalue"], {
    MAPR_HUB_ORIGIN: "https://ignored.example",
  });
  assert.equal(full.invite, "token+value");
  assert.equal(full.hub, "https://hub.example");
  assert.equal(full.inviteRoom, "r1");
  assert.equal(full.env, "dev");
  assert.equal(full.waitSec, 600);

  const token = parseBridgeArgs(["--invite", "token", "--wait", "0"], { XMTP_ENV: "production" });
  assert.equal(token.invite, "token");
  assert.equal(token.hub, "https://hub.wangdada8208.xyz");
  assert.equal(token.env, "production");
  assert.equal(token.waitSec, 0);

  const overrides = parseBridgeArgs([
    "--invite", "https://ignored.example/rooms/r1?invite=token", "--hub", "https://hub.example/",
    "--env", "local", "--name", "Grokbot", "--exec", "cat",
  ], { XMTP_ENV: "production" });
  assert.equal(overrides.hub, "https://hub.example");
  assert.equal(overrides.env, "local");
  assert.equal(overrides.name, "Grokbot");
  assert.equal(overrides.exec, "cat");
  assert.equal(parseBridgeArgs(["--group", "g1"], { XMTP_ENV: "invalid" }).env, "dev");
});

test("parseBridgeArgs 仅接受 HTTPS 或本机回环 HTTP 唤醒地址", () => {
  for (const url of ["https://wake.example/run", "http://localhost:5432/", "http://127.0.0.1/", "http://[::1]/"]) {
    assert.equal(parseBridgeArgs(["--group", "g1", "--wake-url", url], {}).wakeUrl, url);
  }
  for (const url of ["http://wake.example/", "http://localhost.example/", "file:///tmp/run", "https://user:password@wake.example/"]) {
    assert.throws(() => parseBridgeArgs(["--group", "g1", "--wake-url", url], {}), /HTTPS 或本机回环 HTTP/);
  }
  assert.throws(() => parseBridgeArgs(["--group", "g1", "--wake-key", "secret"], {}), /未知参数/);
  assert.throws(() => parseBridgeArgs(["--group", "g1", "--wake-key-env", "WAKE_KEY"], {}), /需要 --wake-url/);
});

test("formatInboundLine 生成可解析的 jsonl", () => {
  const line = formatInboundLine("0xabc", "你好", "2026-11-19T00:00:00Z");
  assert.deepEqual(JSON.parse(line), { ts: "2026-11-19T00:00:00Z", sender: "0xabc", text: "你好" });
});

type BridgeDeps = NonNullable<Parameters<typeof runBridge>[2]>;
type BridgeAgent = Awaited<ReturnType<NonNullable<BridgeDeps["createAgent"]>>>;
type IncomingText = Parameters<BridgeAgent["onText"]>[0];

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "等候的桥接行为未发生");
    await sleep(10);
  }
}

async function fixture(t: TestContext) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "mapr-bridge-test-"));
  const log: string[] = [];
  const sent: string[] = [];
  const synced: string[] = [];
  const input = new PassThrough();
  let handler: IncomingText | undefined;
  let stops = 0;
  let run: Promise<void> | undefined;
  t.after(async () => {
    if (run && process.listenerCount("SIGTERM")) process.emit("SIGTERM");
    await run?.catch(() => {});
    input.destroy();
    await rm(stateDir, { recursive: true, force: true });
  });
  const createAgent = async (): Promise<BridgeAgent> => ({
    start: async () => {},
    stop: async () => { stops++; },
    syncGroup: async (group) => { synced.push(group); return true; },
    onText: (listen) => { handler = listen; },
    sendText: async (_group, text) => { sent.push(text); },
  });
  return {
    stateDir, log, sent, synced, input, stops: () => stops,
    emit: async (text: string, groupId = "group-1", sender = "0x1111111111111111111111111111111111111111") => {
      assert.ok(handler);
      await handler({
        conversation: { id: groupId }, getSenderAddress: async () => sender, message: { content: text },
      });
    },
    launch: (args: string[], deps: BridgeDeps = {}) => {
      const options = parseBridgeArgs(["--state-dir", stateDir, "--poll-ms", "50", ...args], {});
      run = runBridge(options, { stdout: (line) => log.push(line), stderr: (line) => log.push(line) }, {
        ...deps, createAgent: deps.createAgent ?? createAgent, input,
      });
      void run.catch(() => {});
      return run;
    },
  };
}

test("签名入席、等待审批和群绑定、席位续约及暂停/恢复/移除", async (t) => {
  const f = await fixture(t);
  const seatFile = path.join(f.stateDir, "seat.json");
  const inboundFile = path.join(f.stateDir, "mailbox", "inbound.jsonl");
  const outboxDir = path.join(f.stateDir, "mailbox", "outbox");
  const proofInputs: { nonce: string; address: Hex; signature: Hex }[] = [];
  const messages = new Map<string, string>();
  const pollQueries: string[] = [];
  const roomAuth: (string | null)[] = [];
  const wakes: { headers: Headers; body: Record<string, unknown>; redirect?: RequestRedirect }[] = [];
  const keyName = "MAPR_BRIDGE_TEST_WAKE_KEY";
  const key = randomUUID();
  process.env[keyName] = key;
  t.after(() => { delete process.env[keyName]; });

  let createdName: string | undefined;
  let seatState = "active";
  let roomGroup: string | null = null;
  let regPolls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const route = url.pathname;
    if (route.endsWith("/invites/nonce")) {
      const body = JSON.parse(String(init?.body));
      const nonce = `nonce-${messages.size + 1}`;
      const message = `${body.action}:${body.resource}:${body.address}:${nonce}`;
      messages.set(nonce, message);
      return Response.json({ nonce, message });
    }
    if (route.endsWith("/invite-token/agent-register")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        createdName = body.display_name;
        proofInputs.push({ nonce: body.nonce, address: body.xmtp_address, signature: body.signature });
        return Response.json({ status: "pending" });
      }
      pollQueries.push(url.search);
      proofInputs.push({
        nonce: headers.get("X-MAPR-Nonce") as string,
        address: headers.get("X-MAPR-Address") as Hex,
        signature: headers.get("X-MAPR-Signature") as Hex,
      });
      if (++regPolls === 1) return Response.json({ status: "pending" });
      return Response.json({
        status: "approved", seat_id: "s1", room_id: "r1", agent_user_id: "agent-1",
        agent_token: "mock-original-token", xmtp_group_id: null,
      });
    }
    if (route.endsWith("/agent-seats/s1/token")) return Response.json({ agent_token: "mock-renewed-token" });
    if (route.endsWith("/agent-seats/s1")) {
      if (seatState === "unknown") return Response.json({}, { status: 503 });
      if (seatState === "removed") return Response.json({}, { status: 403 });
      return Response.json({ seat_id: "s1", group_status: "added", paused_at: seatState === "paused" ? "paused" : null });
    }
    if (route.endsWith("/rooms/r1")) {
      roomAuth.push(headers.get("Authorization"));
      return Response.json({ room: { xmtp_group_id: roomGroup } });
    }
    if (url.origin === "http://127.0.0.1:6789") {
      wakes.push({ headers, body: JSON.parse(String(init?.body)), redirect: init?.redirect });
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 418 });
  };
  const run = f.launch([
    "--invite", "https://hub.example/rooms/r1?invite=invite-token", "--name", "Grokbot", "--wait", "0",
    "--wake-url", "http://127.0.0.1:6789/run", "--wake-key-env", keyName,
    "--exec", `test -z "\${${keyName}:-}" && cat`,
  ], { fetchImpl, seatPollMs: 25 });

  await until(() => roomAuth.length > 0);
  assert.deepEqual(f.synced, []);
  assert.equal(createdName, "Grokbot");
  assert.deepEqual(pollQueries, ["", ""]);
  assert.equal(proofInputs.length, 3);
  assert.equal(new Set(proofInputs.map((item) => item.nonce)).size, 3);
  for (const proof of proofInputs) {
    assert.ok(await verifyMessage({ ...proof, message: messages.get(proof.nonce) ?? "" }));
    assert.match(messages.get(proof.nonce) ?? "", /^invite-agent-register:invite-token:0x[0-9a-f]{40}:nonce-/);
  }
  assert.equal(roomAuth[0], "Bearer mock-renewed-token");
  await until(async () => JSON.parse(await readFile(seatFile, "utf8")).agent_token === "mock-renewed-token");
  assert.equal((await stat(seatFile)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(seatFile, "utf8")), {
    hub_origin: "https://hub.example", room_id: "r1", seat_id: "s1", agent_user_id: "agent-1",
    agent_token: "mock-renewed-token", xmtp_address: proofInputs[0].address,
  });

  roomGroup = "group-1";
  await until(() => f.log.some((line) => line.includes("开始收发")));
  assert.deepEqual(f.synced, ["group-1"]);
  await f.emit("wrong group", "other-group");
  await f.emit("own text", "group-1", proofInputs[0].address);
  await f.emit(" ");
  await f.emit("active inbound");
  assert.deepEqual(f.sent, ["active inbound"]);
  assert.equal(wakes.length, 1);
  const event = JSON.parse((await readFile(inboundFile, "utf8")).trim());
  assert.deepEqual(wakes[0].body, {
    event: "mapr.message", name: "Grokbot", room_group_id: "group-1",
    inbound_file: inboundFile, outbox_dir: outboxDir, ...event,
  });
  assert.equal(wakes[0].headers.get("Authorization"), `Bearer ${key}`);
  assert.equal(wakes[0].headers.get("X-Automation-Key"), key);
  assert.equal(wakes[0].headers.get("Content-Type"), "application/json");
  assert.equal(wakes[0].redirect, "error");

  seatState = "paused";
  await until(() => f.log.some((line) => line.includes("已暂停")));
  await f.emit("paused inbound");
  f.input.write("paused stdin\n");
  await writeFile(path.join(outboxDir, "reply.txt"), "queued outbound");
  seatState = "unknown";
  await sleep(100);
  await f.emit("unknown while paused");
  assert.deepEqual(f.sent, ["active inbound"]);
  assert.deepEqual(await readdir(outboxDir), ["reply.txt"]);
  assert.equal(wakes.length, 1);
  assert.equal((await readFile(inboundFile, "utf8")).trim().split("\n").length, 1);

  seatState = "active";
  await until(() => f.log.some((line) => line.includes("已恢复")));
  await f.emit("resumed inbound");
  await until(() => f.sent.includes("queued outbound"));
  assert.ok(f.sent.includes("resumed inbound"));
  assert.equal(wakes.length, 2);
  seatState = "removed";
  await run;
  assert.equal(f.stops(), 1);
  assert.equal(f.input.isPaused(), true);
  assert.ok(f.log.some((line) => line.includes("退群自停")));
  assert.doesNotMatch(f.log.join("\n"), /mock-(original|renewed)-token|0x[0-9a-f]{64,}/);
  assert.ok(!f.log.join("\n").includes(key));

  // 重启读取已落盘席位，不签发新 nonce，也不再次核销邀请。
  const before = proofInputs.length;
  await f.launch(["--invite", "https://hub.example/rooms/r1?invite=old-token"], { fetchImpl });
  assert.equal(proofInputs.length, before);
  assert.equal(f.stops(), 1);
});

test("群尚未绑定时，移除席位会阻止连接 XMTP", async (t) => {
  const f = await fixture(t);
  let roomReads = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const route = new URL(String(input)).pathname;
    if (route.endsWith("/nonce")) return Response.json({ nonce: "nonce", message: "test registration" });
    if (route.endsWith("/agent-register")) {
      return Response.json({ status: "consumed", room_id: "r1", seat_id: "s1", agent_token: "mock-token" });
    }
    if (route.endsWith("/rooms/r1")) {
      roomReads++;
      return Response.json({ room: { xmtp_group_id: null } });
    }
    if (roomReads) return new Response(null, { status: 404 });
    return Response.json({ seat_id: "s1", group_status: "pending" });
  };
  await f.launch(["--invite", "token"], { fetchImpl });
  assert.equal(roomReads, 1);
  assert.deepEqual(f.synced, []);
  assert.ok(f.log.some((line) => line.includes("退群自停")));
});

test("唤醒超时只请求一次，后续消息仍可接收", async (t) => {
  const f = await fixture(t);
  const warningSecret = randomUUID();
  let calls = 0;
  const fetchImpl: typeof fetch = (_input, init) => {
    if (++calls > 1) return Promise.resolve(new Response(null, { status: 204 }));
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(warningSecret)), { once: true });
    });
  };
  const run = f.launch(["--group", "group-1", "--wake-url", "https://wake.example/run"], {
    fetchImpl, wakeTimeoutMs: 25,
  });
  await until(() => f.log.some((line) => line.includes("开始收发")));
  await f.emit("first wake");
  assert.equal(calls, 1);
  assert.ok(f.log.some((line) => line.includes("唤醒请求失败或超时")));
  assert.ok(!f.log.some((line) => line.includes(warningSecret)));
  await f.emit("second wake");
  assert.equal(calls, 2);
  process.emit("SIGTERM");
  await run;
});

test("待审批达到 --wait 后停止轮询", { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  let polls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/nonce")) return Response.json({ nonce: "nonce", message: "test registration" });
    if (init?.method === "GET") polls++;
    return Response.json({ status: "pending" });
  };
  await assert.rejects(f.launch(["--invite", "token", "--wait", "1"], { fetchImpl }), /等待房主审批超时/);
  assert.ok(polls > 0);
  assert.deepEqual(f.synced, []);
});
