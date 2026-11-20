import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "./accounts.ts";
import { checkpointFromVerification, signLedgerCheckpoint } from "./activity.ts";
import { ConsentQueue } from "./consentQueue.ts";
import { denyConsent } from "./consentActions.ts";
import { appendLedger, buildLedgerEntry, verifyLedger } from "./ledger.ts";
import { createOwnerConsoleServer } from "./ownerConsole.ts";
import { normalizePolicy } from "./policy.ts";
import { TriggerStore } from "./triggers.ts";

async function start() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const calls: string[] = [];
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    queue,
    readLedger: async () => [],
    readInbox: async () => [],
    readOwnerNotes: async () => [{ self_name: "Codex", turns_seen: 1, action: "sent", block_reason: null }],
    approve: async (id) => {
      calls.push(`approve:${id}`);
      return { ok: true };
    },
    deny: async (id) => {
      calls.push(`deny:${id}`);
      return { ok: true };
    },
    sendRequest: async (body) => {
      calls.push(`request:${body.to}`);
      return { ok: true, request_id: "r" };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, calls, base: `http://127.0.0.1:${port}` };
}

test("authorize page never interpolates external HTML into the document", async () => {
  const { server, base } = await start();
  try {
    const injection = "<script>window.auditInjected=true</script>";
    for (const field of ["app_id", "scope", "purpose"]) {
      const response = await fetch(`${base}/connect/authorize?${field}=${encodeURIComponent(injection)}`);
      assert.equal((await response.text()).includes(injection), false);
      assert.equal(response.headers.get("x-frame-options"), "DENY");
    }
  } finally {
    server.close();
  }
});

test("serves the console page and state on loopback", async () => {
  const { server, base } = await start();
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal((await page.text()).includes("主人控制台"), true);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.self, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    assert.deepEqual(state.consents, []);
  } finally {
    server.close();
  }
});

test("approve without the owner header is refused", async () => {
  const { server, base, calls } = await start();
  try {
    const res = await fetch(`${base}/api/consents/req-1/approve`, { method: "POST" });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  } finally {
    server.close();
  }
});

test("approve, deny and request go through with the owner header", async () => {
  const { server, base, calls } = await start();
  try {
    const h = { "X-MAPR-Owner": "1", "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/api/consents/req-1/approve`, { method: "POST", headers: h })).status, 200);
    assert.equal((await fetch(`${base}/api/consents/req-2/deny`, { method: "POST", headers: h })).status, 200);
    const r = await fetch(`${base}/api/requests`, { method: "POST", headers: h, body: JSON.stringify({ to: "0xabc" }) });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ["approve:req-1", "deny:req-2", "request:0xabc"]);
  } finally {
    server.close();
  }
});

test("a cross-site origin is refused even with the header", async () => {
  const { server, base, calls } = await start();
  try {
    const res = await fetch(`${base}/api/consents/req-1/approve`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", Origin: "https://evil.example" },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  } finally {
    server.close();
  }
});

test("the old /owner-notes route still works", async () => {
  const { server, base } = await start();
  try {
    const body = await (await fetch(`${base}/owner-notes`)).json();
    assert.equal(body.notes.length, 1);
  } finally {
    server.close();
  }
});

test("POST /api/tasks with owner header dispatches task", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const taskCalls: any[] = [];
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    queue,
    readLedger: async () => [
      {
        at: "2026-10-01T08:00:00.000Z",
        kind: "verdict_sent",
        request_id: "t-1",
        peer: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        scope: "task.run",
        reason: "accepted",
        payload_hash: null,
      },
    ],
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
    sendTask: async (body) => {
      taskCalls.push(body);
      return { ok: true, request_id: "task-123" };
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(Array.isArray(state.scoreboard));
    assert.equal(state.scoreboard.length, 1);
    assert.equal(state.scoreboard[0].accepted, 1);

    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        goal: "测试任务",
        acceptance: ["必须通过测试"],
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.request_id, "task-123");
    assert.equal(taskCalls.length, 1);
  } finally {
    server.close();
  }
});

