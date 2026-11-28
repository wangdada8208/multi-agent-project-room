import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { runCli } from "./cli.ts";

async function withoutMaprJson<T>(fn: () => Promise<T>): Promise<T> {
  const old = process.env.MAPR_JSON;
  delete process.env.MAPR_JSON;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.MAPR_JSON;
    else process.env.MAPR_JSON = old;
  }
}

test("mapr --help、-h、help 输出人类可读命令列表和可复制示例", async () => {
  await withoutMaprJson(async () => {
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(args, {
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
      });
      assert.equal(code, 0);
      assert.deepEqual(stderr, []);
      const out = stdout.join("\n");
      for (const needle of ["up", "join", "bridge", "mcp-approve-send", "可复制示例", "mapr join"]) {
        assert.ok(out.includes(needle), `${args[0]} should mention ${needle}`);
      }
    }
  });
});

test("mapr 无参数和未知命令给人类可读用法；JSON 模式保持机器输出", async () => {
  await withoutMaprJson(async () => {
    for (const args of [[], ["does-not-exist"]]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(args, {
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
      });
      assert.equal(code, 1);
      assert.deepEqual(stdout, []);
      const err = stderr.join("\n");
      assert.match(err, /可复制示例/);
      assert.match(err, /mapr join/);
      assert.doesNotMatch(err.trim(), /^\{/);
    }
  });

  for (const args of [["--json"], ["does-not-exist", "--json"], ["--json", "does-not-exist"]]) {
    const stderr: string[] = [];
    const code = await runCli(args, {
      stdout: () => {},
      stderr: (m) => stderr.push(m),
    });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stderr.join("")), {
      ok: false,
      reason: "unknown_command",
      command: args.includes("does-not-exist") ? "does-not-exist" : "",
    });
  }

  const old = process.env.MAPR_JSON;
  process.env.MAPR_JSON = "1";
  try {
    const stderr: string[] = [];
    const code = await runCli([], {
      stdout: () => {},
      stderr: (m) => stderr.push(m),
    });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stderr.join("")), { ok: false, reason: "unknown_command", command: "" });
  } finally {
    if (old === undefined) delete process.env.MAPR_JSON;
    else process.env.MAPR_JSON = old;
  }
});

test("mapr join 缺邀请链接时给人类下一步；--json 保持 invite_required", async () => {
  await withoutMaprJson(async () => {
    const stderr: string[] = [];
    const code = await runCli(["join"], {
      stdout: () => {},
      stderr: (m) => stderr.push(m),
    });
    assert.equal(code, 1);
    const err = stderr.join("\n");
    assert.match(err, /邀请链接缺失/);
    assert.match(err, /mapr join/);
    assert.doesNotMatch(err.trim(), /^\{/);
  });

  const stderr: string[] = [];
  const code = await runCli(["join", "--json"], {
    stdout: () => {},
    stderr: (m) => stderr.push(m),
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(stderr.join("")), { ok: false, reason: "invite_required" });
});

test("mapr join 人类模式区分无效链接和网络错误", async () => {
  await withoutMaprJson(async () => {
    const invalidStderr: string[] = [];
    const invalidCode = await runCli(["join", "https://hub.example/rooms/r-1"], {
      stdout: () => {},
      stderr: (m) => invalidStderr.push(m),
    });
    assert.equal(invalidCode, 1);
    assert.match(invalidStderr.join("\n"), /链接已过期或失效/);

    const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-join-offline-"));
    const networkStderr: string[] = [];
    const networkCode = await runCli(
      ["join", "tok-join-1", "--hub", "http://127.0.0.1:1", "--state-dir", dir, "--wait", "0"],
      { stdout: () => {}, stderr: (m) => networkStderr.push(m) }
    );
    assert.equal(networkCode, 1);
    assert.match(networkStderr.join("\n"), /网络连不上/);
  });
});

test("mapr bridge 转发参数并隐藏注册失败的 Hub 响应原文", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-cli-bridge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stdout: (msg: string) => stdout.push(msg), stderr: (msg: string) => stderr.push(msg) };
  const requests: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("/nonce")) {
      res.end(JSON.stringify({ nonce: "test-once", message: "approve CLI test" }));
    } else {
      res.statusCode = 422;
      res.end(JSON.stringify({ detail: "response-must-stay-private" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); });
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");

  assert.equal(await runCli(["bridge", "--help"], io), 0);
  assert.match(stdout.join("\n"), /mapr bridge.*--wake-url/);
  const invite = `http://127.0.0.1:${addr.port}/rooms/cli-room?invite=cli-token`;
  assert.equal(await runCli(["bridge", "--invite", invite, "--state-dir", dir, "--env", "local"], io), 1);
  assert.deepEqual(requests, ["/api/v1/invites/nonce", "/api/v1/invites/cli-token/agent-register"]);
  assert.match(stderr.join("\n"), /HTTP 422/);
  assert.doesNotMatch([...stdout, ...stderr].join("\n"), /response-must-stay-private|cli-token|0x[\da-f]{64,}/);
});

