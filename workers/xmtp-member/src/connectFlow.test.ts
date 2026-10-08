import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  buildConnectAuthorizeUrl,
  parseConnectRequestFromUrl,
  type ConnectRequest,
} from "./connectSdk.ts";
import { ConsentQueue } from "./consentQueue.ts";
import { verifyGrant } from "./grant.ts";
import type { LedgerEntry } from "./ledger.ts";
import { createOwnerConsoleServer } from "./ownerConsole.ts";

const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

async function setupConnectGateway() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-connect-flow-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const ledger: LedgerEntry[] = [];

  const mockCalendar = {
    id: "mock-calendar",
    scopes: ["calendar.free_busy"],
    fetch: async (_scope: string, _constraints: any) => ({
      scope: "calendar.free_busy",
      date_from: "2026-10-05",
      date_to: "2026-10-09",
      busy: [{ start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T10:00:00.000Z" }],
    }),
  };

  const mockEmail = {
    id: "mock-receipt",
    scopes: ["email.receipt"],
    fetch: async (_scope: string, _constraints: any) => ({
      scope: "email.receipt",
      subject: "12306 铁路电子客票通知",
      sent_at: "2026-10-06T08:30:00.000Z",
      attachment_name: "receipt.pdf",
      attachment_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      body_excerpt: "北京南至上海虹桥 G102 车票已出，联系方式 [PHONE] [EMAIL]",
    }),
  };

  const server = createOwnerConsoleServer({
    selfAddress: OWNER,
    privateKey: OWNER_KEY,
    queue,
    connectors: [mockCalendar, mockEmail],
    readLedger: async () => ledger,
    readInbox: async () => [],
    readOwnerNotes: async () => [],
    appendLedger: async (e) => {
      ledger.push(e);
    },
    approve: async () => ({ ok: true }),
    deny: async () => ({ ok: true }),
    sendRequest: async () => ({ ok: true }),
    sendTask: async () => ({ ok: true }),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { server, baseUrl, ledger };
}

test("End-to-End: third-party flight app requests calendar via Connect with MAPR, verifies Grant and receives busy slots", async () => {
  const { server, baseUrl, ledger } = await setupConnectGateway();

  try {
    // 1. 第三方应用构造授权请求
    const req: ConnectRequest = {
      app_id: "flight-booking-app",
      scope: "calendar.free_busy",
      purpose: "查询空闲时间以预订商务机票",
      redirect_uri: "https://booking.example.com/callback",
      constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
    };

    const authUrl = buildConnectAuthorizeUrl(baseUrl, req);
    const parsed = parseConnectRequestFromUrl(authUrl);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    // 2. 模拟主人打开授权页面
    const pageRes = await fetch(authUrl);
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();
    assert.equal(html.includes('document.getElementById("app-id").textContent = appId'), true);
    assert.equal(html.includes('document.getElementById("scope").textContent = scope'), true);

    // 3. 主人点击允许一次 (POST /api/connect/approve)
    const approveRes = await fetch(`${baseUrl}/api/connect/approve`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", "Content-Type": "application/json" },
      body: JSON.stringify(parsed.request),
    });
    assert.equal(approveRes.status, 200);
    const approveData = await approveRes.json();
    assert.equal(approveData.ok, true);
    assert.ok(approveData.grant);
    assert.ok(approveData.signature);
    assert.ok(approveData.payload);

    // 4. 验证账本记录
    assert.equal(
      ledger.some((e) => e.kind === "consent_approved" && e.peer === "flight-booking-app"),
      true
    );

    // 5. 第三方应用在 callback 处解析并核验 Grant 密码学签名
    const verifyResult = await verifyGrant({
      grant: approveData.grant,
      signature: approveData.signature,
      expectedOwner: OWNER,
      expectedAudience: "flight-booking-app",
      payload: approveData.payload,
      now: new Date(),
    });
    assert.deepEqual(verifyResult, { ok: true });

    // 6. 验证恶意中间人篡改数据时验签失败
    const tamperedPayload = { ...approveData.payload, busy: [] };
    const tamperedVerify = await verifyGrant({
      grant: approveData.grant,
      signature: approveData.signature,
      expectedOwner: OWNER,
      expectedAudience: "flight-booking-app",
      payload: tamperedPayload,
      now: new Date(),
    });
    assert.deepEqual(tamperedVerify, { ok: false, reason: "payload_mismatch" });
  } finally {
    server.close();
  }
});

test("End-to-End: third-party expense app requests email.receipt, receives sanitized data, and tests user denial", async () => {
  const { server, baseUrl, ledger } = await setupConnectGateway();

  try {
    // 1. 申请火车票收据
    const req: ConnectRequest = {
      app_id: "expense-report-app",
      scope: "email.receipt",
      purpose: "自动报销火车票",
      redirect_uri: "https://expense.example.com/callback",
      constraints: { query: "from:12306", date_from: "2026-10-01", date_to: "2026-10-10" },
    };

    const authUrl = buildConnectAuthorizeUrl(baseUrl, req);

    // 2. 主人授权成功
    const approveRes = await fetch(`${baseUrl}/api/connect/approve`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    assert.equal(approveRes.status, 200);
    const approveData = await approveRes.json();
    assert.equal(approveData.ok, true);
    assert.equal(approveData.payload.scope, "email.receipt");
    assert.equal(approveData.payload.subject, "12306 铁路电子客票通知");
    assert.equal(approveData.payload.body_excerpt.includes("[PHONE]"), true);
    assert.equal(approveData.payload.body_excerpt.includes("[EMAIL]"), true);

    // 3. 第三方应用验签
    const verifyReceipt = await verifyGrant({
      grant: approveData.grant,
      signature: approveData.signature,
      expectedOwner: OWNER,
      expectedAudience: "expense-report-app",
      payload: approveData.payload,
      now: new Date(),
    });
    assert.deepEqual(verifyReceipt, { ok: true });

    // 4. 模拟主人点击拒绝 (POST /api/connect/deny)
    const denyRes = await fetch(`${baseUrl}/api/connect/deny`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    assert.equal(denyRes.status, 200);
    const denyData = await denyRes.json();
    assert.equal(denyData.ok, false);
    assert.equal(denyData.reason, "user_denied");
    assert.equal(denyData.redirect_url, "https://expense.example.com/callback#error=user_denied");

    // 5. 验证账本中记录了拒发
    assert.equal(
      ledger.some((e) => e.kind === "consent_denied" && e.peer === "expense-report-app"),
      true
    );
  } finally {
    server.close();
  }
});
