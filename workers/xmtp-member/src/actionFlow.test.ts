import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  approveConsent,
  denyConsent,
  persistCrashRecoveryReceipts,
  resendPendingReceipts,
  resendReceipt,
  type ConsentActionDeps,
  MAX_RECEIPT_RESENDS,
} from "./consentActions.ts";
import { ConsentQueue } from "./consentQueue.ts";
import { decodeEnvelope, encodeEnvelope, type ActionResultEnvelope } from "./envelope.ts";
import { buildGrant, hashPayload, signActionResult, signGrant, verifyGrant } from "./grant.ts";
import { handleEnvelope, type HandleEnvelopeDeps } from "./handleEnvelope.ts";
import type { LedgerEntry } from "./ledger.ts";
import { OutgoingRequests } from "./outgoingRequests.ts";
import { normalizePolicy } from "./policy.ts";
import type { Connector } from "./connectors/types.ts";

// Hardhat 公开测试账号；A 是 worker 本机（有 gmail.send 连接器），B 是请求方，C 是攻击者。
const A_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const B_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const C_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const A = privateKeyToAccount(A_KEY).address.toLowerCase();
const B = privateKeyToAccount(B_KEY).address.toLowerCase();
const C = privateKeyToAccount(C_KEY).address.toLowerCase();
const NOW = new Date("2026-11-19T12:00:00Z");
const PARAMS = { to: ["boss@x.com"], subject: "周五汇报", body: "本周进展…" };

function fakeConnector(overrides?: {
  execute?: (action: string, params: Record<string, unknown>) => Promise<{ status: "executed" | "failed" | "uncertain"; external_id?: string; summary?: string }>;
}, calls?: { scope: string; params: Record<string, unknown> }[]): Connector {
  return {
    id: "fake-gmail",
    scopes: ["gmail.send"],
    fetch: async () => ({}),
    execute: async (scope, params) => {
      calls?.push({ scope, params });
      if (overrides?.execute) return overrides.execute(scope, params);
      return { status: "executed", external_id: "g-1", summary: "sent" };
    },
  };
}

async function setup(input?: {
  rules?: unknown;
  allow?: Record<string, string[]>;
  execute?: (action: string, params: Record<string, unknown>) => Promise<any>;
  sendFails?: boolean;
  connectors?: Connector[];
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "act-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const bQueue = new ConsentQueue(path.join(dir, "b-consents.json"));
  const outgoing = new OutgoingRequests(path.join(dir, "outgoing.json"));
  const bOutgoing = new OutgoingRequests(path.join(dir, "b-outgoing.json"));
  await outgoing.load();
  await bOutgoing.load();
  const ledger: LedgerEntry[] = [];
  const bLedger: LedgerEntry[] = [];
  const sent: string[] = [];
  const executions: { scope: string; params: Record<string, unknown> }[] = [];
  const storedResults: ActionResultEnvelope[] = [];
  const connectors =
    input?.connectors !== undefined ? input.connectors : [fakeConnector(input?.execute ? { execute: input.execute } : undefined, executions)];

  const send = async (_id: string, text: string) => {
    // sendFails 只让回执发送失败（consent_pending 照发）——模拟执行后传输挂掉的窗口。
    if (input?.sendFails && text.includes('"action_result"')) throw new Error("xmtp down");
    sent.push(text);
  };
  const appendLedger = async (e: LedgerEntry) => {
    ledger.push(e);
  };
  const actionDeps: ConsentActionDeps = {
    selfAddress: A,
    privateKey: A_KEY,
    queue,
    connectors,
    send,
    appendLedger,
    now: () => NOW,
  };
  const deps: HandleEnvelopeDeps = {
    selfAddress: A,
    policy: normalizePolicy({ allow: input?.allow ?? {}, rules: input?.rules ?? [] }),
    queue,
    send,
    appendLedger,
    storeDisclosure: async () => true,
    canExecuteAction: (action) =>
      connectors.some((c) => c.scopes.includes(action) && typeof c.execute === "function"),
    autoApprove: (id) => approveConsent(id, actionDeps),
    outgoing,
    now: () => NOW,
  };
  const bDeps: HandleEnvelopeDeps = {
    selfAddress: B,
    policy: normalizePolicy({ allow: { [A]: ["task.run"] } }),
    queue: bQueue,
    send: async (_id, text) => {
      sent.push(text);
    },
    appendLedger: async (e) => {
      bLedger.push(e);
    },
    storeDisclosure: async () => true,
    storeActionResult: async (env) => {
      storedResults.push(env);
      return true;
    },
    outgoing: bOutgoing,
    now: () => NOW,
  };
  return {
    deps, actionDeps, queue, outgoing, ledger, sent, executions, connectors,
    bDeps, bQueue, bOutgoing, bLedger, storedResults, dir,
  };
}

function actionRequest(overrides?: {
  params?: Record<string, unknown>;
  action?: string;
  request_id?: string;
  to?: string;
}) {
  return decodeEnvelope(
    encodeEnvelope({
      kind: "action_request",
      request_id: overrides?.request_id ?? "act-1",
      to: overrides?.to ?? A,
      action: overrides?.action ?? "gmail.send",
      params: overrides?.params ?? PARAMS,
      purpose: "代发周报",
    })
  )!;
}

/** 用 buildGrant+signGrant+signActionResult 造一个「签名本身合法」的 action_result。 */
async function signedResult(input: {
  key: string;
  requestId?: string;
  to: string;
  scope?: string;
  params?: Record<string, unknown>;
  paramsHashOverride?: string;
  status?: "executed" | "failed" | "uncertain";
  receipt?: string;
  summary?: string;
}): Promise<ActionResultEnvelope> {
  const owner = privateKeyToAccount(input.key as `0x${string}`).address.toLowerCase();
  const grant = buildGrant({
    owner,
    audience: input.to,
    requestId: input.requestId ?? "act-1",
    scope: input.scope ?? "gmail.send",
    constraints: { date_from: "", date_to: "" },
    payload: input.params ?? PARAMS,
    now: NOW,
  });
  const signature = await signGrant(grant, input.key);
  const paramsHash = input.paramsHashOverride ?? grant.payload_hash;
  const resultSignature = await signActionResult(
    {
      grant_id: grant.grant_id,
      request_id: input.requestId ?? "act-1",
      params_hash: paramsHash,
      status: input.status ?? "executed",
      receipt: input.receipt,
      summary: input.summary ?? "done",
    },
    input.key
  );
  return decodeEnvelope(
    encodeEnvelope({
      kind: "action_result",
      request_id: input.requestId ?? "act-1",
      to: input.to,
      grant,
      signature,
      params_hash: paramsHash,
      status: input.status ?? "executed",
      receipt: input.receipt,
      summary: input.summary ?? "done",
      result_signature: resultSignature,
    })
  ) as ActionResultEnvelope;
}

async function registerBRequest(s: Awaited<ReturnType<typeof setup>>, to = A) {
  // B 这边登记「我向 A 发过 act-1」——之后的回执只允许 A 给。
  await s.bOutgoing.register({
    request_id: "act-1",
    to,
    kind: "action",
    scope: "gmail.send",
    params_hash: hashPayload(PARAMS),
    created_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
  });
}

// ── 队列与批准 ────────────────────────────────────────────────────

test("action_request is queued as pending; consent_pending reaches the requester", async () => {
  const s = await setup();
  const outcome = await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  assert.equal(outcome, "queued");
  const item = s.queue.get("act-1")!;
  assert.equal(item.status, "pending");
  assert.equal(item.kind, "action");
  assert.equal(item.params_hash, hashPayload(PARAMS));
  const pending = decodeEnvelope(s.sent[0])!;
  assert.equal(pending.kind, "consent_pending");
  assert.equal(pending.request_id, "act-1");
  // B 收到 consent_pending：登记匹配 → noted；冒充者发的同名 pending → 拒
  await registerBRequest(s);
  assert.equal(
    await handleEnvelope({ envelope: pending, sender: A, conversationId: "g1" }, s.bDeps),
    "noted"
  );
  assert.equal(
    await handleEnvelope({ envelope: pending, sender: C, conversationId: "g1" }, s.bDeps),
    "rejected"
  );
});

test("deny sends a plain denial; no execution happens", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  assert.deepEqual(await denyConsent("act-1", "owner_denied", s.actionDeps), { ok: true });
  const denial = decodeEnvelope(s.sent.at(-1)!)!;
  assert.deepEqual(denial, { kind: "denial", request_id: "act-1", to: B, reason: "owner_denied" });
  assert.equal(s.executions.length, 0);
  // B 端：登记过的请求收到 denial → noted；第三方伪造 denial → rejected
  await registerBRequest(s);
  assert.equal(
    await handleEnvelope({ envelope: denial, sender: A, conversationId: "g1" }, s.bDeps),
    "noted"
  );
  const forged = decodeEnvelope(encodeEnvelope({ kind: "denial", request_id: "act-1", to: B, reason: "cannot" }))!;
  assert.equal(
    await handleEnvelope({ envelope: forged, sender: C, conversationId: "g1" }, s.bDeps),
    "rejected"
  );
});