test("mapr identity create writes .env and prints address JSON without leaking private keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(["identity", "create", "--dir", dir], {
    stdout: (msg) => stdout.push(msg),
    stderr: (msg) => stderr.push(msg),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.length, 0);

  const outStr = stdout.join("").trim();
  const parsed = JSON.parse(outStr);
  assert.ok(parsed.address);
  assert.match(parsed.address, /^0x[0-9a-f]{40}$/);

  // 严格断言：输出中不能泄露 64 位十六进制私钥
  assert.doesNotMatch(outStr, /[0-9a-fA-F]{64}/);

  const envContent = await readFile(path.join(dir, ".env"), "utf8");
  assert.match(envContent, /XMTP_WALLET_KEY=0x[0-9a-fA-F]{64}/);
  assert.match(envContent, /XMTP_DB_ENCRYPTION_KEY=0x[0-9a-fA-F]{64}/);
  assert.match(envContent, /XMTP_ENV=dev/);
});

test("mapr request calls local server with X-MAPR-Owner header and outputs JSON", async () => {
  let receivedHeader = "";
  let receivedBody: any = null;

  const server = http.createServer(async (req, res) => {
    receivedHeader = String(req.headers["x-mapr-owner"]);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedBody = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, request_id: "req-mock-123" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = String((server.address() as AddressInfo).port);

  const stdout: string[] = [];
  try {
    const exitCode = await runCli(
      [
        "request",
        "--to",
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        "--scope",
        "calendar.free_busy",
        "--from",
        "2026-10-05",
        "--to-date",
        "2026-10-09",
        "--purpose",
        "协调下周例会",
        "--port",
        port,
      ],
      { stdout: (msg) => stdout.push(msg), stderr: () => {} }
    );

    assert.equal(exitCode, 0);
    assert.equal(receivedHeader, "1");
    assert.equal(receivedBody.to, "0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    assert.equal(receivedBody.date_from, "2026-10-05");
    assert.equal(receivedBody.date_to, "2026-10-09");

    const outJson = JSON.parse(stdout.join("").trim());
    assert.deepEqual(outJson, { ok: true, request_id: "req-mock-123" });
  } finally {
    server.close();
  }
});

test("mapr consents calls local server and extracts consents array", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        self: "0x...",
        consents: [{ request_id: "req-1", status: "pending" }],
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = String((server.address() as AddressInfo).port);

  const stdout: string[] = [];
  try {
    const exitCode = await runCli(["consents", "--port", port], {
      stdout: (msg) => stdout.push(msg),
      stderr: () => {},
    });

    assert.equal(exitCode, 0);
    const outJson = JSON.parse(stdout.join("").trim());
    assert.deepEqual(outJson, [{ request_id: "req-1", status: "pending" }]);
  } finally {
    server.close();
  }
});

test("mapr approve and deny call respective console endpoints", async () => {
  const actionsCalled: string[] = [];

  const server = http.createServer((req, res) => {
    actionsCalled.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = String((server.address() as AddressInfo).port);

  try {
    const stdout1: string[] = [];
    const exit1 = await runCli(["approve", "req-101", "--port", port], {
      stdout: (msg) => stdout1.push(msg),
      stderr: () => {},
    });
    assert.equal(exit1, 0);
    assert.deepEqual(JSON.parse(stdout1.join("").trim()), { ok: true });

    const stdout2: string[] = [];
    const exit2 = await runCli(["deny", "req-102", "--port", port], {
      stdout: (msg) => stdout2.push(msg),
      stderr: () => {},
    });
    assert.equal(exit2, 0);
    assert.deepEqual(JSON.parse(stdout2.join("").trim()), { ok: true });

    assert.deepEqual(actionsCalled, [
      "POST /api/consents/req-101/approve",
      "POST /api/consents/req-102/deny",
    ]);
  } finally {
    server.close();
  }
});

test("mapr task dispatches task to local console", async () => {
  let receivedBody: any = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedBody = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, request_id: "t-99" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = String((server.address() as AddressInfo).port);

  try {
    const stdout: string[] = [];
    const exit = await runCli(
      [
        "task",
        "--to",
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        "--goal",
        "调查路线",
        "--acceptance",
        "必须写明公里数,需有备选路线",
        "--port",
        port,
      ],
      { stdout: (msg) => stdout.push(msg), stderr: () => {} }
    );
    assert.equal(exit, 0);
    assert.deepEqual(receivedBody, {
      to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      goal: "调查路线",
      acceptance: ["必须写明公里数", "需有备选路线"],
    });
    assert.deepEqual(JSON.parse(stdout.join("").trim()), { ok: true, request_id: "t-99" });
  } finally {
    server.close();
  }
});

// ── mapr join：云端 Agent 持邀请链接自助注册（WP6）──

interface FakeHubState {
  registerCalls: any[];
  nonceCalls: any[];
  pollCalls: { url: URL; headers: IncomingHttpHeaders }[];
  registerResponse: { status: number; body: unknown };
  pollResponses: { status: number; body: unknown }[];
}

/** 假 Hub：nonce 签发 + agent-register 注册/轮询，逐条记录请求体供断言。 */
function fakeInviteHub(state: FakeHubState) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && url.pathname === "/api/v1/invites/nonce") {
        state.nonceCalls.push(JSON.parse(body || "{}"));
        json(201, {
          nonce: `nonce-${state.nonceCalls.length}`,
          message: "MAPR-XP1\naction: invite-agent-register\nresource: tok-join-1\naddress: 0x0\nnonce: x\nexpires_at: y",
          expires_at: "2026-11-20T00:10:00+00:00",
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/invites/tok-join-1/agent-register") {
        state.registerCalls.push(JSON.parse(body || "{}"));
        json(state.registerResponse.status, state.registerResponse.body);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/invites/tok-join-1/agent-register") {
        const idx = Math.min(state.pollCalls.length, state.pollResponses.length - 1);
        state.pollCalls.push({ url, headers: req.headers });
        const r = state.pollResponses[idx];
        json(r.status, r.body);
        return;
      }
      json(404, { detail: "not_found" });
    });
  });
}

