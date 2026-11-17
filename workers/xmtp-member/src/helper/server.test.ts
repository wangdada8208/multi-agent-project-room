import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HubError, type HubClient } from "./hubClient.ts";
import { createSeatStore, SEAT_PORT_BASE, type SeatStore, type SeatSupervisor } from "./seats.ts";
import { createHelperServer, handleCreateSeat, type HelperServerDeps } from "./server.ts";
import type { HelperConfig, LocalAgent, SeatGrant, SeatRecord, SeatView } from "./types.ts";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-server-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CLAUDE: LocalAgent = {
  key: "claude-code",
  kind: "claude-code",
  displayName: "Claude Code",
  source: "detected",
  binaryPath: "/usr/bin/claude",
  loginState: "likely-ready",
};

const CFG: HelperConfig = {
  hubOrigin: "https://hub.example",
  helperId: "h1",
  helperToken: "mhp_id.secret",
  deviceName: "dev",
  ownerUserId: "u1",
  ownerDisplayName: "主人",
  manualAgents: [],
};

function grant(over: Partial<SeatGrant> = {}): SeatGrant {
  return {
    seat_id: "seat-abc",
    room_id: "room-1",
    room_name: "一号房",
    agent_user_id: "u-agent",
    agent_username: "agent-1-claude-code",
    agent_token: "agent-token-1",
    xmtp_group_id: null,
    allowed_senders: ["0x" + "c".repeat(40)],
    ...over,
  };
}

/** 模拟真实 supervisor 的行为：start 过的席位视图报 running。 */
function fakeSupervisor(store: SeatStore, opts: { failStart?: boolean } = {}) {
  const calls = { starts: [] as string[], stops: [] as string[] };
  const started = new Set<string>();
  const supervisor: SeatSupervisor = {
    async start(id) {
      calls.starts.push(id);
      if (opts.failStart) throw new Error("spawn boom");
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
        status: started.has(r.seatId) ? "running" : "stopped",
        lastError: null,
      }));
    },
  };
  return { calls, supervisor };
}

function fakeHub(overrides: Partial<HubClient> = {}): HubClient {
  return {
    async pair() {
      throw new Error("pair not expected");
    },
    async listRooms() {
      return [{ id: "room-1", name: "一号房", xmtp_group_id: null, role: "owner" }];
    },
    async createSeat() {
      return grant();
    },
    async getSeat() {
      return { xmtp_group_id: null, group_status: "pending" };
    },
    async refreshAgentToken() {
      return { agent_token: "new-token" };
    },
    async deleteSeat() {},
    async heartbeat() {
      return { revoked: false, seats_to_stop: [] };
    },
    ...overrides,
  };
}

function fakeDeps(store: SeatStore, supervisor: SeatSupervisor, hub: HubClient | null): HelperServerDeps {
  return {
    version: "0.0.0-test",
    config: () => CFG,
    pair: async () => CFG,
    hub: () => hub,
    agents: async () => [CLAUDE],
    rescan: async () => [CLAUDE],
    store,
    supervisor,
  };
}

test("handleCreateSeat via ticket：写 seat.json(0600)、启动进程、返回视图", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);
    let seen: any = null;
    const hub = fakeHub({
      async createSeat(req: any) {
        seen = req;
        return grant();
      },
    });
    const view = (await handleCreateSeat(fakeDeps(store, sup.supervisor, hub), {
      via: "ticket",
      ticket: "mjt_x.y",
      agent_key: "claude-code",
    })) as SeatView;
    assert.equal(view.seatId, "seat-abc");
    assert.equal(view.status, "running");
    assert.equal(seen.via, "ticket");
    assert.equal(seen.ticket, "mjt_x.y");
    assert.equal(seen.kind, "claude-code");
    assert.equal(seen.display_name, "Claude Code");
    assert.match(seen.xmtp_address, /^0x[0-9a-f]{40}$/);
    const rec = await store.get("seat-abc");
    assert.ok(rec);
    assert.equal(rec.agentToken, "agent-token-1");
    assert.equal(rec.consolePort, 8791);
    assert.match(rec.xmtpWalletKey, /^0x[0-9a-f]{64}$/);
    assert.match(rec.xmtpDbEncryptionKey, /^0x[0-9a-f]{64}$/);
    assert.equal((await stat(path.join(root, "seats", "seat-abc", "seat.json"))).mode & 0o777, 0o600);
    assert.deepEqual(sup.calls.starts, ["seat-abc"]);
  });
});