// ── 批准 → 执行 → 签名回执 ────────────────────────────────────────

test("approve executes the connector once and sends a verifiable action_result", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  assert.deepEqual(await approveConsent("act-1", s.actionDeps), { ok: true });
  assert.equal(s.executions.length, 1);
  assert.equal(s.executions[0].scope, "gmail.send");
  assert.deepEqual(s.executions[0].params.to, ["boss@x.com"]);
  assert.equal(s.queue.get("act-1")?.status, "completed");

  const result = decodeEnvelope(s.sent.at(-1)!) as ActionResultEnvelope;
  assert.equal(result.kind, "action_result");
  assert.equal(result.status, "executed");
  const check = await verifyGrant({
    grant: result.grant,
    signature: result.signature,
    expectedOwner: A,
    expectedAudience: B,
    expectedPayloadHash: result.params_hash,
    now: new Date(NOW.getTime() + 1000),
  });
  assert.equal(check.ok, true);

  // B 收到回执：登记 + 签名 + 参数哈希全匹配 → stored
  await registerBRequest(s);
  assert.equal(
    await handleEnvelope({ envelope: result, sender: A, conversationId: "g1" }, s.bDeps),
    "stored"
  );
  assert.equal(s.storedResults.length, 1);
});

test("allow-tier action auto-executes without waiting for a human click", async () => {
  const s = await setup({ rules: { actors: { [B]: { "gmail.send": "allow" } } } });
  const outcome = await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  assert.equal(outcome, "auto_approved");
  assert.equal(s.queue.get("act-1")?.status, "completed");
  assert.equal(s.executions.length, 1);
  const result = decodeEnvelope(s.sent.at(-1)!)!;
  assert.equal(result.kind, "action_result");
  assert.equal(result.status, "executed");
  assert.ok(s.ledger.some((e) => e.kind === "auto_approved"));
});

