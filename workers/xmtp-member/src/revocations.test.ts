import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConsentQueue } from "./consentQueue.ts";
import { normalizePolicy, type Policy } from "./policy.ts";
import {
  applyMemberRevoked,
  RevocationDedup,
  RevocationReconciler,
  RevocationRetries,
  RevocationStore,
  type ApplyRevokedDeps,
  type ApplyRevokedResult,
  type RevokeConversationLike,
} from "./revocations.ts";

const VICTIM = "0x2222222222222222222222222222222222222222";
const SENDER = "0x3333333333333333333333333333333333333333";
const GROUP = "group-room-1";

function groupCtx(members: string[], opts: { syncThrows?: boolean; membersThrows?: boolean } = {}): RevokeConversationLike {
  return {
    isGroup: () => true,
    conversation: {
      id: GROUP,
      sync: async () => {
        if (opts.syncThrows) throw new Error("sync failed");
      },
      members: async () => {
        if (opts.membersThrows) throw new Error("members failed");
        return members.map((m) => ({ accountIdentifiers: [{ identifier: m }] }));
      },
    },
  };
}

const dmCtx: RevokeConversationLike = {
  isGroup: () => false,
  conversation: {
    id: "dm-1",
    members: async () => [
      { accountIdentifiers: [{ identifier: SENDER }] },
      { accountIdentifiers: [{ identifier: "0x1111111111111111111111111111111111111111" }] },
    ],
  },
};

async function setup(opts: {
  ctx?: RevokeConversationLike | null;
  activeGroupId?: string | null;
  policy?: Policy;
  allowedSenders?: string[];
  seedPending?: boolean;
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "revoke-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  if (opts.seedPending) {
    await queue.add({
      request_id: "p-1",
      requester: VICTIM,
      conversation_id: GROUP,
      scope: "gmail.send",
      purpose: "x",
      constraints: { date_from: "", date_to: "" },
      created_at: new Date().toISOString(),
      kind: "action",
    });
    await queue.add({
      request_id: "p-2",
      requester: SENDER,
      conversation_id: GROUP,
      scope: "calendar.free_busy",
      purpose: "x",
      constraints: { date_from: "2026-11-01", date_to: "2026-11-02" },
      created_at: new Date().toISOString(),
    });
  }
  const policy = opts.policy ?? normalizePolicy({});
  const allowedSenders = opts.allowedSenders ?? [];
  const revoked = new RevocationStore(path.join(dir, "revoked.json"));
  await revoked.load();
  let memberCalls = 0;
  const ctx = opts.ctx === undefined ? groupCtx([SENDER]) : opts.ctx;
  const innerMembers = ctx?.conversation?.members;
  if (ctx?.conversation && innerMembers) {
    ctx.conversation.members = async () => {
      memberCalls++;
      return innerMembers();
    };
  }
  const deps: ApplyRevokedDeps = {
    activeGroupId: () => (opts.activeGroupId === undefined ? GROUP : opts.activeGroupId),
    getConversation: async () => ctx,
    syncAll: async () => {},
    policy,
    allowedSenders,
    revoked,
    dedup: new RevocationDedup({ verifyIntervalMs: 15_000 }),
    queue,
    now: () => new Date("2026-11-19T12:00:00Z"),
  };
  return { deps, queue, policy, allowedSenders, revoked, memberCalls: () => memberCalls, dir };
}

const notice = { address: VICTIM, conversationId: GROUP, sender: SENDER, requestId: "mr-1" };

test("forged member_revoked via DM purges nothing", async () => {
  const s = await setup({
    ctx: dmCtx,
    policy: normalizePolicy({ allow: { [VICTIM]: ["task.run"] } }),
    allowedSenders: [VICTIM],
  });
  const r = await applyMemberRevoked({ ...notice, conversationId: "dm-1" }, s.deps);
  assert.equal(r.outcome, "ignored_context");
  assert.deepEqual(s.policy.allow[VICTIM], ["task.run"]);
  assert.deepEqual(s.allowedSenders, [VICTIM]);
  assert.equal(s.memberCalls(), 0);
});