test("observer role returns role in state and rejects requests and tasks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-obs-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    role: "observer",
    queue,
    readLedger: async () => [],
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
    sendTask: async () => ({ ok: true }),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.role, "observer");

    const reqRes = await fetch(`${base}/api/requests`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ to: "0x123", scope: "calendar.free_busy" }),
    });
    assert.equal(reqRes.status, 403);
    const reqData = await reqRes.json();
    assert.equal(reqData.ok, false);
    assert.equal(reqData.reason, "observer_readonly");

    const taskRes = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ to: "0x123", goal: "g", acceptance: ["a"] }),
    });
    assert.equal(taskRes.status, 403);
    const taskData = await taskRes.json();
    assert.equal(taskData.ok, false);
    assert.equal(taskData.reason, "observer_readonly");
  } finally {
    server.close();
  }
});

test("/api/state redacts action params; detail endpoint needs the owner header", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-redact-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  await queue.add({
    request_id: "act-1",
    requester: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    conversation_id: "g1",
    scope: "gmail.send",
    purpose: "代发周报",
    constraints: { date_from: "", date_to: "" },
    created_at: new Date().toISOString(),
    kind: "action",
    params: { to: ["boss@x.com"], subject: "汇报", body: "秘密正文内容" },
    params_hash: "abc",
    rule_hit: "house:gmail.send=ask",
  });
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    queue,
    readLedger: async () => [],
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    const c = state.consents[0];
    assert.equal("params" in c, false);
    assert.equal("outbox" in c, false);
    assert.deepEqual(c.params_meta.keys.sort(), ["body", "subject", "to"]);
    // 正文/收件人/主题一律只给长度或条数——连截断预览都不出（L1）
    assert.equal(c.params_meta.preview.body, "[6 字符]");
    assert.equal(c.params_meta.preview.to, "[1 项]");
    assert.equal(c.params_meta.preview.subject, "[2 字符]");
    assert.equal(JSON.stringify(state).includes("秘密正文内容"), false);
    assert.equal(JSON.stringify(state).includes("boss@x.com"), false);

    // 详情端点：无 owner 头 → 403；带 owner 头 → 完整参数
    const unauth = await fetch(`${base}/api/consents/act-1`);
    assert.equal(unauth.status, 403);
    const detail = await fetch(`${base}/api/consents/act-1`, { headers: { "X-MAPR-Owner": "1" } });
    assert.equal(detail.status, 200);
    const { consent } = await detail.json();
    assert.deepEqual(consent.params.to, ["boss@x.com"]);
    assert.equal(consent.params.body, "秘密正文内容");
    const missing = await fetch(`${base}/api/consents/nope`, { headers: { "X-MAPR-Owner": "1" } });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test("L1/M3: /api/state redacts inbox payloads; /api/inbox is owner-gated", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-inbox-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const inboxEntries: import("./inbox.ts").InboxEntry[] = [
    {
      received_at: "2026-11-20T08:00:00.000Z", from: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      request_id: "r1", grant_id: "g1",
      payload: { kind: "action_result", status: "executed", receipt: "msg-secret-id", summary: "sent to boss@x.com" },
    },
    {
      received_at: "2026-11-20T08:01:00.000Z", from: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      request_id: "r2", grant_id: "g2",
      payload: { scope: "email.receipt", subject: "机密主题", sent_at: "2026-11-20T07:00:00.000Z", body_excerpt: "正文片段", attachment_name: "contract.pdf", attachment_sha256: "deadbeef" },
    },
    {
      received_at: "2026-11-20T08:02:00.000Z", from: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      request_id: "r3", grant_id: "g3",
      payload: { scope: "calendar.free_busy", date_from: "2026-10-05", date_to: "2026-10-09", busy: [{ start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T10:00:00.000Z" }] },
    },
  ];
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    queue,
    readLedger: async () => [],
    readInbox: async () => inboxEntries,
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    const raw = JSON.stringify(state.inbox);
    // 未认证 /api/state：回执 id、主题、正文片段、附件名、忙碌明细一律不透
    for (const leak of ["msg-secret-id", "机密主题", "正文片段", "contract.pdf", "boss@x.com", "09:00:00"]) {
      assert.equal(raw.includes(leak), false, leak);
    }
    // 只留安全元数据
    assert.equal(state.inbox[0].payload.status, "executed");
    assert.equal(state.inbox[0].payload.has_receipt, true);
    assert.equal(state.inbox[1].payload.has_attachment, true);
    assert.equal(state.inbox[2].payload.busy_count, 1);
    // /api/inbox：无 owner 头 → 403；带 owner 头 → 完整载荷
    assert.equal((await fetch(`${base}/api/inbox`)).status, 403);
    const full = await (await fetch(`${base}/api/inbox`, { headers: OWNER_H })).json();
    assert.equal(full.inbox[1].payload.subject, "机密主题");
    assert.equal(full.inbox[1].payload.body_excerpt, "正文片段");
    assert.equal(full.inbox[0].payload.receipt, "msg-secret-id");
  } finally {
    server.close();
  }
});

test("L1: /api/activity strips attacker-controlled key names from ledger reasons", async () => {
  const { server, base, ledgerFile } = await startWp7();
  try {
    await appendLedger(ledgerFile, buildLedgerEntry({
      now: new Date("2026-11-20T08:00:00Z"),
      kind: "request_denied",
      requestId: "r-evil",
      peer: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      scope: "gmail.send",
      reason: "invalid_params:unknown_key:evilKey<img src=x onerror=alert(1)>",
    }));
    const body = await (await fetch(`${base}/api/activity`)).json();
    const entry = body.entries[0];
    // 攻击者键名与 HTML 片段都不回显——只剩安全的固定前缀
    assert.equal(entry.reason, "invalid_params:unknown_key");
    const raw = JSON.stringify(body);
    for (const leak of ["evilKey", "<img", "onerror", "alert"]) {
      assert.equal(raw.includes(leak), false, leak);
    }
  } finally {
    server.close();
  }
});

test("L2: console page contains no dynamic innerHTML for untrusted rows", async () => {
  const { server, base } = await start();
  try {
    const text = await (await fetch(`${base}/`)).text();
    // 行级 DOM 注入面已清：不再有 innerHTML 拼接外部数据
    assert.equal(text.includes("tr.innerHTML"), false);
    assert.equal(text.includes('innerHTML = "<td>"'), false);
    // 仅存的 innerHTML 是静态表头（无可信外数据）
    for (const m of text.matchAll(/innerHTML\s*=\s*([^;]+);/g)) {
      assert.equal(m[1].includes("+"), false, m[1]);
    }
  } finally {
    server.close();
  }
});

test("M6: POST deny on an approved-not-started item succeeds; executing stays locked", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-m6-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  await queue.add({
    request_id: "act-1", requester: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    conversation_id: "g1", scope: "gmail.send", purpose: "x",
    constraints: { date_from: "", date_to: "" }, created_at: new Date().toISOString(), kind: "action",
  });
  await queue.claim("act-1", "approved");
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    queue,
    readLedger: async () => [],
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async (id) => denyConsent(id, "owner_denied", {
      selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      queue,
      connectors: [],
      send: async () => {},
      appendLedger: async () => {},
      now: () => new Date(),
    }),
    sendRequest: async () => ({ ok: true }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/consents/act-1/deny`, { method: "POST", headers: OWNER_H });
    assert.equal(res.status, 200);
    assert.equal(queue.get("act-1")?.status, "denied");
  } finally {
    server.close();
  }
});

test("POST /api/action-requests goes to the outbound action dispatcher", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-actreq-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const calls: any[] = [];
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    queue,
    readLedger: async () => [],
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
    sendActionRequest: async (body) => {
      calls.push(body);
      return { ok: true, request_id: "act-9" };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = { "X-MAPR-Owner": "1", "Content-Type": "application/json" };
  try {
    // 无 owner 头 → localGuard 拦在 403
    assert.equal(
      (await fetch(`${base}/api/action-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })).status,
      403
    );
    const res = await fetch(`${base}/api/action-requests`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        action: "gmail.send",
        params: { to: ["a@x.com"], subject: "s", body: "b" },
        purpose: "test",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).request_id, "act-9");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "gmail.send");
  } finally {
    server.close();
  }
});