test("handleCreateSeat via local：同 agentKey+roomId 幂等，第二次不调 Hub 不换密钥", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);
    let creates = 0;
    const hub = fakeHub({
      async createSeat() {
        creates++;
        return grant();
      },
    });
    const deps = fakeDeps(store, sup.supervisor, hub);
    const v1 = (await handleCreateSeat(deps, { via: "local", room_id: "room-1", agent_key: "claude-code" })) as SeatView;
    const v2 = (await handleCreateSeat(deps, { via: "local", room_id: "room-1", agent_key: "claude-code" })) as SeatView;
    assert.equal(creates, 1);
    assert.equal(v2.seatId, v1.seatId);
    assert.equal(v2.xmtpAddress, v1.xmtpAddress);
    // 第二次也保证进程被拉起来
    assert.deepEqual(sup.calls.starts, ["seat-abc", "seat-abc"]);
  });
});

test("handleCreateSeat：Hub 失败不落盘", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);
    const hub = fakeHub({
      async createSeat() {
        throw new HubError(409, "join ticket unavailable");
      },
    });
    await assert.rejects(
      () => handleCreateSeat(fakeDeps(store, sup.supervisor, hub), { via: "ticket", ticket: "mjt_x", agent_key: "claude-code" }),
      HubError
    );
    assert.deepEqual(await store.list(), []);
    await assert.rejects(() => stat(path.join(root, "seats")));
  });
});

test("handleCreateSeat：进程启动失败保留 seat.json 并如实返回 crashed", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store, { failStart: true });
    const view = (await handleCreateSeat(fakeDeps(store, sup.supervisor, fakeHub()), {
      via: "local",
      room_id: "room-1",
      agent_key: "claude-code",
    })) as SeatView;
    assert.equal(view.status, "crashed");
    assert.match(view.lastError ?? "", /failed to start/);
    const rec = await store.get(view.seatId);
    assert.ok(rec, "seat.json 应保留以便重试");
    assert.equal(rec.agentToken, "agent-token-1");
  });
});

test("handleCreateSeat via local：Hub 侧已移除的席位清掉重建", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    // 预置一条同 agentKey+roomId 的旧席位：Hub 已把它移除。
    const stale: SeatRecord = {
      seatId: "seat-old",
      agentKey: "claude-code",
      roomId: "room-1",
      roomName: "一号房",
      agentUsername: "agent-old",
      xmtpWalletKey: "0x" + "11".repeat(32),
      xmtpDbEncryptionKey: "0x" + "22".repeat(32),
      xmtpAddress: "0x" + "d".repeat(40),
      xmtpGroupId: null,
      allowedSenders: [],
      agentToken: "old-token",
      consolePort: SEAT_PORT_BASE,
      createdAt: "2026-11-17T00:00:00.000Z",
    };
    await store.save(stale);
    const sup = fakeSupervisor(store);
    const hub = fakeHub({
      async getSeat() {
        return { xmtp_group_id: null, group_status: "removed" };
      },
      async createSeat() {
        return grant({ seat_id: "seat-new" });
      },
    });
    const deps = fakeDeps(store, sup.supervisor, hub);
    const v1 = (await handleCreateSeat(deps, { via: "local", room_id: "room-1", agent_key: "claude-code" })) as SeatView;
    assert.equal(v1.seatId, "seat-new");
    // 旧记录与旧进程都被清掉，新记录沿用腾出来的端口
    assert.equal(await store.get("seat-old"), null);
    assert.deepEqual(sup.calls.stops, ["seat-old"]);
    assert.equal((await store.get("seat-new"))?.consolePort, SEAT_PORT_BASE);
  });
});

// ── 真 HTTP 服务（端口 0）──