test("member_revoked from a different (non-room) group purges nothing", async () => {
  const s = await setup({
    ctx: groupCtx([SENDER]),
    policy: normalizePolicy({ allow: { [VICTIM]: ["task.run"] } }),
    allowedSenders: [VICTIM],
  });
  const r = await applyMemberRevoked({ ...notice, conversationId: "other-group" }, s.deps);
  assert.equal(r.outcome, "ignored_context");
  assert.deepEqual(s.policy.allow[VICTIM], ["task.run"]);
  assert.equal(s.memberCalls(), 0);
});

test("confirmed removal records only this group, cancels its pending items and persists across reload", async () => {
  const s = await setup({
    policy: normalizePolicy({
      allow: { [VICTIM]: ["task.run"] },
      rules: { actors: { [VICTIM]: { "gmail.send": "allow" } } },
    }),
    allowedSenders: [VICTIM, SENDER],
    seedPending: true,
  });
  const r = await applyMemberRevoked(notice, s.deps);
  assert.equal(r.outcome, "applied");
  assert.deepEqual(s.policy.allow[VICTIM], ["task.run"]);
  assert.deepEqual(s.policy.rules?.actors?.[VICTIM], { "gmail.send": "allow" });
  assert.deepEqual(s.allowedSenders, [VICTIM, SENDER]);
  assert.deepEqual(r.deniedRequestIds, ["p-1"]);
  assert.equal(s.queue.get("p-1")?.status, "denied");
  assert.equal(s.queue.get("p-2")?.status, "pending");
  const reloaded = new RevocationStore(path.join(s.dir, "revoked.json"));
  await reloaded.load();
  assert.equal(reloaded.has(VICTIM, GROUP), true);
  const mode = (await stat(path.join(s.dir, "revoked.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("group revocation never purges DM authorization or DM consents", async () => {
  const s = await setup({
    policy: normalizePolicy({
      allow: { [VICTIM]: ["task.run"] },
      rules: { actors: { [VICTIM]: { "gmail.send": "allow" } } },
    }),
    allowedSenders: [VICTIM],
    seedPending: true,
  });
  await s.queue.add({
    request_id: "dm-req-1",
    requester: VICTIM,
    conversation_id: "dm-1",
    scope: "gmail.send",
    purpose: "x",
    constraints: { date_from: "", date_to: "" },
    created_at: new Date().toISOString(),
    kind: "action",
  });

  const result = await applyMemberRevoked(notice, s.deps);
  assert.equal(result.outcome, "applied");
  assert.deepEqual(s.policy.allow[VICTIM], ["task.run"]);
  assert.deepEqual(s.policy.rules?.actors?.[VICTIM], { "gmail.send": "allow" });
  assert.deepEqual(s.allowedSenders, [VICTIM]);
  assert.equal(s.queue.get("p-1")?.status, "denied");
  assert.equal(s.queue.get("dm-req-1")?.status, "pending");
  assert.equal(s.revoked.has(VICTIM, GROUP), true);
  assert.equal(s.revoked.has(VICTIM, "dm-1"), false);
});

test("a DM context is ignored even when it reuses the active group id", async () => {
  const s = await setup({
    ctx: { ...dmCtx, conversation: { ...dmCtx.conversation, id: GROUP } },
    policy: normalizePolicy({ allow: { [VICTIM]: ["task.run"] } }),
    allowedSenders: [VICTIM],
  });
  const r = await applyMemberRevoked(notice, s.deps);
  assert.equal(r.outcome, "ignored_context");
  assert.deepEqual(s.policy.allow[VICTIM], ["task.run"]);
  assert.equal(s.memberCalls(), 0);
});

test("group context without a verifiable isGroup flag is ignored", async () => {
  const ctx = groupCtx([SENDER]);
  delete ctx.isGroup;
  const s = await setup({
    ctx,
    policy: normalizePolicy({ allow: { [VICTIM]: ["task.run"] } }),
    allowedSenders: [VICTIM],
  });
  const r = await applyMemberRevoked(notice, s.deps);
  assert.equal(r.outcome, "ignored_context");
  assert.deepEqual(s.policy.allow[VICTIM], ["task.run"]);
  assert.equal(s.memberCalls(), 0);
});

test("corrupt revocation JSON refuses to load instead of restoring revoked senders", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "revoke-corrupt-"));
  const file = path.join(dir, "revoked.json");
  await writeFile(file, "{not-json");
  await assert.rejects(new RevocationStore(file).load(), /corrupt/i);
});