test("scope casing/whitespace is normalized: ' GMAIL.SEND ' hits the same rule and connector", async () => {
  const s = await setup({ rules: { actors: { [B]: { "gmail.send": "allow" } } } });
  const env = decodeEnvelope(
    encodeEnvelope({
      kind: "action_request",
      request_id: "act-9",
      to: A,
      action: "  GMAIL.SEND  ",
      params: PARAMS,
      purpose: "x",
    })
  )!;
  assert.equal(env.kind === "action_request" ? env.action : null, "gmail.send");
  const outcome = await handleEnvelope({ envelope: env, sender: B, conversationId: "g1" }, s.deps);
  assert.equal(outcome, "auto_approved");
});

// ── 伪造与出站登记匹配 ────────────────────────────────────────────

test("an action_result with no outbound registration is rejected", async () => {
  const s = await setup();
  const forged = await signedResult({ key: C_KEY, to: B });
  const outcome = await handleEnvelope({ envelope: forged, sender: C, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.kind, "action_result_rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "unknown_request");
});

test("action_result is rejected when response verification has no outbound registry", async () => {
  const s = await setup();
  const forged = await signedResult({ key: A_KEY, to: B });
  const outcome = await handleEnvelope(
    { envelope: forged, sender: A, conversationId: "g1" },
    { ...s.bDeps, outgoing: undefined }
  );
  assert.equal(outcome, "rejected");
  assert.equal(s.storedResults.length, 0);
});

test("attacker self-signing a valid grant for a REAL request_id is rejected (wrong_responder)", async () => {
  const s = await setup();
  await registerBRequest(s); // act-1 的预期响应者是 A
  // C 偷看 request_id 后给自己签一个完全合法的 grant —— 签名本身能通过 verifyGrant
  const forged = await signedResult({ key: C_KEY, to: B });
  const outcome = await handleEnvelope({ envelope: forged, sender: C, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "wrong_responder");
  assert.equal(s.storedResults.length, 0);
});

test("wrong scope in the grant is rejected (scope_mismatch)", async () => {
  const s = await setup();
  await registerBRequest(s);
  // A 自己签——但 grant.scope 被换成 calendar.read
  const bad = await signedResult({ key: A_KEY, to: B, scope: "calendar.read" });
  const outcome = await handleEnvelope({ envelope: bad, sender: A, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "scope_mismatch");
});

test("result whose params_hash does not match the registered request is rejected", async () => {
  const s = await setup();
  await registerBRequest(s); // 登记的是 hash(PARAMS)
  // A 对篡改后的参数签名——grant.payload_hash ≠ 登记的 params_hash
  const bad = await signedResult({
    key: A_KEY,
    to: B,
    params: { to: ["attacker@x.com"], subject: "周五汇报", body: "x" },
  });
  const outcome = await handleEnvelope({ envelope: bad, sender: A, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "hash_mismatch");
});

test("expired outbound request no longer accepts responses", async () => {
  const s = await setup();
  await s.bOutgoing.register({
    request_id: "act-1",
    to: A,
    kind: "action",
    scope: "gmail.send",
    params_hash: hashPayload(PARAMS),
    created_at: "2026-11-19T10:00:00.000Z",
    expires_at: "2026-11-19T11:00:00.000Z", // 已过期
  });
  const result = await signedResult({ key: A_KEY, to: B });
  const outcome = await handleEnvelope({ envelope: result, sender: A, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "request_expired");
});

test("bad signature is rejected even when the request is registered", async () => {
  const s = await setup();
  await registerBRequest(s);
  // C 给 owner=A 的 grant 签名——verifyMessage 必失败
  const grant = buildGrant({
    owner: A, audience: B, requestId: "act-1", scope: "gmail.send",
    constraints: { date_from: "", date_to: "" }, payload: PARAMS, now: NOW,
  });
  const signature = await signGrant({ ...grant, owner: C }, C_KEY);
  const forged = decodeEnvelope(
    encodeEnvelope({
      kind: "action_result", request_id: "act-1", to: B,
      grant, signature, params_hash: grant.payload_hash, status: "executed",
      result_signature: "0x" + "11".repeat(65),
    })
  )!;
  const outcome = await handleEnvelope({ envelope: forged, sender: A, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "bad_signature");
});

test("duplicate action_result is idempotent: first wins, repeat is dropped", async () => {
  const s = await setup();
  await registerBRequest(s);
  const result = await signedResult({ key: A_KEY, to: B });
  assert.equal(await handleEnvelope({ envelope: result, sender: A, conversationId: "g1" }, s.bDeps), "stored");
  const ledgers = s.bLedger.length;
  assert.equal(await handleEnvelope({ envelope: result, sender: A, conversationId: "g1" }, s.bDeps), "duplicate");
  assert.equal(s.bLedger.length, ledgers); // 重复响应不再记副作用
  assert.equal(s.storedResults.length, 1);
});

test("an action_result can be retried when inbox persistence fails before completion", async () => {
  const s = await setup();
  await registerBRequest(s);
  let attempts = 0;
  s.bDeps.storeActionResult = async (env) => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk full");
    s.storedResults.push(env);
    return true;
  };
  const result = await signedResult({ key: A_KEY, to: B });
  await assert.rejects(
    handleEnvelope({ envelope: result, sender: A, conversationId: "g1" }, s.bDeps),
    /disk full/
  );
  assert.equal(await handleEnvelope({ envelope: result, sender: A, conversationId: "g1" }, s.bDeps), "stored");
  assert.equal(attempts, 2);
  assert.equal(s.storedResults.length, 1);
  assert.ok(s.bOutgoing.get("act-1")?.responded_at);
});

test("a terminal denial makes a later action_result idempotent", async () => {
  const s = await setup();
  await registerBRequest(s);
  const denial = decodeEnvelope(
    encodeEnvelope({ kind: "denial", request_id: "act-1", to: B, reason: "owner_denied" })
  )!;
  assert.equal(await handleEnvelope({ envelope: denial, sender: A, conversationId: "g1" }, s.bDeps), "noted");
  const result = await signedResult({ key: A_KEY, to: B });
  assert.equal(await handleEnvelope({ envelope: result, sender: A, conversationId: "g1" }, s.bDeps), "duplicate");
  assert.equal(s.storedResults.length, 0);
});

// ── 执行失败、回执失败与恢复 ──────────────────────────────────────

test("connector failure marks the action uncertain; receipt reports uncertain, never retried", async () => {
  const s = await setup({
    execute: async () => {
      throw new Error("connector exploded");
    },
  });
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  const res = await approveConsent("act-1", s.actionDeps);
  assert.equal(res.ok, true); // 回执照常送达，只是 status=uncertain
  assert.equal(s.queue.get("act-1")?.status, "uncertain");
  const result = decodeEnvelope(s.sent.at(-1)!) as ActionResultEnvelope;
  assert.equal(result.kind, "action_result");
  assert.equal(result.status, "uncertain");
  assert.equal(s.executions.length, 1); // 绝不自动重放
});

test("autoApprove send failure stays truthful: awaiting_receipt, no fake pending notice", async () => {
  const s = await setup({ sendFails: true, rules: { actors: { [B]: { "gmail.send": "allow" } } } });
  const outcome = await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  assert.equal(outcome, "auto_failed");
  assert.equal(s.queue.get("act-1")?.status, "awaiting_receipt");
  assert.equal(s.executions.length, 1);
  assert.ok(s.sent.every((t) => decodeEnvelope(t)?.kind !== "consent_pending"));
  assert.ok(s.ledger.some((e) => e.kind === "auto_approve_failed"));
});

test("receipt resend after send failure does NOT re-execute the connector", async () => {
  const s = await setup({ sendFails: true });
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  const res = await approveConsent("act-1", s.actionDeps);
  assert.equal(res.ok, false);
  assert.equal(s.queue.get("act-1")?.status, "awaiting_receipt");
  assert.equal(s.executions.length, 1);

  s.actionDeps.send = async (_id, text) => {
    s.sent.push(text);
  };
  assert.deepEqual(await resendReceipt("act-1", s.actionDeps), { ok: true });
  assert.equal(s.executions.length, 1); // 关键：重发只发 outbox，不重跑 connector
  assert.equal(s.queue.get("act-1")?.status, "completed");
  const result = decodeEnvelope(s.sent.at(-1)!)!;
  assert.equal(result.kind, "action_result");
});

test("a revoked requester cannot trigger disclosure or result receipt resends", async () => {
  const s = await setup({ sendFails: true });
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  await approveConsent("act-1", s.actionDeps);
  assert.equal(s.queue.get("act-1")?.status, "awaiting_receipt");
  s.actionDeps.send = async (_id, text) => {
    s.sent.push(text);
  };
  const sentBefore = s.sent.length;
  assert.deepEqual(
    await resendReceipt("act-1", {
      ...s.actionDeps,
      isRequesterRevoked: (address, conversationId) => address === B && conversationId === "g1",
    }),
    { ok: false, reason: "requester_revoked" }
  );
  assert.equal(s.sent.length, sentBefore);
  assert.equal(s.executions.length, 1);
  assert.equal(s.queue.get("act-1")?.status, "awaiting_receipt");
});

test("revocation in another conversation does not block a receipt resend", async () => {
  const s = await setup({ sendFails: true });
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  await approveConsent("act-1", s.actionDeps);
  s.actionDeps.send = async (_id, text) => {
    s.sent.push(text);
  };
  assert.deepEqual(
    await resendReceipt("act-1", {
      ...s.actionDeps,
      isRequesterRevoked: (address, conversationId) => address === B && conversationId === "other-group",
    }),
    { ok: true }
  );
  assert.equal(s.executions.length, 1);
  assert.equal(s.queue.get("act-1")?.status, "completed");
});

test("resend is bounded by MAX_RECEIPT_RESENDS", async () => {
  const s = await setup({ sendFails: true });
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  await approveConsent("act-1", s.actionDeps);
  for (let i = 0; i < MAX_RECEIPT_RESENDS; i++) {
    assert.equal((await resendReceipt("act-1", s.actionDeps)).ok, false);
  }
  assert.deepEqual(await resendReceipt("act-1", s.actionDeps), { ok: false, reason: "resend_cap" });
});

test("params tampered between queue and approve → denied, never executed", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  // 手改队列里存的参数（模拟本地状态被篡改）
  (s.queue as any).items.find((i: any) => i.request_id === "act-1").params = { to: ["attacker@x.com"] };
  const res = await approveConsent("act-1", s.actionDeps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "params_tampered");
  assert.equal(s.queue.get("act-1")?.status, "denied");
  assert.equal(s.executions.length, 0);
  assert.ok(s.ledger.some((e) => e.kind === "action_tampered"));
});

test("autoApprove with no connector releases back to pending instead of a fake failure", async () => {
  const s = await setup({ rules: { actors: { [B]: { "gmail.send": "allow" } } }, connectors: [] });
  delete s.deps.canExecuteAction; // 跳过前置可服务性检查，直接落到 runApprovedAction 的 no_connector
  const outcome = await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  assert.equal(outcome, "queued"); // 没连接器 → 释放回 pending 等人工，不是假失败
  assert.equal(s.queue.get("act-1")?.status, "pending");
  const pending = decodeEnvelope(s.sent.at(-1)!)!;
  assert.equal(pending.kind, "consent_pending");
});

test("action_request for an action nobody can execute is denied up front", async () => {
  const s = await setup();
  const outcome = await handleEnvelope(
    { envelope: actionRequest({ action: "bitcoin.transfer" }), sender: B, conversationId: "g1" },
    s.deps
  );
  assert.equal(outcome, "denied");
  const denial = decodeEnvelope(s.sent.at(-1)!)!;
  assert.equal(denial.kind === "denial" ? denial.reason : null, "out_of_scope");
});

test("queue-full action_request gets a 'busy' denial, not a silent drop", async () => {
  const s = await setup();
  for (let i = 0; i < 50; i++) {
    await s.queue.add({
      request_id: `f-${i}`,
      requester: B,
      conversation_id: "g1",
      scope: "gmail.send",
      purpose: "x",
      constraints: { date_from: "", date_to: "" },
      created_at: NOW.toISOString(),
      kind: "action",
    });
  }
  const outcome = await handleEnvelope(
    { envelope: actionRequest({ request_id: "act-overflow" }), sender: B, conversationId: "g1" },
    s.deps
  );
  assert.equal(outcome, "denied");
  const denial = decodeEnvelope(s.sent.at(-1)!)!;
  assert.equal(denial.kind === "denial" ? denial.reason : null, "busy");
});

test("malformed/oversized params are rejected at decode before reaching the queue", async () => {
  let deep: Record<string, unknown> = { a: 1 };
  for (let i = 0; i < 20; i++) deep = { nest: deep };
  const tooDeep = encodeEnvelope({
    kind: "action_request", request_id: "act-deep", to: A,
    action: "gmail.send", params: deep, purpose: "x",
  });
  assert.equal(decodeEnvelope(tooDeep), null);
  const tooWide: Record<string, unknown> = {};
  for (let i = 0; i < 200; i++) tooWide[`k${i}`] = i;
  const wide = encodeEnvelope({
    kind: "action_request", request_id: "act-wide", to: A,
    action: "gmail.send", params: tooWide, purpose: "x",
  });
  assert.equal(decodeEnvelope(wide), null);
});

test("crash between executing and receipt → restart marks uncertain, never re-executes", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  // 模拟「attempt 已落盘，进程死在 connector 执行窗口」
  await s.queue.claim("act-1", "approved");
  await s.queue.transition("act-1", "executing", new Date(), { attempt_at: new Date().toISOString() });

  const q2 = new ConsentQueue(path.join(s.dir, "consents.json"));
  await q2.load();
  const recovered = await q2.recoverAfterLoad();
  assert.equal(recovered[0].request_id, "act-1");
  assert.equal(q2.get("act-1")?.status, "uncertain");
  assert.equal(await q2.transition("act-1", "executing"), null); // 终态不可回
});

// ── M1：崩溃恢复补签 uncertain 回执 ─────────────────────────────

test("M1: recovery persists a signed uncertain action_result; resend delivers it without re-executing", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  await s.queue.claim("act-1", "approved");
  await s.queue.transition("act-1", "executing", new Date(), { attempt_at: new Date().toISOString() });

  // 模拟重启：新队列实例 recover → uncertain，补签回执，resend 送达。
  const q2 = new ConsentQueue(path.join(s.dir, "consents.json"));
  await q2.load();
  const recovered = await q2.recoverAfterLoad();
  const deps2 = { ...s.actionDeps, queue: q2 };
  assert.equal(await persistCrashRecoveryReceipts(recovered, deps2), 1);

  const item = q2.get("act-1")!;
  assert.equal(item.status, "uncertain"); // 终态：绝不重回执行轨道
  assert.equal(item.result_status, "uncertain");
  assert.equal(item.result_summary, "execution_interrupted_verify_manually");
  const env = decodeEnvelope(item.outbox!) as ActionResultEnvelope;
  assert.equal(env.kind, "action_result");
  assert.equal(env.status, "uncertain");
  assert.equal(env.summary, "execution_interrupted_verify_manually");
  assert.equal(env.request_id, "act-1");
  assert.equal(env.to, B);
  assert.equal(env.params_hash, hashPayload(PARAMS));
  const check = await verifyGrant({
    grant: env.grant,
    signature: env.signature,
    expectedOwner: A,
    expectedAudience: B,
    expectedPayloadHash: env.params_hash,
    now: NOW,
  });
  assert.equal(check.ok, true);

  // 送达后清 outbox；连接器全程零执行
  assert.deepEqual(await resendReceipt("act-1", deps2), { ok: true });
  assert.equal(q2.get("act-1")?.status, "uncertain");
  assert.equal(q2.get("act-1")?.outbox, undefined);
  assert.equal(s.executions.length, 0);
  assert.equal((decodeEnvelope(s.sent.at(-1)!) as any).kind, "action_result");
  // B 端按正常验签流程收下这份 uncertain 回执
  await registerBRequest(s);
  assert.equal(
    await handleEnvelope({ envelope: env, sender: A, conversationId: "g1" }, s.bDeps),
    "stored"
  );
});

test("M1: recovery skips local-source items; revoked requesters get no receipt", async () => {
  const s = await setup();
  // 本机触发来源（conversation_id=""）崩溃恢复 → 只留 uncertain，不补回执。
  await s.queue.add({
    request_id: "trig-1",
    requester: "self",
    conversation_id: "",
    scope: "gmail.send",
    purpose: "触发器候选",
    constraints: { date_from: "", date_to: "" },
    created_at: NOW.toISOString(),
    kind: "action",
    params: PARAMS,
    params_hash: hashPayload(PARAMS),
    expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
  });
  await s.queue.claim("trig-1", "approved");
  await s.queue.transition("trig-1", "executing");
  const recovered = await s.queue.recoverAfterLoad();
  assert.equal(await persistCrashRecoveryReceipts(recovered, s.actionDeps), 0);
  assert.equal(s.queue.get("trig-1")?.status, "uncertain");
  assert.equal(s.queue.get("trig-1")?.outbox, undefined);

  // 有会话但请求方已被撤 → 同样不补回执
  await handleEnvelope({ envelope: actionRequest({ request_id: "act-r" }), sender: B, conversationId: "g1" }, s.deps);
  await s.queue.claim("act-r", "approved");
  await s.queue.transition("act-r", "executing");
  const recovered2 = await s.queue.recoverAfterLoad();
  const revokedDeps = { ...s.actionDeps, isRequesterRevoked: () => true };
  assert.equal(await persistCrashRecoveryReceipts(recovered2, revokedDeps), 0);
  assert.equal(s.queue.get("act-r")?.outbox, undefined);
});

test("M1: failed uncertain resend keeps the persisted outbox; retry delivers and clears it", async () => {
  const s = await setup({ sendFails: true });
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  await s.queue.claim("act-1", "approved");
  await s.queue.transition("act-1", "executing");
  const recovered = await s.queue.recoverAfterLoad();
  assert.equal(await persistCrashRecoveryReceipts(recovered, s.actionDeps), 1);

  // 发送失败 → outbox 保留、resend_count+1、状态仍 uncertain，连接器零执行
  assert.deepEqual(await resendReceipt("act-1", s.actionDeps), { ok: false, reason: "send_failed" });
  const failed = s.queue.get("act-1")!;
  assert.equal(failed.status, "uncertain");
  assert.ok(failed.outbox);
  assert.equal(failed.resend_count, 1);
  assert.equal(s.executions.length, 0);
  assert.deepEqual(s.queue.pendingReceipts().map((i) => i.request_id), ["act-1"]);

  // 传输恢复后：批量重发送达 → outbox 清掉，退出重发口
  s.actionDeps.send = async (_id, t) => { s.sent.push(t); };
  assert.equal(await resendPendingReceipts(s.actionDeps), 1);
  assert.equal(s.queue.get("act-1")?.outbox, undefined);
  assert.equal(s.queue.get("act-1")?.status, "uncertain");
  assert.deepEqual(s.queue.pendingReceipts(), []);
  const delivered = decodeEnvelope(s.sent.at(-1)!) as ActionResultEnvelope;
  assert.equal(delivered.status, "uncertain");
});

// ── M2：grant 过期后的回执重发 ────────────────────────────────────

test("M2: resend with an expired grant re-signs a fresh grant over the same immutable result", async () => {
  const s = await setup({ sendFails: true });
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  await approveConsent("act-1", s.actionDeps); // 发送失败 → awaiting_receipt + outbox
  const oldEnv = decodeEnvelope(s.queue.get("act-1")!.outbox!) as ActionResultEnvelope;

  // 时钟拨过 grant TTL（10min）+ 刷新余量（2min）
  const later = new Date(NOW.getTime() + 13 * 60 * 1000);
  const deps2 = {
    ...s.actionDeps,
    now: () => later,
    send: async (_id: string, t: string) => { s.sent.push(t); },
  };
  assert.deepEqual(await resendReceipt("act-1", deps2), { ok: true });
  assert.equal(s.executions.length, 1); // 绝不重跑 connector

  const resent = decodeEnvelope(s.sent.at(-1)!) as ActionResultEnvelope;
  assert.equal(resent.kind, "action_result");
  assert.notEqual(resent.grant.grant_id, oldEnv.grant.grant_id); // 新 grant
  assert.equal(resent.grant.request_id, "act-1");
  assert.equal(resent.grant.scope, oldEnv.grant.scope);
  assert.equal(resent.grant.audience, oldEnv.grant.audience);
  assert.equal(resent.grant.payload_hash, oldEnv.grant.payload_hash);
  assert.ok(Date.parse(resent.grant.expires_at) > later.getTime()); // 新有效期
  // status/receipt/summary/params_hash 与持久化的不可变结果完全一致
  assert.equal(resent.status, oldEnv.status);
  assert.equal(resent.receipt, oldEnv.receipt);
  assert.equal(resent.summary, oldEnv.summary);
  assert.equal(resent.params_hash, oldEnv.params_hash);
  const check = await verifyGrant({
    grant: resent.grant,
    signature: resent.signature,
    expectedOwner: A,
    expectedAudience: B,
    expectedPayloadHash: resent.params_hash,
    now: later,
  });
  assert.equal(check.ok, true);
  assert.equal(s.queue.get("act-1")?.status, "completed");
  // B 端按登记+验签流程收下刷新后的回执
  await registerBRequest(s);
  assert.equal(
    await handleEnvelope({ envelope: resent, sender: A, conversationId: "g1" }, s.bDeps),
    "stored"
  );
});

test("M2: resend while the grant is still fresh reuses the persisted outbox verbatim", async () => {
  const s = await setup({ sendFails: true });
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  await approveConsent("act-1", s.actionDeps);
  const outbox = s.queue.get("act-1")!.outbox!;
  s.actionDeps.send = async (_id, t) => { s.sent.push(t); };
  assert.deepEqual(await resendReceipt("act-1", s.actionDeps), { ok: true });
  assert.equal(s.sent.at(-1), outbox); // 原文重发：不重签、不改写
  assert.equal(s.executions.length, 1);
});

test("hard-deny scopes are refused before any queue or connector work", async () => {
  const s = await setup({ allow: { [B]: ["payment.send"] } });
  const outcome = await handleEnvelope(
    { envelope: actionRequest({ action: "PAYMENT.send" }), sender: B, conversationId: "g1" },
    s.deps
  );
  assert.equal(outcome, "denied");
  const denial = decodeEnvelope(s.sent.at(-1)!)!;
  assert.equal(denial.kind === "denial" ? denial.reason : null, "cannot");
  assert.equal(s.executions.length, 0);
});

// ── 回执结果签名绑定（status/receipt/summary 防篡改）────────────────

test("tampered status on a signed action_result is rejected (bad_result_signature)", async () => {
  const s = await setup();
  await registerBRequest(s);
  const good = await signedResult({ key: A_KEY, to: B, status: "executed" });
  // MITM 把 executed 改成 failed——grant 签名仍然合法，结果签名失效。
  const tampered = decodeEnvelope(encodeEnvelope({ ...good, status: "failed" as const }))!;
  const outcome = await handleEnvelope({ envelope: tampered, sender: A, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "bad_result_signature");
  assert.equal(s.storedResults.length, 0);
});

test("tampered receipt/summary on a signed action_result is rejected", async () => {
  const s = await setup();
  await registerBRequest(s);
  const good = await signedResult({ key: A_KEY, to: B, receipt: "msg-1" });
  const tampered = decodeEnvelope(
    encodeEnvelope({ ...good, receipt: "msg-forged", summary: "已发送" })
  )!;
  const outcome = await handleEnvelope({ envelope: tampered, sender: A, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "bad_result_signature");
});

test("action_result without result_signature is rejected", async () => {
  const s = await setup();
  await registerBRequest(s);
  const good = await signedResult({ key: A_KEY, to: B });
  const unsigned = decodeEnvelope(encodeEnvelope({ ...good, result_signature: undefined }))!;
  const outcome = await handleEnvelope({ envelope: unsigned, sender: A, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "bad_result_signature");
});

test("a result signed for one request cannot be replayed onto another grant/request", async () => {
  const s = await setup();
  await registerBRequest(s);
  const first = await signedResult({ key: A_KEY, to: B });
  // 换一个 grant 但复用第一份结果签名——签名绑了 grant_id+request_id，必拒。
  const second = await signedResult({ key: A_KEY, to: B });
  const grafted = decodeEnvelope(
    encodeEnvelope({ ...second, result_signature: first.result_signature })
  )!;
  const outcome = await handleEnvelope({ envelope: grafted, sender: A, conversationId: "g1" }, s.bDeps);
  assert.equal(outcome, "rejected");
  assert.equal(s.bLedger.at(-1)?.reason, "bad_result_signature");
});

// ── 动作参数 schema 入队前校验 ─────────────────────────────────────

test("action_request with malformed gmail.send params is denied before queueing", async () => {
  const s = await setup();
  const outcome = await handleEnvelope(
    {
      envelope: actionRequest({ params: { to: ["a@x.com\r\nBcc: evil@x.com"], subject: "s", body: "b" } }),
      sender: B,
      conversationId: "g1",
    },
    s.deps
  );
  assert.equal(outcome, "denied");
  assert.equal(s.queue.get("act-1"), null);
  const denial = decodeEnvelope(s.sent.at(-1)!)!;
  assert.equal(denial.kind === "denial" ? denial.reason : null, "out_of_scope");
  assert.match(s.ledger.at(-1)?.reason ?? "", /^invalid_params/);
});

test("action_request with unknown params keys is denied", async () => {
  const s = await setup();
  const outcome = await handleEnvelope(
    {
      envelope: actionRequest({ params: { ...PARAMS, headers: { "X-Evil": "1" } } }),
      sender: B,
      conversationId: "g1",
    },
    s.deps
  );
  assert.equal(outcome, "denied");
  assert.match(s.ledger.at(-1)?.reason ?? "", /^invalid_params:unknown_key/);
});

test("action_request for an action with no registered schema is denied (fail closed)", async () => {
  const s = await setup();
  // 伪造一个声明可执行自定义动作的连接器，但注册表里没有该动作的 schema。
  const conn: Connector = {
    id: "rogue",
    scopes: ["custom.danger"],
    fetch: async () => ({}),
    execute: async () => ({ status: "executed" }),
  };
  const outcome = await handleEnvelope(
    {
      envelope: actionRequest({ action: "custom.danger", params: { anything: true } }),
      sender: B,
      conversationId: "g1",
    },
    { ...s.deps, canExecuteAction: (a) => a === "custom.danger" }
  );
  assert.equal(outcome, "denied");
  assert.equal(conn.id, "rogue"); // 连接器从未被调用执行
  assert.match(s.ledger.at(-1)?.reason ?? "", /^invalid_params:no_schema/);
});

// ── conversation_id 空（本机触发来源，WP7 预备）─────────────────────

test("empty conversation_id executes once, skips XMTP send, still lands completed+ledger", async () => {
  const s = await setup();
  await s.queue.add({
    request_id: "trig-1",
    requester: "self",
    conversation_id: "",
    scope: "gmail.send",
    purpose: "触发器候选",
    constraints: { date_from: "", date_to: "" },
    created_at: NOW.toISOString(),
    kind: "action",
    params: PARAMS,
    params_hash: hashPayload(PARAMS),
    source: "trigger",
    expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
  });
  const res = await approveConsent("trig-1", s.actionDeps);
  assert.deepEqual(res, { ok: true });
  assert.equal(s.executions.length, 1);
  assert.equal(s.queue.get("trig-1")?.status, "completed");
  assert.equal(s.queue.get("trig-1")?.result_receipt, "g-1");
  assert.equal(s.sent.filter((t) => decodeEnvelope(t)?.kind === "action_result").length, 0);
  const finished = s.ledger.find((e) => e.kind === "action_finished");
  assert.equal(finished?.request_id, "trig-1");
  assert.equal(finished?.reason, "executed");
});

test("auth_required from the connector lands failed with an auth_required ledger reason", async () => {
  const s = await setup({
    execute: async () => ({ status: "failed", summary: "auth_required" }),
  });
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  assert.deepEqual(await approveConsent("act-1", s.actionDeps), { ok: true });
  assert.equal(s.queue.get("act-1")?.status, "completed");
  const finished = s.ledger.find((e) => e.kind === "action_finished");
  assert.equal(finished?.reason, "auth_required");
  const result = decodeEnvelope(s.sent.at(-1)!) as ActionResultEnvelope;
  assert.equal(result.status, "failed");
  assert.equal(result.summary, "auth_required");
});

test("concurrent approves execute the connector exactly once", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: actionRequest(), sender: B, conversationId: "g1" }, s.deps);
  const [r1, r2] = await Promise.all([
    approveConsent("act-1", s.actionDeps),
    approveConsent("act-1", s.actionDeps),
  ]);
  assert.equal([r1.ok, r2.ok].filter(Boolean).length, 1);
  assert.equal(s.executions.length, 1);
  assert.equal(s.queue.get("act-1")?.status, "completed");
});

// ── WP7：多账户路由与批准绑定 ────────────────────────────────────

function accountConnector(accountId: string, calls: { accountId: string; params: Record<string, unknown> }[]): Connector {
  return {
    id: `gmail-send:${accountId}`,
    scopes: ["gmail.send"],
    accountId,
    fetch: async () => ({}),
    execute: async (_action, params) => {
      calls.push({ accountId, params });
      return { status: "executed", external_id: `sent-${accountId}`, summary: "sent" };
    },
  };
}

test("two accounts sharing gmail.send route strictly by params.account", async () => {
  const calls: { accountId: string; params: Record<string, unknown> }[] = [];
  const s = await setup({
    connectors: [accountConnector("work-mail", calls), accountConnector("personal", calls)],
  });
  await handleEnvelope(
    { envelope: actionRequest({ request_id: "act-w", params: { ...PARAMS, account: "work-mail" } }), sender: B, conversationId: "g1" },
    s.deps
  );
  await handleEnvelope(
    { envelope: actionRequest({ request_id: "act-p", params: { ...PARAMS, account: "personal" } }), sender: B, conversationId: "g1" },
    s.deps
  );
  assert.equal(s.queue.get("act-w")?.account_id, "work-mail");
  assert.equal(s.queue.get("act-p")?.account_id, "personal");
  assert.deepEqual(await approveConsent("act-w", s.actionDeps), { ok: true });
  assert.deepEqual(await approveConsent("act-p", s.actionDeps), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].accountId, "work-mail");
  assert.equal(calls[1].accountId, "personal");
  assert.equal(s.queue.get("act-w")?.result_receipt, "sent-work-mail");
});

test("params.account is inside params_hash: swapping it after queue is params_tampered", async () => {
  const calls: { accountId: string; params: Record<string, unknown> }[] = [];
  const s = await setup({ connectors: [accountConnector("work-mail", calls), accountConnector("personal", calls)] });
  await handleEnvelope(
    { envelope: actionRequest({ params: { ...PARAMS, account: "work-mail" } }), sender: B, conversationId: "g1" },
    s.deps
  );
  // 手改队列里存的 params.account —— params_hash 直接对不上。
  (s.queue as any).items.find((i: any) => i.request_id === "act-1").params.account = "personal";
  const res = await approveConsent("act-1", s.actionDeps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "params_tampered");
  assert.equal(s.queue.get("act-1")?.status, "denied");
  assert.equal(calls.length, 0);
  assert.ok(s.ledger.some((e) => e.kind === "action_tampered"));
});

test("swapping the recorded account_id after queue is params_tampered (binding cannot be grafted)", async () => {
  const calls: { accountId: string; params: Record<string, unknown> }[] = [];
  const s = await setup({ connectors: [accountConnector("work-mail", calls), accountConnector("personal", calls)] });
  await handleEnvelope(
    { envelope: actionRequest({ params: { ...PARAMS, account: "work-mail" } }), sender: B, conversationId: "g1" },
    s.deps
  );
  // 不改 params（哈希仍一致），只改 account_id 字段 —— 一致性校验必须拦下。
  (s.queue as any).items.find((i: any) => i.request_id === "act-1").account_id = "personal";
  const res = await approveConsent("act-1", s.actionDeps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "params_tampered");
  assert.equal(s.queue.get("act-1")?.status, "denied");
  assert.equal(calls.length, 0);
});

test("an account-bound request with no matching connector releases to pending (no wrong-account execution)", async () => {
  const calls: { accountId: string; params: Record<string, unknown> }[] = [];
  const s = await setup({ connectors: [accountConnector("work-mail", calls)] });
  await handleEnvelope(
    { envelope: actionRequest({ params: { ...PARAMS, account: "ghost-account" } }), sender: B, conversationId: "g1" },
    s.deps
  );
  const res = await approveConsent("act-1", s.actionDeps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_connector");
  assert.equal(s.queue.get("act-1")?.status, "pending");
  assert.equal(calls.length, 0); // 绝不拿 work-mail 凭据替 ghost-account 执行
});

test("unbound connector never serves an account-bound request", async () => {
  const legacyCalls: { scope: string; params: Record<string, unknown> }[] = [];
  const s = await setup({ connectors: [fakeConnector(undefined, legacyCalls)] }); // 无 accountId
  await handleEnvelope(
    { envelope: actionRequest({ params: { ...PARAMS, account: "work-mail" } }), sender: B, conversationId: "g1" },
    s.deps
  );
  const res = await approveConsent("act-1", s.actionDeps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_connector");
  assert.equal(legacyCalls.length, 0);
});
