import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approveConsent, denyConsent, expireDue, type ConsentActionDeps } from "./consentActions.ts";
import { ConsentQueue } from "./consentQueue.ts";
import { decodeEnvelope, encodeEnvelope, type DisclosureEnvelope, type RequestEnvelope } from "./envelope.ts";
import { handleEnvelope, type HandleEnvelopeDeps } from "./handleEnvelope.ts";
import type { LedgerEntry } from "./ledger.ts";
import { normalizePolicy } from "./policy.ts";
import { OutgoingRequests } from "./outgoingRequests.ts";

// Hardhat 公开测试账号，只用于单元测试。
const B_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const B = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // 被请求方（日历主人）
const A = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"; // 请求方
const NOW = new Date("2026-10-01T08:00:00Z");

const calendar = [
  { start: "2026-10-06T09:00:00Z", end: "2026-10-06T10:00:00Z", title: "和律师谈离婚协议", notes: "带上房产证" },
];

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flow-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const sent: { conv: string; text: string }[] = [];
  const ledger: LedgerEntry[] = [];
  const stored: DisclosureEnvelope[] = [];
  const send = async (conv: string, text: string) => {
    sent.push({ conv, text });
  };
  const appendLedger = async (e: LedgerEntry) => {
    ledger.push(e);
  };
  const aOutgoing = new OutgoingRequests(path.join(dir, "a-outgoing.json"));
  await aOutgoing.load();
  const bDeps: HandleEnvelopeDeps = {
    selfAddress: B,
    policy: normalizePolicy({ allow: { [A]: ["calendar.free_busy"] } }),
    queue,
    send,
    appendLedger,
    storeDisclosure: async () => true,
    now: () => NOW,
  };
  const bActions: ConsentActionDeps = {
    selfAddress: B,
    privateKey: B_KEY,
    queue,
    loadCalendar: async () => calendar,
    send,
    appendLedger,
    now: () => NOW,
  };
  const aDeps: HandleEnvelopeDeps = {
    selfAddress: A,
    policy: normalizePolicy({}),
    queue: new ConsentQueue(path.join(dir, "a-consents.json")),
    send,
    appendLedger,
    storeDisclosure: async (d) => {
      stored.push(d);
      return true;
    },
    outgoing: aOutgoing,
    now: () => NOW,
  };
  return { queue, sent, ledger, stored, bDeps, bActions, aDeps, aOutgoing };
}

const request: RequestEnvelope = {
  kind: "request",
  request_id: "req-1",
  to: B,
  scope: "calendar.free_busy",
  purpose: "约下周的会",
  constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
};

async function registerARequest(s: Awaited<ReturnType<typeof setup>>) {
  await s.aOutgoing.register({
    request_id: request.request_id,
    to: B,
    kind: "data",
    scope: request.scope,
    created_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
  });
}

test("approval checks expiry synchronously without waiting for cleanup timer", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  const sentBefore = s.sent.length;
  const result = await approveConsent(request.request_id, {
    ...s.bActions, now: () => new Date(NOW.getTime() + 10 * 60 * 1000),
  });
  assert.equal(result.ok, false);
  assert.equal(s.queue.get(request.request_id)?.status, "expired");
  assert.equal(s.sent.slice(sentBefore).some(m => decodeEnvelope(m.text)?.kind === "disclosure"), false);
});

test("request not addressed to me is ignored and nothing is sent", async () => {
  const s = await setup();
  const outcome = await handleEnvelope({ envelope: { ...request, to: A }, sender: A, conversationId: "c1" }, s.bDeps);
  assert.equal(outcome, "ignored");
  assert.equal(s.sent.length, 0);
});

test("out-of-scope follow-up is denied automatically without asking the owner", async () => {
  const s = await setup();
  const outcome = await handleEnvelope(
    { envelope: { ...request, scope: "calendar.attendees" }, sender: A, conversationId: "c1" },
    s.bDeps
  );
  assert.equal(outcome, "denied");
  assert.equal(s.queue.list().length, 0);
  assert.deepEqual(decodeEnvelope(s.sent[0].text), { kind: "denial", request_id: "req-1", to: A, reason: "out_of_scope" });
});