test("revocation blocks sender and cancels approved work before persistence completes", async () => {
  const s = await setup({
    policy: normalizePolicy({ allow: { [VICTIM]: ["task.run"] } }),
    allowedSenders: [VICTIM],
    seedPending: true,
  });
  await s.queue.add({
    request_id: "p-approved",
    requester: VICTIM,
    conversation_id: GROUP,
    scope: "gmail.send",
    purpose: "x",
    constraints: { date_from: "", date_to: "" },
    created_at: new Date().toISOString(),
    kind: "action",
  });
  await s.queue.claim("p-approved", "approved");
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deny = s.queue.denyAllPendingForRequester.bind(s.queue);
  s.queue.denyAllPendingForRequester = async (requester, conversationId, now) => {
    const persisted = deny(requester, conversationId, now);
    entered();
    await gate;
    return persisted;
  };
  const applying = applyMemberRevoked(notice, s.deps);
  await saving;
  const approvedStatus = s.queue.get("p-approved")?.status;
  const pendingStatus = s.queue.get("p-1")?.status;
  const senderRevoked = s.revoked.has(VICTIM, GROUP);
  release();
  assert.equal((await applying).outcome, "applied");
  assert.equal(approvedStatus, "denied");
  assert.equal(pendingStatus, "denied");
  assert.equal(senderRevoked, true);
});

test("empty or unidentified member rows make removal unconfirmed instead of absent", async () => {
  const malformedRows = [
    [],
    [{ accountIdentifiers: [] }],
    [
      { accountIdentifiers: [{ identifier: SENDER }] },
      { accountIdentifiers: [] },
    ],
  ];
  for (const rows of malformedRows) {
    const ctx = groupCtx([SENDER]);
    ctx.conversation!.members = async () => rows;
    const s = await setup({
      ctx,
      policy: normalizePolicy({ allow: { [VICTIM]: ["task.run"] } }),
      allowedSenders: [VICTIM],
    });
    const r = await applyMemberRevoked(notice, s.deps);
    assert.equal(r.outcome, "unconfirmed");
    assert.deepEqual(s.policy.allow[VICTIM], ["task.run"]);
    assert.deepEqual(s.allowedSenders, [VICTIM]);
  }
});

test("target still present is unconfirmed and nothing is purged", async () => {
  const s = await setup({
    ctx: groupCtx([SENDER, VICTIM]),
    policy: normalizePolicy({ allow: { [VICTIM]: ["task.run"] } }),
    allowedSenders: [VICTIM],
  });
  const r = await applyMemberRevoked(notice, s.deps);
  assert.equal(r.outcome, "unconfirmed");
  assert.equal(r.subjectPresent, true);
  assert.deepEqual(s.policy.allow[VICTIM], ["task.run"]);
  assert.deepEqual(s.allowedSenders, [VICTIM]);
});

test("members() or sync() failure is unconfirmed, not a purge", async () => {
  for (const opts of [{ membersThrows: true }, { syncThrows: true }]) {
    const s = await setup({
      ctx: groupCtx([SENDER], opts),
      policy: normalizePolicy({ allow: { [VICTIM]: ["task.run"] } }),
      allowedSenders: [VICTIM],
    });
    const r = await applyMemberRevoked(notice, s.deps);
    assert.equal(r.outcome, "unconfirmed");
    assert.deepEqual(s.policy.allow[VICTIM], ["task.run"]);
  }
});