async function withServer(deps: HelperServerDeps, fn: (port: number) => Promise<void>): Promise<void> {
  const server = createHelperServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function rawRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        // 不用全局 keep-alive 代理，避免 server.close() 等空闲连接超时。
        agent: false,
        headers: {
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed: any = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            // 页面 HTML 等非 JSON 响应原样返回
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

test("helper server：hello、页面、Host 伪造拦截", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);
    const deps = fakeDeps(store, sup.supervisor, fakeHub());
    await withServer(deps, async (port) => {
      const hello = await rawRequest(port, { path: "/api/hello" });
      assert.equal(hello.status, 200);
      assert.equal(hello.body.app, "mapr-helper");
      assert.equal(hello.body.paired, true);
      assert.equal(hello.body.owner_display_name, "主人");
      const page = await rawRequest(port, { path: "/" });
      assert.equal(page.status, 200);
      assert.match(page.headers["content-type"] ?? "", /text\/html/);
      const bad = await rawRequest(port, { path: "/api/hello", headers: { Host: "evil.com" } });
      assert.equal(bad.status, 403);
    });
  });
});

test("helper server：owner-write 要 owner 头；hubOrigin 只能走票据", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);
    const deps = fakeDeps(store, sup.supervisor, fakeHub());
    await withServer(deps, async (port) => {
      // owner-write 没有 owner 头 → 403（连业务层都到不了）
      const del1 = await rawRequest(port, { method: "DELETE", path: "/api/seats/s-1" });
      assert.equal(del1.status, 403);
      // 有 owner 头、无 Origin → 过 guard，业务 404
      const del2 = await rawRequest(port, {
        method: "DELETE",
        path: "/api/seats/s-1",
        headers: { "X-MAPR-Owner": "1" },
      });
      assert.equal(del2.status, 404);
      // hubOrigin 做 owner-write，伪造 owner 头也没用
      const del3 = await rawRequest(port, {
        method: "DELETE",
        path: "/api/seats/s-1",
        headers: { "X-MAPR-Owner": "1", Origin: "https://hub.example" },
      });
      assert.equal(del3.status, 403);
      // hubOrigin 走 ticket → 200
      const join = await rawRequest(port, {
        method: "POST",
        path: "/api/seats",
        headers: { Origin: "https://hub.example" },
        body: { via: "ticket", ticket: "mjt_x.y", agent_key: "claude-code" },
      });
      assert.equal(join.status, 200);
      assert.equal(join.body.seatId, "seat-abc");
      assert.equal(join.headers["access-control-allow-origin"], "https://hub.example");
      // hubOrigin 走 local → owner-write → 403
      const joinLocal = await rawRequest(port, {
        method: "POST",
        path: "/api/seats",
        headers: { Origin: "https://hub.example", "X-MAPR-Owner": "1" },
        body: { via: "local", room_id: "room-1", agent_key: "claude-code" },
      });
      assert.equal(joinLocal.status, 403);
      // 本地页面（回环 Origin）走 local → 放行
      const joinLoop = await rawRequest(port, {
        method: "POST",
        path: "/api/seats",
        headers: { Origin: "http://127.0.0.1:8790", "X-MAPR-Owner": "1" },
        body: { via: "local", room_id: "room-1", agent_key: "claude-code" },
      });
      assert.equal(joinLoop.status, 200);
    });
  });
});

test("helper server：OPTIONS 预检回 Private-Network 头", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);
    const deps = fakeDeps(store, sup.supervisor, fakeHub());
    await withServer(deps, async (port) => {
      const pre = await rawRequest(port, {
        method: "OPTIONS",
        path: "/api/seats",
        headers: { Origin: "https://hub.example", "Access-Control-Request-Method": "POST" },
      });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers["access-control-allow-private-network"], "true");
      assert.equal(pre.headers["access-control-allow-origin"], "https://hub.example");
      // 非回环非 hub 的来源连预检都过不了
      const bad = await rawRequest(port, {
        method: "OPTIONS",
        path: "/api/seats",
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(bad.status, 403);
    });
  });
});

test("helper server：pair 是 owner-write，未配对时 rooms 返回 401", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);
    // 未配对：config 有壳但 hub() 为 null 的形态用 unpaired config 表达
    const unpaired: HelperConfig = { ...CFG, helperId: "", helperToken: "" };
    const deps: HelperServerDeps = {
      ...fakeDeps(store, sup.supervisor, null),
      config: () => unpaired,
    };
    await withServer(deps, async (port) => {
      const rooms = await rawRequest(port, { path: "/api/rooms" });
      assert.equal(rooms.status, 401);
      const pair = await rawRequest(port, { method: "POST", path: "/api/pair", body: { code: "mpc_x" } });
      assert.equal(pair.status, 403);
    });
  });
});
