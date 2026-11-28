import assert from "node:assert/strict";
import test from "node:test";
import { checkCloudSeat, startCloudSeatPolling } from "./cloudSeat.ts";

const SEAT = "seat-1";
const TOKEN = "agent-token-abc";

function fakeFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

function jsonRes(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

test("checkCloudSeat: 活跃席位返回 active，renewToken 时续约并带回新令牌", async () => {
  const calls: string[] = [];
  const fetchImpl = fakeFetch(async (url) => {
    calls.push(url);
    if (url.endsWith(`/api/v1/agent-seats/${SEAT}/token`)) {
      return jsonRes(200, { agent_token: "new-token-xyz" });
    }
    return jsonRes(200, { seat_id: SEAT, room_id: "r1", source: "cloud", group_status: "added", paused_at: null, removed_at: null });
  });
  const res = await checkCloudSeat({ hubOrigin: "https://hub.example", seatId: SEAT, agentToken: TOKEN, renewToken: true, fetchImpl });
  assert.equal(res.state, "active");
  assert.equal(res.tokenRenewed, true);
  assert.equal(res.agentToken, "new-token-xyz");
  assert.equal(calls.length, 2);
});

test("checkCloudSeat: 活跃但不开续约时保持原令牌", async () => {
  const fetchImpl = fakeFetch(async () =>
    jsonRes(200, { seat_id: SEAT, room_id: "r1", group_status: "added", paused_at: null, removed_at: null }));
  const res = await checkCloudSeat({ hubOrigin: "https://hub.example", seatId: SEAT, agentToken: TOKEN, fetchImpl });
  assert.equal(res.state, "active");
  assert.equal(res.agentToken, TOKEN);
  assert.equal(res.tokenRenewed, false);
});

test("checkCloudSeat: 续约失败不改判 active，也不吞掉旧令牌", async () => {
  const fetchImpl = fakeFetch(async (url) => {
    if (url.endsWith("/token")) return jsonRes(500, { detail: "boom" });
    return jsonRes(200, { seat_id: SEAT, room_id: "r1", group_status: "added", paused_at: null, removed_at: null });
  });
  const res = await checkCloudSeat({ hubOrigin: "https://hub.example", seatId: SEAT, agentToken: TOKEN, renewToken: true, fetchImpl });
  assert.equal(res.state, "active");
  assert.equal(res.agentToken, TOKEN);
  assert.equal(res.tokenRenewed, false);
});

test("checkCloudSeat: paused_at 非空 → paused；removed_at / group_status=removed → removed", async () => {
  const cases: Array<[unknown, string]> = [
    [{ seat_id: SEAT, group_status: "added", paused_at: "2026-11-20T00:00:00Z", removed_at: null }, "paused"],
    [{ seat_id: SEAT, group_status: "added", paused_at: null, removed_at: "2026-11-20T01:00:00Z" }, "removed"],
    [{ seat_id: SEAT, group_status: "removed", paused_at: null, removed_at: null }, "removed"],
  ];
  for (const [body, want] of cases) {
    const fetchImpl = fakeFetch(async () => jsonRes(200, body));
    const res = await checkCloudSeat({ hubOrigin: "https://hub.example", seatId: SEAT, agentToken: TOKEN, fetchImpl });
    assert.equal(res.state, want, JSON.stringify(body));
  }
});

test("checkCloudSeat: 403/404 fail-closed 按 removed；5xx/网络错误/坏响应 → unknown", async () => {
  for (const status of [403, 404]) {
    const fetchImpl = fakeFetch(async () => jsonRes(status, { detail: "nope" }));
    const res = await checkCloudSeat({ hubOrigin: "https://hub.example", seatId: SEAT, agentToken: TOKEN, fetchImpl });
    assert.equal(res.state, "removed", `http ${status}`);
    assert.equal(res.confirmedRemoval, undefined);
    assert.equal(res.httpStatus, status);
  }
  for (const status of [401, 500, 502]) {
    const fetchImpl = fakeFetch(async () => jsonRes(status, { detail: "err" }));
    const res = await checkCloudSeat({ hubOrigin: "https://hub.example", seatId: SEAT, agentToken: TOKEN, fetchImpl });
    assert.equal(res.state, "unknown", `http ${status}`);
  }
  const netFail = fakeFetch(async () => { throw new Error("socket hangup"); });
  const res2 = await checkCloudSeat({ hubOrigin: "https://hub.example", seatId: SEAT, agentToken: TOKEN, fetchImpl: netFail });
  assert.equal(res2.state, "unknown");
  assert.equal(res2.httpStatus, 0);
});

test("checkCloudSeat: 请求带 Bearer 令牌，URL 不泄露令牌原文", async () => {
  let auth = "";
  const fetchImpl = fakeFetch(async (url, init) => {
    auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    assert.equal(url.includes(TOKEN), false, "token must not appear in URL");
    return jsonRes(200, { seat_id: SEAT, group_status: "added", paused_at: null, removed_at: null });
  });
  await checkCloudSeat({ hubOrigin: "https://hub.example", seatId: SEAT, agentToken: TOKEN, fetchImpl });
  assert.equal(auth, `Bearer ${TOKEN}`);
});

test("a confirmed credential invalidation stops polling and waits for cleanup", async () => {
  let checks = 0;
  let cleaned = false;
  const fetchImpl = fakeFetch(async () => {
    checks++;
    if (checks === 1) throw new Error("transient disconnect");
    return jsonRes(401, { detail: { code: "invalidated" } });
  });
  const poller = startCloudSeatPolling({
    hubOrigin: "https://hub.example", seatId: SEAT, agentToken: TOKEN, fetchImpl,
    onRemoved: async (confirmed) => { await Promise.resolve(); cleaned = confirmed; },
  });
  await poller.checkNow();
  assert.equal(cleaned, false);
  await poller.checkNow();
  await poller.checkNow();
  assert.equal(cleaned, true);
  assert.equal(checks, 2);
});

test("startCloudSeatPolling: removed 时触发 onRemoved 且自动停止", async () => {
  let removed = 0;
  let polls = 0;
  const fetchImpl = fakeFetch(async () => {
    polls += 1;
    return jsonRes(200, { seat_id: SEAT, group_status: "removed", paused_at: null, removed_at: "2026-11-20T00:00:00Z" });
  });
  const poller = startCloudSeatPolling({
    hubOrigin: "https://hub.example",
    seatId: SEAT,
    agentToken: TOKEN,
    intervalMs: 5,
    fetchImpl,
    onRemoved: () => { removed += 1; },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(removed, 1);
  const seen = polls;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(polls, seen, "poller must stop after removed");
  poller.stop();
});

test("startCloudSeatPolling: paused 边沿触发 onPaused，续约成功触发 onToken", async () => {
  const events: string[] = [];
  let phase = 0;
  const fetchImpl = fakeFetch(async (url) => {
    if (url.endsWith("/token")) return jsonRes(200, { agent_token: "tok-2" });
    if (phase === 0) return jsonRes(200, { seat_id: SEAT, group_status: "added", paused_at: null, removed_at: null });
    return jsonRes(200, { seat_id: SEAT, group_status: "added", paused_at: "2026-11-20T00:00:00Z", removed_at: null });
  });
  const poller = startCloudSeatPolling({
    hubOrigin: "https://hub.example",
    seatId: SEAT,
    agentToken: TOKEN,
    renewToken: true,
    intervalMs: 5,
    fetchImpl,
    onToken: (t) => events.push(`token:${t}`),
    onPaused: (p) => events.push(`paused:${p}`),
  });
  await new Promise((r) => setTimeout(r, 30));
  phase = 1;
  await new Promise((r) => setTimeout(r, 30));
  poller.stop();
  assert.ok(events.includes("token:tok-2"), events.join(","));
  assert.ok(events.includes("paused:true"), events.join(","));
});