test("duplicate request_id and rate limiting avoid repeated members() pulls; already-revoked skips verify", async () => {
  const s = await setup({ allowedSenders: [VICTIM] });
  const r1 = await applyMemberRevoked(notice, s.deps);
  assert.equal(r1.outcome, "applied");
  assert.equal(s.memberCalls(), 1);
  // 同 request_id ⇒ duplicate，不再核实
  const r2 = await applyMemberRevoked(notice, s.deps);
  assert.equal(r2.outcome, "already_revoked");
  // 不同 request_id ⇒ 已在撤销名单里，幂等不拉成员表
  const r3 = await applyMemberRevoked({ ...notice, requestId: "mr-2" }, s.deps);
  assert.equal(r3.outcome, "already_revoked");
  assert.equal(s.memberCalls(), 1);
});

test("an unconfirmed request_id replay hits duplicate before another member lookup", async () => {
  const s = await setup({ ctx: groupCtx([SENDER, VICTIM]), allowedSenders: [VICTIM] });
  assert.equal((await applyMemberRevoked(notice, s.deps)).outcome, "unconfirmed");
  assert.equal((await applyMemberRevoked(notice, s.deps)).outcome, "duplicate");
  assert.equal(s.memberCalls(), 1);
});

test("rate limit defers rapid re-verification for the same address", async () => {
  let now = Date.parse("2026-11-19T12:00:00Z");
  const s = await setup({ ctx: groupCtx([SENDER, VICTIM]), allowedSenders: [VICTIM] });
  s.deps.now = () => new Date(now);
  const r1 = await applyMemberRevoked(notice, s.deps);
  assert.equal(r1.outcome, "unconfirmed");
  assert.equal(s.memberCalls(), 1);
  const r2 = await applyMemberRevoked({ ...notice, requestId: "mr-9" }, s.deps);
  assert.equal(r2.outcome, "rate_limited");
  assert.equal(s.memberCalls(), 1);
  now += 1_000;
  const r3 = await applyMemberRevoked({ ...notice, requestId: "mr-9" }, { ...s.deps, fromRetry: true });
  assert.equal(r3.outcome, "unconfirmed");
  assert.equal(s.memberCalls(), 2);
});

test("a target with no revocable state never triggers member lookup or persistent revocation", async () => {
  const s = await setup({});
  const result = await applyMemberRevoked(notice, s.deps);
  assert.equal(result.outcome, "no_revocable_state");
  assert.equal(s.memberCalls(), 0);
  await assert.rejects(readFile(path.join(s.dir, "revoked.json"), "utf8"));
});

test("pending consent alone makes a target revocable", async () => {
  const s = await setup({ seedPending: true });
  const result = await applyMemberRevoked(notice, s.deps);
  assert.equal(result.outcome, "applied");
  assert.equal(s.queue.get("p-1")?.status, "denied");
});

test("member verification is globally rate limited across distinct targets", async () => {
  const other = "0x4444444444444444444444444444444444444444";
  const s = await setup({
    ctx: groupCtx([SENDER, VICTIM, other]),
    policy: normalizePolicy({ allow: { [VICTIM]: ["task.run"], [other]: ["task.run"] } }),
  });
  assert.equal((await applyMemberRevoked(notice, s.deps)).outcome, "unconfirmed");
  const second = await applyMemberRevoked({ ...notice, address: other, requestId: "mr-other" }, s.deps);
  assert.equal(second.outcome, "rate_limited");
  assert.equal(s.memberCalls(), 1);
});