const CONSUMED = {
  status: "consumed",
  redemption_id: "red-1",
  approved_scopes: ["task.run", "gmail.send", "payment.send"],
  agent_token: "agent-tok-9",
  seat_id: "seat-9",
  room_id: "room-9",
  xmtp_group_id: "group-9",
  agent_user_id: "u-agent-9",
};

test("mapr join：完整邀请 URL 注册成功，.env 与 policy.json 0600 落盘且输出不泄密", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-join-"));
  const state: FakeHubState = {
    registerCalls: [],
    nonceCalls: [],
    pollCalls: [],
    registerResponse: { status: 200, body: CONSUMED },
    pollResponses: [],
  };
  const server = fakeInviteHub(state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const code = await runCli(
      ["join", `http://127.0.0.1:${port}/rooms/room-9?invite=tok-join-1`, "--state-dir", dir, "--name", "云端小助手"],
      { stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) }
    );
    assert.equal(code, 0);
    assert.deepEqual(stderr, []);

    // nonce 请求形态：action/resource/address 齐全且地址是小写 0x+40hex
    assert.equal(state.nonceCalls.length, 1);
    assert.equal(state.nonceCalls[0].action, "invite-agent-register");
    assert.equal(state.nonceCalls[0].resource, "tok-join-1");
    assert.match(state.nonceCalls[0].address, /^0x[0-9a-f]{40}$/);

    // 注册请求形态：地址 + nonce + 0x 签名 + display_name
    assert.equal(state.registerCalls.length, 1);
    const reg = state.registerCalls[0];
    assert.equal(reg.xmtp_address, state.nonceCalls[0].address);
    assert.match(reg.signature, /^0x[0-9a-f]{130}$/);
    assert.equal(reg.display_name, "云端小助手");

    // stdout 只含安全字段：不含 64hex 私钥、令牌、签名
    const out = JSON.parse(stdout.join(""));
    assert.equal(out.status, "consumed");
    assert.equal(out.seat_id, "seat-9");
    assert.equal(out.room_id, "room-9");
    const outStr = stdout.join("");
    assert.doesNotMatch(outStr, /[0-9a-fA-F]{64}/);
    assert.equal(outStr.includes("agent-tok-9"), false);
    assert.equal(outStr.includes(reg.signature), false);

    // .env：0600 + 全量席位配置
    const envFile = path.join(dir, ".env");
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    const envText = await readFile(envFile, "utf8");
    for (const needle of [
      "XMTP_WALLET_KEY=0x",
      "XMTP_DB_ENCRYPTION_KEY=0x",
      "MAPR_SEAT_ID=seat-9",
      "MAPR_AGENT_TOKEN=agent-tok-9",
      `MAPR_HUB_URL=http://127.0.0.1:${port}`,
      "HUB_ROOM_ID=room-9",
      "HUB_TOKEN=agent-tok-9",
      "XMTP_GROUP_ID=group-9",
      "XMTP_ALLOW_GROUP_MEMBERS=1",
    ]) {
      assert.ok(envText.includes(needle), needle);
    }

    // policy.json：0600 + approved_scopes 落成本机 actor 建议 ask；硬禁区被滤掉
    const policyFile = path.join(dir, ".state", "policy.json");
    assert.equal((await stat(policyFile)).mode & 0o777, 0o600);
    const policy = JSON.parse(await readFile(policyFile, "utf8"));
    const actorRules = policy.rules.actors[state.nonceCalls[0].address];
    assert.equal(actorRules["task.run"], "ask");
    assert.equal(actorRules["gmail.send"], "ask");
    assert.equal(actorRules["payment.send"], undefined, "hard-forbidden scope must be filtered");
  } finally {
    server.close();
  }
});