test("allowed request is queued and the group is told it is pending", async () => {
  const s = await setup();
  const outcome = await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  assert.equal(outcome, "queued");
  assert.equal(s.queue.get("req-1")?.status, "pending");
  assert.equal(decodeEnvelope(s.sent[0].text)?.kind, "consent_pending");
  const again = await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  assert.equal(again, "duplicate");
});

test("approve sends only busy slots; the requester verifies and stores it", async () => {
  const s = await setup();
  await registerARequest(s);
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  const result = await approveConsent("req-1", s.bActions);
  assert.deepEqual(result, { ok: true });
  assert.equal(s.queue.get("req-1")?.status, "completed");
  const disclosureText = s.sent.find((m) => decodeEnvelope(m.text)?.kind === "disclosure")?.text;
  assert.ok(disclosureText);
  for (const secret of ["约下周的会", "律师", "房产证"]) {
    assert.equal(disclosureText.includes(secret), false, secret);
  }
  const disclosure = decodeEnvelope(disclosureText)!;
  assert.equal(disclosure.kind, "disclosure");
  const outcome = await handleEnvelope({ envelope: disclosure, sender: B, conversationId: "c1" }, s.aDeps);
  assert.equal(outcome, "stored");
  assert.equal(s.stored.length, 1);
  assert.deepEqual((s.stored[0].payload as any).busy, [{ start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T10:00:00.000Z" }]);
});

test("approving twice sends only one disclosure", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  const [r1, r2] = await Promise.all([approveConsent("req-1", s.bActions), approveConsent("req-1", s.bActions)]);
  assert.equal([r1.ok, r2.ok].filter(Boolean).length, 1);
  assert.equal(s.sent.filter((m) => decodeEnvelope(m.text)?.kind === "disclosure").length, 1);
});

test("a request denied while private data is loading is never disclosed", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  let entered!: () => void;
  const loading = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const approving = approveConsent("req-1", {
    ...s.bActions,
    loadCalendar: async () => {
      entered();
      await gate;
      return calendar;
    },
  });
  await loading;
  assert.ok(await s.queue.transition("req-1", "denied"));
  release();
  assert.deepEqual(await approving, { ok: false, reason: "not_pending" });
  assert.equal(s.sent.some((m) => decodeEnvelope(m.text)?.kind === "disclosure"), false);
});

test("a disclosure forwarded by a third party is rejected", async () => {
  const s = await setup();
  await registerARequest(s);
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  await approveConsent("req-1", s.bActions);
  const disclosure = decodeEnvelope(s.sent[s.sent.length - 1].text)!;
  const outcome = await handleEnvelope(
    { envelope: disclosure, sender: "0x1111111111111111111111111111111111111111", conversationId: "c1" },
    s.aDeps
  );
  assert.equal(outcome, "rejected");
  assert.equal(s.stored.length, 0);
});

test("a disclosure with edited payload is rejected", async () => {
  const s = await setup();
  await registerARequest(s);
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  await approveConsent("req-1", s.bActions);
  const disclosure = decodeEnvelope(s.sent[s.sent.length - 1].text) as DisclosureEnvelope;
  const edited = decodeEnvelope(encodeEnvelope({ ...disclosure, payload: { ...(disclosure.payload as any), busy: [] } }))!;
  assert.equal(await handleEnvelope({ envelope: edited, sender: B, conversationId: "c1" }, s.aDeps), "rejected");
});

test("deny sends owner_denied and a later approve does nothing", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  assert.deepEqual(await denyConsent("req-1", "owner_denied", s.bActions), { ok: true });
  assert.deepEqual(decodeEnvelope(s.sent[s.sent.length - 1].text), {
    kind: "denial", request_id: "req-1", to: A, reason: "owner_denied",
  });
  assert.deepEqual(await approveConsent("req-1", s.bActions), { ok: false, reason: "not_pending" });
});