test("pending revocation retries persist and clear after presence is confirmed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "revoke-retries-"));
  const file = path.join(dir, "pending.json");
  const retries = new RevocationRetries({ file });
  assert.equal(await retries.schedule({ address: VICTIM, conversationId: GROUP, sender: SENDER, requestId: "mr-1" }, 1000), true);

  const restored = new RevocationRetries({ file });
  await restored.load();
  assert.deepEqual(restored.list().map((entry) => entry.address), [VICTIM]);
  const reconciler = new RevocationReconciler({
    retries: restored,
    probe: async () => ({ outcome: "unconfirmed", subjectPresent: true, deniedRequestIds: [] }),
    onError: (error) => assert.fail(String(error)),
  });
  await reconciler.reconcile();
  assert.equal(restored.size(), 0);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
});

test("retry storage is bounded without evicting existing suspects", async () => {
  const retries = new RevocationRetries({ maxPending: 1 });
  assert.equal(await retries.schedule({ address: VICTIM, conversationId: GROUP, sender: SENDER, requestId: "mr-1" }, 1000), true);
  assert.equal(await retries.schedule({ address: SENDER, conversationId: GROUP, sender: SENDER, requestId: "mr-2" }, 1000), false);
  assert.deepEqual(retries.list().map((entry) => entry.address), [VICTIM]);
});

test("a stalled suspect stays queued for low-frequency reconciliation", async () => {
  const retries = new RevocationRetries({ maxAttempts: 1, stalledDelayMs: 60_000 });
  const now = 1_000_000;
  await retries.schedule({ address: VICTIM, conversationId: GROUP, sender: SENDER, requestId: "mr-1" }, now);
  assert.equal(await retries.fail(retries.due(now)[0], now), false);
  assert.equal(retries.size(), 1);
  assert.equal(retries.due(now + 59_999).length, 0);
  assert.equal(retries.due(now + 60_000).length, 1);
});

test("bounded retry bursts back off, then retain the suspect at a lower frequency", async () => {
  const retries = new RevocationRetries({ maxAttempts: 3, baseDelayMs: 60_000, stalledDelayMs: 600_000 });
  const now = 1_000_000;
  await retries.schedule({ address: VICTIM, conversationId: GROUP, sender: SENDER, requestId: "mr-1" }, now);
  assert.equal(retries.size(), 1);
  const due1 = retries.due(now);
  assert.equal(due1.length, 1);
  assert.equal(await retries.fail(due1[0], now), true);
  assert.equal(retries.due(now).length, 0);
  const due2 = retries.due(now + 60_001);
  assert.equal(due2.length, 1);
  assert.equal(await retries.fail(due2[0], now + 60_001), true);
  const last = now + 60_001 + 120_001;
  const due3 = retries.due(last);
  assert.equal(await retries.fail(due3[0], last), false);
  assert.equal(retries.size(), 1);
  assert.equal(retries.due(last + 599_999).length, 0);
  assert.equal(retries.due(last + 600_000).length, 1);
});

test("corrupt pending revocation storage refuses to load", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "revoke-retries-corrupt-"));
  const file = path.join(dir, "pending.json");
  await writeFile(file, "{not-json");
  await assert.rejects(new RevocationRetries({ file }).load(), /corrupt/i);
});

test("an empty restored queue creates no member probes", async () => {
  const retries = new RevocationRetries();
  let probes = 0;
  const reconciler = new RevocationReconciler({
    retries,
    probe: async () => {
      probes += 1;
      return { outcome: "unconfirmed", deniedRequestIds: [] };
    },
    onError: (error) => assert.fail(String(error)),
  });
  await reconciler.reconcile();
  assert.equal(probes, 0);
});

test("concurrent pending revocation schedules are all persisted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "revoke-retries-concurrent-"));
  const file = path.join(dir, "pending.json");
  const retries = new RevocationRetries({ file });
  const entries = Array.from({ length: 40 }, (_, index) => ({
    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    conversationId: GROUP,
    sender: SENDER,
    requestId: `mr-${index}`,
  }));
  assert.deepEqual(await Promise.all(entries.map((entry) => retries.schedule(entry, 1000))), entries.map(() => true));
  const restored = new RevocationRetries({ file });
  await restored.load();
  assert.deepEqual(new Set(restored.list().map((entry) => entry.address)), new Set(entries.map((entry) => entry.address)));
});

