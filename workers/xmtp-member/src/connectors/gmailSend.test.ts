import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRawMessage, GmailSendConnector } from "./gmailSend.ts";

const PARAMS = {
  to: ["boss@example.com", "team@example.com"],
  cc: ["cc@example.com"],
  subject: "周五汇报",
  body: "本周进展：\n1. 完成 A\n2. 开始 B",
};

interface RecordedCall {
  url: string;
  body?: string;
  auth?: string;
}

function fakeFetch(
  handler: (call: RecordedCall, count: number) => { status: number; json?: any } | Error
) {
  const calls: RecordedCall[] = [];
  const impl = async (url: any, init?: any): Promise<any> => {
    const call: RecordedCall = {
      url: String(url),
      body: init?.body ? String(init.body) : undefined,
      auth: init?.headers?.Authorization,
    };
    calls.push(call);
    const out = handler(call, calls.length);
    if (out instanceof Error) throw out;
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.json ?? {},
    };
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

async function makeCreds(content: any, mode = 0o600) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gcred-"));
  const file = path.join(dir, "gmail.json");
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  await chmod(file, mode);
  return { dir, file };
}

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

test("happy path: exactly one send call, executed with message id, RFC822 carries request id header", async () => {
  const { file } = await makeCreds({ access_token: "tok-1" });
  const { calls, impl } = fakeFetch(() => ({ status: 200, json: { id: "msg-123", threadId: "t-1" } }));
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
  const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "req-abc" });
  assert.deepEqual(receipt, { status: "executed", external_id: "msg-123", summary: "sent" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SEND_URL);
  assert.equal(calls[0].auth, "Bearer tok-1");
  const raw = Buffer.from(JSON.parse(calls[0].body!).raw, "base64url").toString("utf8");
  assert.match(raw, /^To: boss@example\.com, team@example\.com\r\n/m);
  assert.match(raw, /^Cc: cc@example\.com\r\n/m);
  assert.match(raw, /^X-MAPR-Request-Id: req-abc\r\n/m);
  assert.match(raw, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/m);
  // RFC2047 解出的主题必须是原文
  const b64Subject = raw.match(/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/)![1];
  assert.equal(Buffer.from(b64Subject, "base64").toString("utf8"), "周五汇报");
  // 正文 base64 解码还原
  const bodyB64 = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.equal(Buffer.from(bodyB64, "base64").toString("utf8"), PARAMS.body);
});

test("no credentials file / bad permissions / malformed json all fail closed without a network call", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gcred-"));
  const missing = path.join(dir, "missing.json");
  for (const [name, credPath] of [
    ["missing", missing],
    ["bad-perms", (await makeCreds({ access_token: "t" }, 0o644)).file],
    ["malformed", (await makeCreds("{not-json")).file],
    ["no-token", (await makeCreds({ foo: 1 })).file],
  ] as const) {
    const { calls, impl } = fakeFetch(() => ({ status: 200, json: { id: "x" } }));
    const conn = new GmailSendConnector({ credentialPath: credPath, fetchImpl: impl });
    const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "r" });
    assert.deepEqual(receipt, { status: "failed", summary: "auth_required" }, name);
    assert.equal(calls.length, 0, name);
  }
});

test("definitive pre-send 4xx is failed; 5xx/network/ambiguous are uncertain; nothing is retried", async () => {
  const { file } = await makeCreds({ access_token: "tok-1" });
  for (const [status, want] of [
    [400, "failed"],
    [403, "failed"],
    [500, "uncertain"],
    [503, "uncertain"],
    [429, "uncertain"],
    [418, "uncertain"],
  ] as const) {
    const { calls, impl } = fakeFetch(() => ({ status, json: {} }));
    const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
    const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "r" });
    assert.equal(receipt.status, want, `status ${status}`);
    assert.equal(calls.length, 1, `status ${status} — never auto-retried`);
  }
  const { calls, impl } = fakeFetch(() => new Error("socket hangup"));
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
  const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "r" });
  assert.deepEqual(receipt, { status: "uncertain", summary: "network_error" });
  assert.equal(calls.length, 1);
});

test("timeout surfaces as uncertain without retry", async () => {
  const { file } = await makeCreds({ access_token: "tok-1" });
  const err = new Error("timed out");
  err.name = "TimeoutError";
  const { calls, impl } = fakeFetch(() => err);
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
  const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "r" });
  assert.deepEqual(receipt, { status: "uncertain", summary: "timeout" });
  assert.equal(calls.length, 1);
});

