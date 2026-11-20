import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { HubError, type HubClient } from "./hubClient.ts";
import { createSeatStore, SEAT_PORT_BASE, type SeatStore, type SeatSupervisor } from "./seats.ts";
import {
  createHelperServer,
  handleCreateSeat,
  HelperHttpError,
  HELPER_PAGE_HTML,
  type HelperServerDeps,
} from "./server.ts";
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
        pausedAt: r.pausedAt ?? null,
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
    async reportActivity() {
      return { accepted: 0, duplicates: 0 };
    },
    async reportCheckpoints() {
      return { accepted: 0, duplicates: 0 };
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

test("helper server：DELETE /api/agents/manual/:key 与 POST /api/agents/:key/test 强制 owner-write 并正确分发", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);

    // 1. 未注入实现时返回 501，且无 X-MAPR-Owner 或来自 hubOrigin 一律 403
    await withServer(fakeDeps(store, sup.supervisor, fakeHub()), async (port) => {
      const noOwnerDel = await rawRequest(port, {
        method: "DELETE",
        path: "/api/agents/manual/manual%3Aabc",
      });
      assert.equal(noOwnerDel.status, 403);

      const hubOriginTest = await rawRequest(port, {
        method: "POST",
        path: "/api/agents/claude-code/test",
        headers: { Origin: "https://hub.example", "X-MAPR-Owner": "1" },
        body: {},
      });
      assert.equal(hubOriginTest.status, 403);

      const missingDel = await rawRequest(port, {
        method: "DELETE",
        path: "/api/agents/manual/manual%3Aabc",
        headers: { "X-MAPR-Owner": "1" },
      });
      assert.equal(missingDel.status, 501);

      const missingTest = await rawRequest(port, {
        method: "POST",
        path: "/api/agents/claude-code/test",
        headers: { "X-MAPR-Owner": "1" },
        body: {},
      });
      assert.equal(missingTest.status, 501);
    });

    // 2. 注入实现后正确 URL 解码并返回业务状态码
    const removedKeys: string[] = [];
    const testedKeys: string[] = [];
    const depsWithHandlers: HelperServerDeps = {
      ...fakeDeps(store, sup.supervisor, fakeHub()),
      removeManualAgent: async (key) => {
        if (key === "manual:busy") throw new HelperHttpError(409, "agent_has_active_seats");
        removedKeys.push(key);
      },
      testAgent: async (key) => {
        testedKeys.push(key);
        return { ok: true, latencyMs: 12, detail: "连接就绪" };
      },
    };

    await withServer(depsWithHandlers, async (port) => {
      const delOk = await rawRequest(port, {
        method: "DELETE",
        path: "/api/agents/manual/manual%3Aabc-1",
        headers: { Origin: "http://127.0.0.1:8790", "X-MAPR-Owner": "1" },
      });
      assert.equal(delOk.status, 200);
      assert.deepEqual(delOk.body, { ok: true });
      assert.deepEqual(removedKeys, ["manual:abc-1"]);

      const delBusy = await rawRequest(port, {
        method: "DELETE",
        path: "/api/agents/manual/manual%3Abusy",
        headers: { "X-MAPR-Owner": "1" },
      });
      assert.equal(delBusy.status, 409);
      assert.equal(delBusy.body.reason, "agent_has_active_seats");

      const probeOk = await rawRequest(port, {
        method: "POST",
        path: "/api/agents/manual%3Aabc-1/test",
        headers: { Origin: "http://127.0.0.1:8790", "X-MAPR-Owner": "1" },
        body: {},
      });
      assert.equal(probeOk.status, 200);
      assert.equal(probeOk.body.ok, true);
      assert.equal(probeOk.body.latencyMs, 12);
      assert.deepEqual(testedKeys, ["manual:abc-1"]);
    });
  });
});

