import assert from "node:assert/strict";
import test from "node:test";
import { createHubClient, HubError } from "./hubClient.ts";

const TOKEN = "mhp_id.secret-xyz";
const HUB = "https://hub.example";

function jsonResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("hubClient：带 Bearer 令牌、地址去掉末尾斜线、解析响应", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const fetchImpl = (async (input: any, init: any) => {
    seenUrl = String(input);
    seenAuth = init.headers.Authorization;
    return jsonResponse(200, [{ id: "r1", name: "一号房", xmtp_group_id: null, role: "owner" }]);
  }) as typeof fetch;
  const hub = createHubClient(`${HUB}/`, TOKEN, fetchImpl);
  const rooms = await hub.listRooms();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].name, "一号房");
  assert.equal(seenUrl, `${HUB}/api/v1/helpers/me/rooms`);
  assert.equal(seenAuth, `Bearer ${TOKEN}`);
});

test("hubClient.pair：不带 Authorization，请求体是配对码+设备名+平台", async () => {
  let seenAuth: string | undefined;
  let seenBody: any;
  const fetchImpl = (async (_i: any, init: any) => {
    seenAuth = init?.headers?.Authorization;
    seenBody = JSON.parse(init.body);
    return jsonResponse(200, {
      helper_id: "h1",
      helper_token: "mhp_1.x",
      owner_user_id: "u",
      owner_display_name: "主人",
    });
  }) as typeof fetch;
  const hub = createHubClient(HUB, null, fetchImpl);
  const res = await hub.pair("mpc_a.b", "laptop", "linux");
  assert.equal(res.helper_id, "h1");
  assert.equal(res.helper_token, "mhp_1.x");
  assert.equal(seenAuth, undefined);
  assert.deepEqual(seenBody, { code: "mpc_a.b", device_name: "laptop", platform: "linux" });
});

test("hubClient：401 变 HubError(401)，错误信息绝不含令牌", async () => {
  const fetchImpl = (async () => jsonResponse(401, { detail: `unauthorized ${TOKEN}` })) as typeof fetch;
  const hub = createHubClient(HUB, TOKEN, fetchImpl);
  await assert.rejects(
    () => hub.listRooms(),
    (err: unknown) => {
      assert.ok(err instanceof HubError);
      assert.equal(err.status, 401);
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    }
  );
});

test("hubClient：配对码不出现在错误信息里", async () => {
  const code = "mpc_secret-code";
  const fetchImpl = (async () => jsonResponse(410, { detail: `code ${code} expired` })) as typeof fetch;
  const hub = createHubClient(HUB, null, fetchImpl);
  await assert.rejects(
    () => hub.pair(code, "d", "linux"),
    (err: unknown) => {
      assert.ok(err instanceof HubError);
      assert.equal(err.status, 410);
      assert.equal(err.message.includes(code), false);
      return true;
    }
  );
});

test("hubClient：网络错误变 HubError(0)，不泄底层文本", async () => {
  const fetchImpl = (async () => {
    throw new TypeError(`connect ECONNREFUSED ${TOKEN} proxy`);
  }) as typeof fetch;
  const hub = createHubClient(HUB, TOKEN, fetchImpl);
  await assert.rejects(
    () => hub.listRooms(),
    (err: unknown) => {
      assert.ok(err instanceof HubError);
      assert.equal(err.status, 0);
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    }
  );
});

test("hubClient：响应不是 JSON 也变成 HubError", async () => {
  const fetchImpl = (async () => new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
  const hub = createHubClient(HUB, TOKEN, fetchImpl);
  await assert.rejects(() => hub.listRooms(), HubError);
});

test("hubClient：deleteSeat 接受 204，seatId 做 URL 编码", async () => {
  let seenUrl = "";
  const fetchImpl = (async (input: any) => {
    seenUrl = String(input);
    return jsonResponse(204, null);
  }) as typeof fetch;
  const hub = createHubClient(HUB, TOKEN, fetchImpl);
  await hub.deleteSeat("seat/有空格");
  assert.equal(seenUrl, `${HUB}/api/v1/helpers/me/seats/seat%2F%E6%9C%89%E7%A9%BA%E6%A0%BC`);
});

test("hubClient.heartbeat：上报 Agent 与席位状态，返回 revoked 与 seats_to_stop", async () => {
  let seenBody: any;
  const fetchImpl = (async (_i: any, init: any) => {
    seenBody = JSON.parse(init.body);
    return jsonResponse(200, { revoked: false, seats_to_stop: ["s-9"] });
  }) as typeof fetch;
  const hub = createHubClient(HUB, TOKEN, fetchImpl);
  const res = await hub.heartbeat({
    agents: [{ key: "claude-code", kind: "claude-code", version: "2.1.0" }],
    seats: [{ seat_id: "s-1", status: "running" }],
  });
  assert.deepEqual(res, { revoked: false, seats_to_stop: ["s-9"] });
  assert.deepEqual(seenBody.seats, [{ seat_id: "s-1", status: "running" }]);
  assert.deepEqual(seenBody.agents, [{ key: "claude-code", kind: "claude-code", version: "2.1.0" }]);
});

test("hubClient：未配对（无令牌）调用受保护端点直接 401", async () => {
  const hub = createHubClient(HUB, null, async () => {
    throw new Error("should not be called");
  });
  await assert.rejects(
    () => hub.listRooms(),
    (err: unknown) => err instanceof HubError && err.status === 401
  );
});

test("hubClient.reportActivity / reportCheckpoints：路径、鉴权与严格安全元数据负载", async () => {
  const calls: { url: string; body: any; auth: string }[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    calls.push({
      url: String(input),
      body: JSON.parse(init.body),
      auth: init.headers.Authorization,
    });
    return jsonResponse(200, { accepted: 1, duplicates: 0 });
  }) as typeof fetch;
  const hub = createHubClient(HUB, TOKEN, fetchImpl);
  const ev = {
    id: "ev-1",
    room_id: "room-1",
    actor_kind: "agent" as const,
    actor_id: "0x" + "a".repeat(40),
    kind: "action_finished",
    status: "ok",
    subject_id: "req-1",
    stream_seq: 1,
    created_at: "2026-11-20T10:00:00.000Z",
  };
  const cp = {
    version: 1 as const,
    room_id: "room-1",
    stream_id: "0x" + "a".repeat(40),
    head_seq: 1,
    head_hash: "b".repeat(64),
    entry_count: 1,
    created_at: "2026-11-20T10:00:00.000Z",
    signer: "0x" + "a".repeat(40),
    signature: "0x" + "c".repeat(130),
  };

  assert.deepEqual(await hub.reportActivity([ev]), { accepted: 1, duplicates: 0 });
  assert.deepEqual(await hub.reportCheckpoints([cp]), { accepted: 1, duplicates: 0 });
  assert.equal(calls[0].url, `${HUB}/api/v1/helpers/me/activity`);
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  assert.deepEqual(calls[0].body, { events: [ev] });
  assert.equal(calls[1].url, `${HUB}/api/v1/helpers/me/activity/checkpoints`);
  assert.deepEqual(calls[1].body, { checkpoints: [cp] });
});
