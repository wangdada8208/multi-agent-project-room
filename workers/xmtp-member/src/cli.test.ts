import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { runCli } from "./cli.ts";

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
      ["join", "tok-join-1", "--hub", `http://127.0.0.1:${port}`, "--state-dir", dir, "--wait", "10", "--poll", "50"],
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
  const code = await runCli(["join", "https://hub.example/rooms/r-1", "--state-dir", dir], {
    stdout: () => {},
    stderr: (m) => stderr.push(m),
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr.join("")).reason, "invite_token_not_found");
});