test("POST /api/action-requests returns 501 when the dispatcher is not wired", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-actreq2-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    queue,
    readLedger: async () => [],
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/action-requests`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", action: "gmail.send", params: {} }),
    });
    assert.equal(res.status, 501);
  } finally {
    server.close();
  }
});

test("GET /connect/authorize serves consent page and handles approve/deny", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-connect-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const ledger: any[] = [];
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    queue,
    connectors: [
      {
        id: "mock-calendar",
        scopes: ["calendar.free_busy"],
        fetch: async () => ({
          scope: "calendar.free_busy",
          date_from: "2026-10-05",
          date_to: "2026-10-09",
          busy: [{ start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T10:00:00.000Z" }],
        }),
      },
    ],
    readLedger: async () => ledger,
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
    sendTask: async () => ({ ok: true }),
    appendLedger: async (e: any) => { ledger.push(e); },
  } as any);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const authPage = await fetch(
      `${base}/connect/authorize?app_id=trip-app&scope=calendar.free_busy&purpose=预订机票`
    );
    assert.equal(authPage.status, 200);
    const text = await authPage.text();
    assert.equal(text.includes("Connect with MAPR"), true);
    assert.equal(text.includes('document.getElementById("app-id").textContent = appId'), true);

    const approveRes = await fetch(`${base}/api/connect/approve`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: "trip-app",
        scope: "calendar.free_busy",
        purpose: "预订机票",
        constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
        redirect_uri: "https://trip.example.com/callback",
      }),
    });
    assert.equal(approveRes.status, 200);
    const approveData = await approveRes.json();
    assert.equal(approveData.ok, true);
    assert.ok(approveData.grant);
    assert.ok(approveData.signature);
    assert.deepEqual(approveData.payload.busy, [
      { start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T10:00:00.000Z" },
    ]);
    assert.ok(approveData.redirect_url.startsWith("https://trip.example.com/callback#"));

    const denyRes = await fetch(`${base}/api/connect/deny`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: "trip-app",
        scope: "calendar.free_busy",
        redirect_uri: "https://trip.example.com/callback",
      }),
    });
    assert.equal(denyRes.status, 200);
    const denyData = await denyRes.json();
    assert.equal(denyData.ok, false);
    assert.equal(denyData.reason, "user_denied");
  } finally {
    server.close();
  }
});

// ── WP7：账户 / 触发器 / 本机活动端点 ────────────────────────────

const OWNER_H = { "X-MAPR-Owner": "1", "Content-Type": "application/json" };
const SELF_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

async function startWp7() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-wp7-"));
  const credDir = path.join(dir, "credentials");
  await mkdir(credDir, { recursive: true, mode: 0o700 });
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const accounts = new AccountStore(path.join(dir, "accounts.json"));
  await accounts.load();
  const triggers = new TriggerStore(path.join(dir, "triggers.json"));
  await triggers.load();
  const ledgerFile = path.join(dir, "ledger.jsonl");
  const checkpointFile = path.join(dir, "ledger-checkpoint.json");
  const refreshed: string[] = [];
  const server = createOwnerConsoleServer({
    selfAddress: SELF_ADDR,
    queue,
    accounts,
    triggers,
    credDir,
    ledgerFile,
    ledgerCheckpointFile: checkpointFile,
    policy: normalizePolicy({ allow: {}, rules: {} }),
    onTriggersChanged: () => refreshed.push("refresh"),
    readLedger: async () => [],
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, dir, credDir, accounts, triggers, ledgerFile, checkpointFile, refreshed };
}

test("GET /api/accounts: 501 without deps, 403 without owner header, metadata only with it", async () => {
  const { server, base, accounts } = await startWp7();
  try {
    assert.equal((await fetch(`${base}/api/accounts`)).status, 403);
    assert.equal((await fetch(`${base}/api/accounts`, { headers: { Origin: "https://evil.example" } })).status, 403);
    await accounts.add({ id: "work-mail", service: "gmail", label: "工作邮箱", cred_path: "work.json" });
    const res = await fetch(`${base}/api/accounts`, { headers: OWNER_H });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.accounts, [
      { id: "work-mail", service: "gmail", label: "工作邮箱", cred_path: "work.json" },
    ]);
    // 响应里不能出现任何 secret 形状字段
    const raw = JSON.stringify(body);
    for (const key of ["token", "secret", "key", "password", "credentials"]) {
      assert.equal(raw.includes(key), false, key);
    }
  } finally {
    server.close();
  }
  // 未接线时 501
  const bare = await start();
  try {
    assert.equal((await fetch(`${bare.base}/api/accounts`, { headers: OWNER_H })).status, 501);
    assert.equal((await fetch(`${bare.base}/api/triggers`, { headers: OWNER_H })).status, 501);
    assert.equal((await fetch(`${bare.base}/api/activity`)).status, 501);
  } finally {
    bare.server.close();
  }
});

test("POST /api/accounts writes a 0600 credential file and rolls back on bad input", async () => {
  const { server, base, credDir, accounts } = await startWp7();
  try {
    // 无凭据体 → 400，不登记
    const noCred = await fetch(`${base}/api/accounts`, {
      method: "POST", headers: OWNER_H,
      body: JSON.stringify({ id: "a1", service: "gmail", label: "A", cred_path: "a.json" }),
    });
    assert.equal(noCred.status, 400);
    assert.equal(accounts.list().length, 0);
    // 非法 id / 目录穿越 cred_path / 未登记 service → 400
    for (const bad of [
      { id: "../x", service: "gmail", label: "A", cred_path: "a.json" },
      { id: "a1", service: "gmail", label: "A", cred_path: "../a.json" },
      { id: "a1", service: "gmail", label: "A", cred_path: "/etc/passwd.json" },
      { id: "a1", service: "dropbox", label: "A", cred_path: "a.json" },
    ]) {
      const res = await fetch(`${base}/api/accounts`, {
        method: "POST", headers: OWNER_H,
        body: JSON.stringify({ ...bad, credentials: { access_token: "t" } }),
      });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal(accounts.list().length, 0);
    // 正常登记 → 凭据落盘且是 0600
    const ok = await fetch(`${base}/api/accounts`, {
      method: "POST", headers: OWNER_H,
      body: JSON.stringify({
        id: "work-mail", service: "gmail", label: "工作邮箱",
        credentials: { access_token: "secret-token-value" },
      }),
    });
    assert.equal(ok.status, 200);
    const { account } = await ok.json();
    assert.equal(account.id, "work-mail");
    assert.equal(account.cred_path, "work-mail.json"); // 缺省用 id 当文件名
    assert.equal(JSON.stringify(account).includes("secret-token-value"), false);
    const st = await stat(path.join(credDir, "work-mail.json"));
    assert.equal(st.mode & 0o777, 0o600);
    // 重复 id → 409
    const dup = await fetch(`${base}/api/accounts`, {
      method: "POST", headers: OWNER_H,
      body: JSON.stringify({ id: "work-mail", service: "gmail", label: "x", credentials: { access_token: "t" } }),
    });
    assert.equal(dup.status, 409);
  } finally {
    server.close();
  }
});

test("DELETE /api/accounts/:id removes the entry and its credential file", async () => {
  const { server, base, credDir, accounts } = await startWp7();
  try {
    await fetch(`${base}/api/accounts`, {
      method: "POST", headers: OWNER_H,
      body: JSON.stringify({ id: "work-mail", service: "gmail", label: "w", credentials: { access_token: "t" } }),
    });
    assert.equal(existsSync(path.join(credDir, "work-mail.json")), true);
    assert.equal(
      (await fetch(`${base}/api/accounts/ghost`, { method: "DELETE", headers: OWNER_H })).status,
      404
    );
    const res = await fetch(`${base}/api/accounts/work-mail`, { method: "DELETE", headers: OWNER_H });
    assert.equal(res.status, 200);
    assert.equal(accounts.get("work-mail"), null);
    assert.equal(existsSync(path.join(credDir, "work-mail.json")), false);
  } finally {
    server.close();
  }
});

test("POST /api/triggers validates; hard-forbidden scope and bad template rejected; toggle works", async () => {
  const { server, base, accounts, triggers, refreshed } = await startWp7();
  try {
    await accounts.add({ id: "work-mail", service: "gmail", label: "w", cred_path: "w.json" });
    // 无 owner 头 → localGuard 403
    assert.equal(
      (await fetch(`${base}/api/triggers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status,
      403
    );
    const template = { to: ["o@x.com"], subject: "新邮件", body: "来自触发器" };
    const base_ = { enabled: true, query: "label:inbox", action_params_template: template, max_per_hour: 3, poll_interval_ms: 60000 };
    // 硬禁区动作在创建时就被 decide() 拦下
    for (const scope of ["payment.send", "data.export_all", "credentials.read"]) {
      const res = await fetch(`${base}/api/triggers`, {
        method: "POST", headers: OWNER_H,
        body: JSON.stringify({ ...base_, id: `t-${scope}`, account_id: "work-mail", action: scope }),
      });
      assert.equal(res.status, 400, scope);
      assert.match((await res.json()).reason, /^cannot:hard_cannot/);
    }
    // 不存在的账户 / 坏模板 → 400
    assert.equal(
      (await fetch(`${base}/api/triggers`, {
        method: "POST", headers: OWNER_H,
        body: JSON.stringify({ ...base_, id: "t-ghost", account_id: "ghost", action: "gmail.send" }),
      })).status,
      400
    );
    assert.equal(
      (await fetch(`${base}/api/triggers`, {
        method: "POST", headers: OWNER_H,
        body: JSON.stringify({ ...base_, id: "t-bad", account_id: "work-mail", action: "gmail.send", action_params_template: { to: ["o@x.com"] } }),
      })).status,
      400
    );
    assert.equal(triggers.list().length, 0);
    // 合法创建 → 200 + 引擎刷新回调
    const ok = await fetch(`${base}/api/triggers`, {
      method: "POST", headers: OWNER_H,
      body: JSON.stringify({ ...base_, id: "invoice-watch", account_id: "work-mail", action: "gmail.send" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(refreshed.length, 1);
    // GET 列表：seen_ids 不回传，只给条数
    const list = await (await fetch(`${base}/api/triggers`, { headers: OWNER_H })).json();
    assert.equal(list.triggers.length, 1);
    assert.equal("seen_ids" in list.triggers[0], false);
    assert.equal(list.triggers[0].seen_count, 0);
    // 重复 id → 409
    assert.equal(
      (await fetch(`${base}/api/triggers`, {
        method: "POST", headers: OWNER_H,
        body: JSON.stringify({ ...base_, id: "invoice-watch", account_id: "work-mail", action: "gmail.send" }),
      })).status,
      409
    );
    // toggle 关 → 开
    const off = await (await fetch(`${base}/api/triggers/invoice-watch/toggle`, { method: "POST", headers: OWNER_H, body: "{}" })).json();
    assert.equal(off.enabled, false);
    assert.equal(triggers.get("invoice-watch")?.enabled, false);
    const on = await (await fetch(`${base}/api/triggers/invoice-watch/toggle`, { method: "POST", headers: OWNER_H, body: JSON.stringify({ enabled: true }) })).json();
    assert.equal(on.enabled, true);
    assert.equal((await fetch(`${base}/api/triggers/ghost/toggle`, { method: "POST", headers: OWNER_H, body: "{}" })).status, 404);
    assert.equal(refreshed.length, 3);
  } finally {
    server.close();
  }
});

test("GET /api/activity filters and reports hash-chain integrity", async () => {
  const { server, base, ledgerFile } = await startWp7();
  try {
    const peer = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    await appendLedger(ledgerFile, buildLedgerEntry({
      now: new Date("2026-11-20T08:00:00Z"), kind: "action_queued", requestId: "r-1", peer, scope: "gmail.send",
    }));
    await appendLedger(ledgerFile, buildLedgerEntry({
      now: new Date("2026-11-20T09:00:00Z"), kind: "action_finished", requestId: "r-1", peer, scope: "gmail.send", reason: "executed",
    }));
    await appendLedger(ledgerFile, buildLedgerEntry({
      now: new Date("2026-11-20T10:00:00Z"), kind: "request_denied", requestId: "r-2", peer: "0xother", scope: "gmail.send", reason: "trigger:house:gmail.send=cannot",
    }));

    const all = await (await fetch(`${base}/api/activity`)).json();
    assert.equal(all.ok, true);
    assert.equal(all.total, 3);
    assert.equal(all.entries.length, 3);
    assert.equal(all.integrity.ok, true);
    assert.equal(all.integrity.total_lines, 3);
    assert.equal(all.integrity.chained_entries, 3);
    assert.equal(all.integrity.legacy_unverified_entries, 0);
    assert.deepEqual(all.integrity.issues, []);
    assert.equal(all.integrity.head?.seq, 3);
    assert.ok(all.integrity.head?.entry_hash);

    // kind 过滤
    const queued = await (await fetch(`${base}/api/activity?kind=action_queued`)).json();
    assert.equal(queued.entries.length, 1);
    assert.equal(queued.entries[0].request_id, "r-1");
    // status 过滤（denied 类）
    const denied = await (await fetch(`${base}/api/activity?status=denied`)).json();
    assert.equal(denied.entries.length, 1);
    assert.equal(denied.entries[0].request_id, "r-2");
    // actor 过滤
    const actor = await (await fetch(`${base}/api/activity?actor=${peer}`)).json();
    assert.equal(actor.entries.length, 2);
    // since/until/limit
    const window_ = await (await fetch(`${base}/api/activity?since=2026-11-20T08:30:00Z&until=2026-11-20T10:00:00Z`)).json();
    assert.equal(window_.entries.length, 2);
    const limited = await (await fetch(`${base}/api/activity?limit=1`)).json();
    assert.equal(limited.entries.length, 1);
    assert.equal(limited.entries[0].request_id, "r-2"); // limit 取最近
    assert.equal(limited.total, 3);
    // 非法查询参数 → 400
    assert.equal((await fetch(`${base}/api/activity?limit=-1`)).status, 400);
    assert.equal((await fetch(`${base}/api/activity?limit=abc`)).status, 400);
    assert.equal((await fetch(`${base}/api/activity?since=not-a-date`)).status, 400);
    // 跨站 origin 被 localGuard 拦在门外
    assert.equal((await fetch(`${base}/api/activity`, { headers: { Origin: "https://evil.example" } })).status, 403);
  } finally {
    server.close();
  }
});

test("M5: /api/activity anchors verification to the local signed checkpoint", async () => {
  const { server, base, ledgerFile, checkpointFile } = await startWp7();
  const SELF_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const peer = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  try {
    // 无锚点文件 → 无锚校验，行为不变
    const unanchored = await (await fetch(`${base}/api/activity`)).json();
    assert.equal(unanchored.integrity.ok, true);

    for (let i = 0; i < 3; i++) {
      await appendLedger(ledgerFile, buildLedgerEntry({
        now: new Date(`2026-11-20T08:0${i}:00Z`), kind: "action_queued", requestId: `r-${i}`, peer, scope: "gmail.send",
      }));
    }
    // 本机签名锚点：与链一致 → ok
    const verification = await verifyLedger(ledgerFile);
    const checkpoint = await signLedgerCheckpoint(
      checkpointFromVerification(verification, { room_id: "room-1", stream_id: SELF_ADDR }),
      SELF_KEY
    );
    await writeFile(checkpointFile, JSON.stringify(checkpoint));
    const good = await (await fetch(`${base}/api/activity`)).json();
    assert.equal(good.integrity.ok, true);

    // 截断到账本锚点之前 → anchor_truncated 主动检出
    const lines = (await readFile(ledgerFile, "utf8")).trim().split("\n");
    await writeFile(ledgerFile, lines.slice(0, 2).join("\n") + "\n");
    const truncated = await (await fetch(`${base}/api/activity`)).json();
    assert.equal(truncated.integrity.ok, false);
    assert.ok(truncated.integrity.issues.some((i: any) => i.code === "anchor_truncated"));

    // 锚点后改写：在截断链上重挂一条新 seq3 → entry_hash 与锚点 head_hash 不符
    await appendLedger(ledgerFile, buildLedgerEntry({
      now: new Date("2026-11-20T09:00:00Z"), kind: "action_finished", requestId: "r-2", peer, scope: "gmail.send",
    }));
    const tampered = await (await fetch(`${base}/api/activity`)).json();
    assert.equal(tampered.integrity.ok, false);
    assert.ok(tampered.integrity.issues.some((i: any) => i.code === "anchor_hash_mismatch"));

    // 伪造锚点（他人私钥签名）→ 直接无视，降级无锚校验，不误报
    const forged = await signLedgerCheckpoint(
      { room_id: "room-1", stream_id: "x", head_seq: 999, head_hash: "0".repeat(64), entry_count: 999 },
      OTHER_KEY
    );
    await writeFile(checkpointFile, JSON.stringify(forged));
    const degraded = await (await fetch(`${base}/api/activity`)).json();
    assert.equal(degraded.integrity.issues.some((i: any) => i.code === "anchor_truncated"), false);
  } finally {
    server.close();
  }
});

test("L7: deleting an account keeps a credential file still referenced by another", async () => {
  const { server, base, credDir, accounts } = await startWp7();
  try {
    const shared = path.join(credDir, "shared.json");
    await writeFile(shared, JSON.stringify({ access_token: "t" }));
    await accounts.add({ id: "a1", service: "gmail", label: "A1", cred_path: "shared.json" });
    await accounts.add({ id: "a2", service: "gmail", label: "A2", cred_path: "shared.json" });
    // 删 a1：a2 还引用 shared.json → 凭据文件保留
    assert.equal(
      (await fetch(`${base}/api/accounts/a1`, { method: "DELETE", headers: OWNER_H })).status,
      200
    );
    assert.equal(accounts.get("a1"), null);
    assert.equal(existsSync(shared), true);
    // 删掉最后一个引用 → 凭据文件才清
    assert.equal(
      (await fetch(`${base}/api/accounts/a2`, { method: "DELETE", headers: OWNER_H })).status,
      200
    );
    assert.equal(existsSync(shared), false);
  } finally {
    server.close();
  }
});

test("observer role cannot create accounts or triggers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-wp7obs-"));
  const credDir = path.join(dir, "credentials");
  await mkdir(credDir, { recursive: true });
  const accounts = new AccountStore(path.join(dir, "accounts.json"));
  await accounts.load();
  const triggers = new TriggerStore(path.join(dir, "triggers.json"));
  await triggers.load();
  const server = createOwnerConsoleServer({
    selfAddress: SELF_ADDR,
    role: "observer",
    queue: new ConsentQueue(path.join(dir, "consents.json")),
    accounts,
    triggers,
    credDir,
    policy: normalizePolicy({ allow: {}, rules: {} }),
    readLedger: async () => [],
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // GET 放行（只读）
    assert.equal((await fetch(`${base}/api/accounts`, { headers: OWNER_H })).status, 200);
    assert.equal((await fetch(`${base}/api/triggers`, { headers: OWNER_H })).status, 200);
    // 写一律 observer_readonly
    for (const [url, body] of [
      ["/api/accounts", { id: "a", service: "gmail", label: "l", credentials: { access_token: "t" } }],
      ["/api/triggers", { id: "t", enabled: true, account_id: "a", query: "q", action: "gmail.send", action_params_template: {}, max_per_hour: 1, poll_interval_ms: 60000 }],
    ] as const) {
      const res = await fetch(`${base}${url}`, { method: "POST", headers: OWNER_H, body: JSON.stringify(body) });
      assert.equal(res.status, 403, url);
      assert.equal((await res.json()).reason, "observer_readonly");
    }
    assert.equal(accounts.list().length, 0);
    assert.equal(triggers.list().length, 0);
  } finally {
    server.close();
  }
});