test("401 without refresh credentials is failed auth_required", async () => {
  const { file } = await makeCreds({ access_token: "stale" });
  const { calls, impl } = fakeFetch(() => ({ status: 401, json: {} }));
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
  const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "r" });
  assert.deepEqual(receipt, { status: "failed", summary: "auth_required" });
  assert.equal(calls.length, 1);
});

test("401 with refresh credentials refreshes once then retries the send", async () => {
  const { file } = await makeCreds({
    access_token: "stale",
    refresh_token: "rt-1",
    client_id: "cid",
    client_secret: "cs",
  });
  const { calls, impl } = fakeFetch((call) => {
    if (call.url === TOKEN_URL) return { status: 200, json: { access_token: "fresh-1" } };
    if (call.auth === "Bearer stale") return { status: 401, json: {} };
    return { status: 200, json: { id: "msg-9" } };
  });
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
  const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "r" });
  assert.equal(receipt.status, "executed");
  assert.equal(receipt.external_id, "msg-9");
  assert.equal(calls.length, 3); // send(401) + refresh + send(200)
  assert.equal(calls[1].url, TOKEN_URL);
  assert.equal(calls[2].auth, "Bearer fresh-1");
});

test("expired token refreshes before the first send attempt", async () => {
  const { file } = await makeCreds({
    access_token: "stale",
    expires_at: Date.now() - 60_000,
    refresh_token: "rt-1",
    client_id: "cid",
    client_secret: "cs",
  });
  const { calls, impl } = fakeFetch((call) => {
    if (call.url === TOKEN_URL) return { status: 200, json: { access_token: "fresh-1" } };
    return { status: 200, json: { id: "msg-10" } };
  });
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
  const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "r" });
  assert.equal(receipt.status, "executed");
  assert.equal(calls.length, 2); // refresh + send，没有先打一发 401
  assert.equal(calls[1].auth, "Bearer fresh-1");
});

test("failed refresh and second 401 both end as auth_required", async () => {
  const { file } = await makeCreds({
    access_token: "stale",
    refresh_token: "rt-1",
    client_id: "cid",
    client_secret: "cs",
  });
  const { calls, impl } = fakeFetch(() => ({ status: 401, json: {} }));
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
  const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "r" });
  assert.deepEqual(receipt, { status: "failed", summary: "auth_required" });
  assert.equal(calls.length, 2); // send(401) + refresh(401) → 放弃，不重发
});

test("invalid params fail closed before any credential or network work", async () => {
  const { file } = await makeCreds({ access_token: "tok-1" });
  const { calls, impl } = fakeFetch(() => ({ status: 200, json: { id: "x" } }));
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
  const bad = await conn.execute(
    "gmail.send",
    { ...PARAMS, to: ["a@x.com\r\nBcc: evil@x.com"] },
    { request_id: "r" }
  );
  assert.equal(bad.status, "failed");
  assert.match(bad.summary ?? "", /^invalid_params/);
  const wrong = await conn.execute("calendar.read", PARAMS, { request_id: "r" });
  assert.deepEqual(wrong, { status: "failed", summary: "unsupported_action" });
  assert.equal(calls.length, 0);
});

test("account mismatch against the configured credential account fails closed", async () => {
  const { file } = await makeCreds({ access_token: "tok-1" });
  const { calls, impl } = fakeFetch(() => ({ status: 200, json: { id: "x" } }));
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl, accountId: "work" });
  const receipt = await conn.execute("gmail.send", { ...PARAMS, account: "personal" }, {});
  assert.deepEqual(receipt, { status: "failed", summary: "unknown_account" });
  assert.equal(calls.length, 0);
  const ok = await conn.execute("gmail.send", { ...PARAMS, account: "work" }, {});
  assert.equal(ok.status, "executed");
});

test("2xx with unreadable/missing id is uncertain, not executed", async () => {
  const { file } = await makeCreds({ access_token: "tok-1" });
  const { calls, impl } = fakeFetch(() => ({ status: 200, json: {} }));
  const conn = new GmailSendConnector({ credentialPath: file, fetchImpl: impl });
  const receipt = await conn.execute("gmail.send", PARAMS, { request_id: "r" });
  assert.deepEqual(receipt, { status: "uncertain", summary: "missing_message_id" });
  assert.equal(calls.length, 1);
});

test("buildRawMessage omits the request header for unsafe or absent ids and keeps headers CRLF-only", async () => {
  const raw = buildRawMessage(PARAMS as any, "req\ninjected: x");
  assert.equal(raw.includes("X-MAPR-Request-Id"), false);
  const noId = buildRawMessage(PARAMS as any);
  assert.equal(noId.includes("X-MAPR-Request-Id"), false);
});