test("HELPER_PAGE_HTML：单 script 块 CSP 哈希一致、JS 语法合法、零 Emoji、包含全部 10 个预设与入座引导", async () => {
  // 1. 零 Emoji
  assert.equal(
    /\p{Extended_Pictographic}/u.test(HELPER_PAGE_HTML),
    false,
    "HELPER_PAGE_HTML must not contain any emoji"
  );

  // 2. Apple 纯白极简色板与圆角
  assert.match(HELPER_PAGE_HTML, /#ffffff/i);
  assert.match(HELPER_PAGE_HTML, /#f5f5f7/i);
  assert.match(HELPER_PAGE_HTML, /#1d1d1f/i);
  assert.match(HELPER_PAGE_HTML, /#0071e3/i);

  // 3. 单一 <script> 块，语法可通过 vm.Script 解析，且与 GET / 的 CSP sha256 完全一致
  const scriptMatches = [...HELPER_PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scriptMatches.length, 1, "HELPER_PAGE_HTML must contain exactly one <script> block");
  const scriptContent = scriptMatches[0][1];
  assert.doesNotThrow(() => new vm.Script(scriptContent), "inline <script> must be valid JavaScript");
  const expectedSha256 = createHash("sha256").update(scriptContent, "utf8").digest("base64");

  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);
    await withServer(fakeDeps(store, sup.supervisor, fakeHub()), async (port) => {
      const page = await rawRequest(port, { path: "/" });
      assert.equal(page.status, 200);
      const csp = String(page.headers["content-security-policy"] ?? "");
      assert.ok(
        csp.includes(`'sha256-${expectedSha256}'`),
        `CSP header (${csp}) must contain script sha256-${expectedSha256}`
      );
    });
  });

  // 4. 覆盖全部 10 个主流 Agent 预设 ID 与入座返回横幅文案
  const requiredPresetIds = [
    "grok",
    "grokbot-webhook",
    "muse",
    "muse-webhook",
    "openai",
    "claude-api",
    "gemini-api",
    "deepseek",
    "ollama",
    "webhook",
  ];
  for (const id of requiredPresetIds) {
    assert.ok(
      scriptContent.includes(`id: "${id}"`),
      `missing preset id "${id}" in HELPER_PAGE_HTML`
    );
  }
  assert.ok(HELPER_PAGE_HTML.includes("已将席位加入房间"));
  assert.ok(HELPER_PAGE_HTML.includes("返回线上房间继续协作"));
  assert.ok(HELPER_PAGE_HTML.includes("x-mapr-signature"));

  // 5. 安全与交互体验打磨校验：零 alert()、零 0600 术语、色彩徽章、空房间引导与 safeHttpOrigin / trustTierInfo 行为验证
  assert.equal(/\balert\s*\(/.test(scriptContent), false, "must not use blocking alert()");
  assert.equal(HELPER_PAGE_HTML.includes("0600"), false, "must replace 0600 jargon");
  assert.ok(
    HELPER_PAGE_HTML.includes("只保存在你自己的电脑里（仅当前系统账号可读），绝不上传平台服务器"),
    "must show friendly local-only secret storage copy"
  );
  assert.ok(HELPER_PAGE_HTML.includes('id="m-apikey"'), "must expose #m-apikey input");
  assert.ok(
    HELPER_PAGE_HTML.includes("请先完成配对，配对后将自动把所选智能体带入房间"),
    "must include unpaired ticket handoff banner copy"
  );
  assert.ok(
    HELPER_PAGE_HTML.includes("预设 — 填入密钥并点击保存即可接入"),
    "must include preset confirmation banner copy"
  );
  assert.ok(
    HELPER_PAGE_HTML.includes("还没有协作房间？前往网页端新建房间 →"),
    "must include empty rooms subtle link"
  );
  for (const token of ["#eaf7ee", "#1d7a3c", "#eef5ff", "#0066cc", "#fff6e5", "#a35c00"]) {
    assert.ok(
      HELPER_PAGE_HTML.toLowerCase().includes(token),
      `expected badge-tier color token ${token} in HELPER_PAGE_HTML`
    );
  }

  // Extract pure helper functions from scriptContent to verify runtime behavior in vm
  const fnProbeSource = [
    scriptContent.match(/function safeHttpOrigin\([\s\S]*?\n\}/)?.[0] ?? "",
    scriptContent.match(/function isLoopbackUrl\([\s\S]*?\n\}/)?.[0] ?? "",
    scriptContent.match(/function trustTierInfo\([\s\S]*?\n\}/)?.[0] ?? "",
    "globalThis.__exported = { safeHttpOrigin, trustTierInfo };",
  ].join("\n");
  const sandbox: Record<string, any> = { URL };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fnProbeSource, sandbox);
  const { safeHttpOrigin, trustTierInfo } = sandbox.__exported;
  assert.equal(safeHttpOrigin("https://hub.example/foo?bar=1"), "https://hub.example");
  assert.equal(safeHttpOrigin("http://127.0.0.1:5173/"), "http://127.0.0.1:5173");
  assert.equal(safeHttpOrigin("javascript:alert(1)"), "");
  assert.equal(safeHttpOrigin("data:text/html,hi"), "");
  assert.equal(safeHttpOrigin("not a url"), "");

  assert.deepEqual({ ...trustTierInfo({ kind: "codex" }) }, {
    text: "本机",
    cls: "badge-tier badge-tier-local",
  });
  assert.deepEqual(
    { ...trustTierInfo({ kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", displayName: "Ollama" }) },
    { text: "本机", cls: "badge-tier badge-tier-local" }
  );
  assert.deepEqual(
    { ...trustTierInfo({ kind: "openai-compatible", baseUrl: "http://localhost:8080/v1", displayName: "Local vLLM" }) },
    { text: "本机", cls: "badge-tier badge-tier-local" }
  );
  assert.deepEqual(
    { ...trustTierInfo({ kind: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", displayName: "DeepSeek" }) },
    { text: "云端接口", cls: "badge-tier badge-tier-cloud" }
  );
  assert.deepEqual({ ...trustTierInfo({ kind: "webhook", displayName: "Hook" }) }, {
    text: "自定义接口",
    cls: "badge-tier badge-tier-custom",
  });
});

test("HELPER_PAGE_HTML：已配对助手打开 #pair=mpc_old&preset=grok&room=r1 时绝不重配对，正常刷新列表并预填 Grok 与房间", async () => {
  const scriptContent = HELPER_PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(scriptContent.length > 0);

  function makeElement(tag = "div") {
    const children: any[] = [];
    return {
      tagName: tag.toUpperCase(),
      value: "",
      textContent: "",
      className: "",
      disabled: false,
      href: "",
      target: "",
      rel: "",
      type: "",
      onclick: null,
      onchange: null,
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
      children,
      get options() {
        return children;
      },
      append(...nodes: any[]) {
        children.push(...nodes);
      },
      replaceChildren(...nodes: any[]) {
        children.length = 0;
        children.push(...nodes);
      },
      querySelectorAll(sel: string) {
        return sel === "button" ? children.filter((c) => c.tagName === "BUTTON") : [];
      },
      classList: {
        toggle() {},
      },
      focus() {},
      scrollIntoView() {},
    };
  }

  const elements = new Map<string, ReturnType<typeof makeElement>>();
  const getEl = (id: string) => {
    let el = elements.get(id);
    if (!el) {
      el = makeElement(id === "m-room" || id === "m-kind" ? "select" : "div");
      elements.set(id, el);
    }
    return el;
  };

  const requests: string[] = [];
  const locationObj = {
    pathname: "/",
    search: "",
    hash: "#pair=mpc_old&preset=grok&room=r1",
  };

  const sandbox: Record<string, any> = {
    URL,
    URLSearchParams,
    document: {
      getElementById: (id: string) => getEl(id),
      createElement: (tag: string) => makeElement(tag),
    },
    location: locationObj,
    history: {
      replaceState(_state: unknown, _title: string, nextUrl: string) {
        locationObj.hash = "";
        locationObj.pathname = nextUrl;
      },
    },
    navigator: {
      clipboard: { writeText: async () => {} },
    },
    confirm: () => true,
    setInterval: () => 0,
    setTimeout: () => 0,
    fetch: async (url: string, init?: { method?: string }) => {
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push(`${method} ${url}`);
      if (url === "/api/hello") {
        // 清空初始值以确认后续是由配对态分支调用 applyPresetFromHash("grok") 填入
        getEl("m-name").value = "";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            app: "mapr-helper",
            version: "0.1.0",
            paired: true,
            hub_origin: "https://hub.example",
            owner_display_name: "主人",
          }),
        };
      }
      if (url === "/api/rooms") {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: "r1", name: "Room 1", role: "owner" }],
        };
      }
      if (url === "/api/agents" || url === "/api/seats") {
        return {
          ok: true,
          status: 200,
          json: async () => [],
        };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    },
  };
  sandbox.globalThis = sandbox;

  await vm.runInNewContext(scriptContent, sandbox);

  assert.equal(
    requests.some((r) => r.includes("/api/pair")),
    false,
    `paired helper must NEVER call /api/pair, saw: ${requests.join(", ")}`
  );
  assert.deepEqual(requests, [
    "GET /api/hello",
    "GET /api/rooms",
    "GET /api/agents",
    "GET /api/seats",
  ]);
  assert.equal(getEl("m-name").value, "Grok");
  assert.equal(getEl("m-room").value, "r1");
  assert.equal(locationObj.hash, "");
});

// ── WP5：本机席位暂停/恢复（pause 只停进程不删数据）──

function seatRecordFor(seatId: string, over: Partial<SeatRecord> = {}): SeatRecord {
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
    consolePort: SEAT_PORT_BASE,
    createdAt: "2026-11-20T00:00:00.000Z",
    ...over,
  };
}

test("helper server：/api/seats/:id/pause 只停进程不删数据，resume 恢复并清标记", async () => {
  await withTmp(async (root) => {
    const store = createSeatStore(root);
    const sup = fakeSupervisor(store);
    await store.save(seatRecordFor("seat-1"));
    const deps = fakeDeps(store, sup.supervisor, fakeHub());
    await withServer(deps, async (port) => {
      // 没有 owner 头 → guard 拦截
      const noAuth = await rawRequest(port, { method: "POST", path: "/api/seats/seat-1/pause" });
      assert.equal(noAuth.status, 403);
      // hubOrigin 伪造 owner 头 → 拦截
      const forged = await rawRequest(port, {
        method: "POST",
        path: "/api/seats/seat-1/pause",
        headers: { "X-MAPR-Owner": "1", Origin: "https://hub.example" },
      });
      assert.equal(forged.status, 403);
      // 不存在的席位 → 404
      const missing = await rawRequest(port, {
        method: "POST",
        path: "/api/seats/nope/pause",
        headers: { "X-MAPR-Owner": "1" },
      });
      assert.equal(missing.status, 404);
      // pause → 200：进程停了，但 seat.json 完整保留（绝不走删除语义）
      const paused = await rawRequest(port, {
        method: "POST",
        path: "/api/seats/seat-1/pause",
        headers: { "X-MAPR-Owner": "1" },
      });
      assert.equal(paused.status, 200);
      assert.deepEqual(sup.calls.stops, ["seat-1"]);
      const rec = await store.get("seat-1");
      assert.ok(rec, "暂停绝不能删除席位数据");
      assert.ok(rec.pausedAt);
      assert.equal(rec.pausedSource, "local");
      assert.equal(paused.body.pausedAt, rec.pausedAt);
      assert.equal((await stat(path.join(root, "seats", "seat-1", "seat.json"))).mode & 0o777, 0o600);
      // resume → 200：标记清除、进程拉起、视图如实
      const resumed = await rawRequest(port, {
        method: "POST",
        path: "/api/seats/seat-1/resume",
        headers: { "X-MAPR-Owner": "1" },
      });
      assert.equal(resumed.status, 200);
      assert.deepEqual(sup.calls.starts, ["seat-1"]);
      const rec2 = await store.get("seat-1");
      assert.equal(rec2?.pausedAt, null);
      assert.equal(rec2?.pausedSource, null);
      assert.equal(resumed.body.status, "running");
      assert.equal(resumed.body.pausedAt, null);
    });
  });
});