test("mapr join：pending 时用签名 GET 轮询直到 consumed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-join-pending-"));
  const state: FakeHubState = {
    registerCalls: [],
    nonceCalls: [],
    pollCalls: [],
    registerResponse: { status: 200, body: { status: "pending", redemption_id: "red-1" } },
    pollResponses: [
      { status: 200, body: { status: "pending", redemption_id: "red-1" } },
      { status: 200, body: CONSUMED },
    ],
  };
  const server = fakeInviteHub(state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const stdout: string[] = [];
  try {
    const code = await runCli(
      ["join", "tok-join-1", "--hub", `http://127.0.0.1:${port}`, "--state-dir", dir, "--wait", "10", "--poll", "50"],
      { stdout: (m) => stdout.push(m), stderr: () => {} }
    );
    assert.equal(code, 0);
    assert.equal(state.pollCalls.length, 2);
    assert.equal(state.nonceCalls.length, 3);
    for (const [index, { url, headers }] of state.pollCalls.entries()) {
      assert.equal(url.search, "");
      assert.equal(headers["x-mapr-address"], state.nonceCalls[index + 1].address);
      assert.equal(headers["x-mapr-nonce"], `nonce-${index + 2}`);
      const signature = headers["x-mapr-signature"];
      assert.ok(typeof signature === "string");
      assert.match(signature, /^0x[0-9a-f]{130}$/);
    }
    const out = JSON.parse(stdout.join(""));
    assert.equal(out.status, "consumed");
    const envText = await readFile(path.join(dir, ".env"), "utf8");
    assert.ok(envText.includes("MAPR_SEAT_ID=seat-9"));
  } finally {
    server.close();
  }
});