test("pending requests expire after ten minutes", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  const later = { ...s.bActions, now: () => new Date(NOW.getTime() + 10 * 60 * 1000) };
  assert.equal(await expireDue(later), 1);
  assert.equal(s.queue.get("req-1")?.status, "expired");
  assert.equal((decodeEnvelope(s.sent[s.sent.length - 1].text) as any).reason, "expired");
});

test("ledger never contains the purpose text or calendar titles", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  await approveConsent("req-1", s.bActions);
  const encoded = JSON.stringify(s.ledger);
  for (const secret of ["约下周的会", "律师", "房产证"]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});


test("failed private read remains pending and can be explicitly approved again", async () => {
  const s = await setup();
  await handleEnvelope({ envelope: request, sender: A, conversationId: "c1" }, s.bDeps);
  const sentBefore = s.sent.length;
  assert.deepEqual(await approveConsent(request.request_id, {
    ...s.bActions, loadCalendar: async () => { throw new Error("upstream failed"); },
  }), {ok:false, reason:"no_connector"});
  assert.equal(s.queue.get(request.request_id)?.status, "pending");
  assert.equal(s.sent.length, sentBefore);
  assert.equal((await approveConsent(request.request_id, s.bActions)).ok, true);
});

test("handleEnvelope honors hubRoomSettings: downgrades allow->ask, tightens cannot, local wins, injects teamConfig", async () => {
  const s = await setup();
  const { normalizeHubRoomSettings } = await import("./rulesEngine.ts");
  const settings = normalizeHubRoomSettings({
    settings_version: 1,
    settings_json: {
      house_rules: {
        scopes: {
          "calendar.free_busy": "allow",
          "email.receipt": "cannot",
        },
        notes: [],
      },
      team_config_markdown: "按项目模板先总结再行动",
      default_max_rounds: 2,
    },
  });
  assert.ok(settings);
  // 就算 Hub 发了 allow，本机没有显式写允许时也会被降格成 ask 进队列而非自动放行。
  s.bDeps.policy = normalizePolicy({});
  s.bDeps.hubRoomSettings = () => settings;
  assert.equal(await handleEnvelope({ envelope: { ...request, request_id: "req-hub-allow-downgraded" }, sender: A, conversationId: "c1" }, s.bDeps), "queued");

  // 1) Hub cannot 收紧：本机未写该 scope 时直接拒。
  const receiptReq: RequestEnvelope = {
    kind: "request",
    request_id: "req-hub-cannot",
    to: B,
    scope: "email.receipt",
    purpose: "查回执",
    constraints: { query: "12306", date_from: "2026-10-05", date_to: "2026-10-09" } as any,
  };
  assert.equal(await handleEnvelope({ envelope: receiptReq, sender: A, conversationId: "c1" }, s.bDeps), "denied");
  assert.equal((decodeEnvelope(s.sent[s.sent.length - 1].text) as any).reason, "cannot");

  // 2) 本机覆盖优先：本机 house 写了 email.receipt=ask 时，不被 Hub cannot 压倒。
  s.bDeps.policy = normalizePolicy({ allow: { [A]: ["calendar.free_busy"] }, rules: { house: { "email.receipt": "ask" } } });
  assert.equal(await handleEnvelope({ envelope: { ...receiptReq, request_id: "req-local-wins" }, sender: A, conversationId: "c1" }, s.bDeps), "queued");

  // 3) teamConfigMarkdown 注入任务提示词且包着非授权声明。
  let seenPrompt = "";
  s.bDeps.policy = normalizePolicy({ allow: { [A]: ["task.run"] } });
  s.bDeps.completeModel = async (prompt) => {
    seenPrompt = prompt;
    return "已完成总结";
  };
  const taskEnv = {
    kind: "task" as const,
    request_id: "task-hub-tc",
    to: B,
    goal: "总结进度",
    acceptance: ["给出一条结论"],
    round: 1,
  };
  assert.equal(await handleEnvelope({ envelope: taskEnv, sender: A, conversationId: "c1" }, s.bDeps), "task_executed");
  assert.equal(seenPrompt.includes("按项目模板先总结再行动"), true);
  assert.equal(seenPrompt.includes("不构成授权依据"), true);
});