test("background reconciliation is single-flight and clears a confirmed-present retry", async () => {
  let release!: (result: ApplyRevokedResult) => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let probeCalls = 0;
  const retries = new RevocationRetries();
  const reconciler = new RevocationReconciler({
    retries,
    probe: () => {
      probeCalls += 1;
      notifyStarted();
      return new Promise<ApplyRevokedResult>((resolve) => {
        release = resolve;
      });
    },
    onError: (error) => assert.fail(String(error)),
  });
  await retries.schedule({ address: VICTIM, conversationId: GROUP, sender: SENDER, requestId: "mr-1" }, Date.now());

  reconciler.start();
  const first = reconciler.reconcile();
  const second = reconciler.reconcile();
  assert.strictEqual(first, second);
  await started;
  assert.equal(probeCalls, 1);

  release({ outcome: "unconfirmed", subjectPresent: true, deniedRequestIds: [] });
  await first;
  assert.equal(retries.size(), 0);
});

test("a stalled retry stays queued and clears after a later successful recheck", async () => {
  const retries = new RevocationRetries({ maxAttempts: 1, stalledDelayMs: 0 });
  const errors: unknown[] = [];
  let stalled = 0;
  let probes = 0;
  const reconciler = new RevocationReconciler({
    retries,
    probe: async () => {
      probes += 1;
      if (probes === 1) throw new Error("network stalled");
      return { outcome: "unconfirmed", subjectPresent: true, deniedRequestIds: [] };
    },
    onStalled: async () => {
      stalled += 1;
    },
    onError: (error) => errors.push(error),
  });
  await retries.schedule({ address: VICTIM, conversationId: GROUP, sender: SENDER, requestId: "mr-1" }, Date.now());

  await reconciler.reconcile();
  assert.equal(retries.size(), 1);
  assert.equal(stalled, 1);
  assert.equal(errors.length, 1);

  await reconciler.reconcile();
  assert.equal(retries.size(), 0);
  assert.equal(probes, 2);
});

test("getConversation or syncAll errors become unconfirmed instead of dropping the hint", async () => {
  const s1 = await setup({ allowedSenders: [VICTIM] });
  s1.deps.getConversation = async () => {
    throw new Error("rpc unavailable");
  };
  const r1 = await applyMemberRevoked(notice, s1.deps);
  assert.deepEqual(r1, { outcome: "unconfirmed", deniedRequestIds: [] });

  const s2 = await setup({ ctx: null, allowedSenders: [VICTIM] });
  s2.deps.syncAll = async () => {
    throw new Error("syncAll failed");
  };
  const r2 = await applyMemberRevoked(notice, s2.deps);
  assert.deepEqual(r2, { outcome: "unconfirmed", deniedRequestIds: [] });
});

test("rate_limited reconciliation defers retry without burning attempts or stalling", async () => {
  const retries = new RevocationRetries({ maxAttempts: 1 });
  let stalled = 0;
  const reconciler = new RevocationReconciler({
    retries,
    probe: async () => ({ outcome: "rate_limited", deniedRequestIds: [] }),
    onStalled: async () => {
      stalled += 1;
    },
    onError: (error) => assert.fail(String(error)),
  });
  const before = Date.now();
  await retries.schedule({ address: VICTIM, conversationId: GROUP, sender: SENDER, requestId: "mr-1" }, before);

  await reconciler.reconcile();
  assert.equal(stalled, 0);
  assert.equal(retries.size(), 1);
  const [entry] = retries.list();
  assert.equal(entry.attempts, 0);
  assert.ok(entry.nextAttemptAt > before);
});