test("mapr join：审批被拒（409）时干净退出且不落盘令牌", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-join-denied-"));
  const state: FakeHubState = {
    registerCalls: [],
    nonceCalls: [],
    pollCalls: [],
    registerResponse: { status: 200, body: { status: "pending", redemption_id: "red-1" } },
    pollResponses: [{ status: 409, body: { detail: "Redemption request was denied" } }],
  };
  const server = fakeInviteHub(state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const stderr: string[] = [];
  try {
    const code = await runCli(
      ["join", "tok-join-1", "--hub", `http://127.0.0.1:${port}`, "--state-dir", dir, "--wait", "10", "--poll", "50", "--json"],
      { stdout: () => {}, stderr: (m) => stderr.push(m) }
    );
    assert.equal(code, 1);
    const err = JSON.parse(stderr.join(""));
    assert.equal(err.reason, "register_failed");
    assert.equal(err.status, 409);
    await assert.rejects(() => stat(path.join(dir, ".env")), ".env must not be written on denial");
  } finally {
    server.close();
  }
});

test("mapr join：邀请 URL 无 token 时报 invite_token_not_found", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-join-bad-"));
  const stderr: string[] = [];
  const code = await runCli(["join", "https://hub.example/rooms/r-1", "--state-dir", dir, "--json"], {
    stdout: () => {},
    stderr: (m) => stderr.push(m),
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr.join("")).reason, "invite_token_not_found");
});

test("mapr join：410 提示链接已过期或失效，pending 明确等待房主审批", async () => {
  await withoutMaprJson(async () => {
    const expiredDir = await mkdtemp(path.join(os.tmpdir(), "mapr-join-expired-"));
    const expiredState: FakeHubState = {
      registerCalls: [],
      nonceCalls: [],
      pollCalls: [],
      registerResponse: { status: 410, body: { detail: "Invite token expired" } },
      pollResponses: [],
    };
    const expiredServer = fakeInviteHub(expiredState);
    await new Promise<void>((resolve) => expiredServer.listen(0, "127.0.0.1", resolve));
    const expiredPort = (expiredServer.address() as AddressInfo).port;
    try {
      const stderr: string[] = [];
      const code = await runCli(
        ["join", "tok-join-1", "--hub", `http://127.0.0.1:${expiredPort}`, "--state-dir", expiredDir, "--wait", "0"],
        { stdout: () => {}, stderr: (m) => stderr.push(m) }
      );
      assert.equal(code, 1);
      assert.match(stderr.join("\n"), /链接已过期或失效/);
    } finally {
      expiredServer.close();
    }

    const pendingDir = await mkdtemp(path.join(os.tmpdir(), "mapr-join-waiting-"));
    const pendingState: FakeHubState = {
      registerCalls: [],
      nonceCalls: [],
      pollCalls: [],
      registerResponse: { status: 200, body: { status: "pending", redemption_id: "red-wait" } },
      pollResponses: [],
    };
    const pendingServer = fakeInviteHub(pendingState);
    await new Promise<void>((resolve) => pendingServer.listen(0, "127.0.0.1", resolve));
    const pendingPort = (pendingServer.address() as AddressInfo).port;
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(
        ["join", "tok-join-1", "--hub", `http://127.0.0.1:${pendingPort}`, "--state-dir", pendingDir, "--wait", "0"],
        { stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) }
      );
      assert.equal(code, 0);
      assert.match(stderr.join("\n"), /等待房主审批/);
      assert.equal(JSON.parse(stdout.join("")).status, "pending");
    } finally {
      pendingServer.close();
    }
  });
});

type TestWithAfter = { after: (fn: () => unknown) => void };

async function writeExecutable(file: string, body: string): Promise<void> {
  await writeFile(file, body, "utf8");
  await chmod(file, 0o755);
}

async function makeInstallHarness(t: TestWithAfter, nodeVersion?: string): Promise<{ bin: string; home: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mapr-install-sh-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });

  const tools: Record<string, string> = {
    uname: "#!/bin/sh\necho Linux\n",
    date: "#!/bin/sh\necho 0\n",
    curl: "#!/bin/sh\nexit 0\n",
    tar: "#!/bin/sh\nexit 0\n",
    npm: "#!/bin/sh\nexit 0\n",
    sed: "#!/bin/sh\nexec /usr/bin/sed \"$@\"\n",
  };
  if (nodeVersion) {
    tools.node = `#!/bin/sh\necho v${nodeVersion}\n`;
  }
  for (const [name, body] of Object.entries(tools)) {
    await writeExecutable(path.join(bin, name), body);
  }
  return { bin, home };
}

function runInstallSh(harness: { bin: string; home: string }) {
  const script = path.resolve(import.meta.dirname, "../../../frontend/public/install.sh");
  return spawnSync("/bin/sh", [script, "--pair", "mpc_test", "--hub", "https://hub.example"], {
    env: { PATH: harness.bin, HOME: harness.home, TMPDIR: os.tmpdir() },
    encoding: "utf8",
  });
}

test("install.sh 在无 Node 的 PATH 中实跑：给出一条可复制的自救命令并非零退出", async (t) => {
  const harness = await makeInstallHarness(t);
  const result = runInstallSh(harness);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /检测不到 Node\.js/);
  assert.match(result.stderr, /复制这一行安装 Node 22/);
  assert.match(result.stderr, /curl -fsSL 'https:\/\/hub\.example\/install\.sh' \| sh -s -- --auto-install-node/);
  assert.match(result.stderr, /--pair 'mpc_test'/);
  assert.match(result.stderr, /装完后，重新粘贴刚才那条 Parlor 配对命令即可继续/);
});

test("install.sh 在低版本 Node 的 PATH 中实跑：说明当前版本并给出自救命令", async (t) => {
  const harness = await makeInstallHarness(t, "20.9.0");
  const result = runInstallSh(harness);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node\.js 版本太低（当前 v20\.9\.0，需要 >= 22\.6）/);
  assert.match(result.stderr, /--auto-install-node/);
  assert.match(result.stderr, /装完后，重新粘贴刚才那条 Parlor 配对命令即可继续/);
});

test("install.sh 优先利用本机已有的 brew、fnm 或 nvm 给出对应安装命令", async (t) => {
  const scenarios = [
    { name: "brew", expected: /brew install node/ },
    { name: "fnm", expected: /fnm install 22 && fnm use 22/ },
    { name: "nvm", expected: /nvm install 22/ },
  ];
  for (const scenario of scenarios) {
    const harness = await makeInstallHarness(t);
    if (scenario.name === "brew" || scenario.name === "fnm") {
      await writeExecutable(path.join(harness.bin, scenario.name), "#!/bin/sh\nexit 0\n");
    } else {
      await mkdir(path.join(harness.home, ".nvm"), { recursive: true });
      await writeFile(path.join(harness.home, ".nvm", "nvm.sh"), "# nvm test fixture\n", "utf8");
    }
    const result = runInstallSh(harness);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, scenario.expected, `${scenario.name} should be detected`);
  }
});

test("install.ps1 缺 Node 指引包含 winget 一键命令和重新配对步骤", async () => {
  const script = path.resolve(import.meta.dirname, "../../../frontend/public/install.ps1");
  const text = await readFile(script, "utf8");
  assert.match(text, /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(text, /装完后，关闭并重新打开 PowerShell，然后重新粘贴刚才那条 Parlor 配对命令即可继续/);
  assert.match(text, /Show-NodeSetupGuidance "检测不到 Node\.js。"/);
  assert.match(text, /Show-NodeSetupGuidance "Node\.js 版本太低/);
});
