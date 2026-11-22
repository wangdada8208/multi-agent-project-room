import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSafeActivityEvent,
  checkpointFromVerification,
  ledgerCheckpointMessage,
  ledgerEntryStatus,
  queryLocalActivity,
  signLedgerCheckpoint,
  verifyLedgerCheckpoint,
} from "./activity.ts";
import {
  appendLedger,
  buildLedgerEntry,
  readLedger,
  verifyLedger,
  type LedgerEntry,
} from "./ledger.ts";

// Hardhat 公开测试账号，只用于单元测试，不能用于任何真实网络。
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const NOW = new Date("2026-10-01T08:00:00Z");

function checkpointInput(head_seq = 7) {
  return {
    room_id: "room-1",
    stream_id: "ledger-main",
    head_seq,
    head_hash: "a".repeat(64),
    entry_count: 42,
    now: NOW,
  };
}

test("a signed checkpoint verifies and round-trips through the canonical message", async () => {
  const checkpoint = await signLedgerCheckpoint(checkpointInput(), OWNER_KEY);
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.signer, OWNER);
  assert.equal(checkpoint.created_at, NOW.toISOString());
  assert.equal(ledgerCheckpointMessage(checkpoint).startsWith("MAPR1-LEDGER-CHECKPOINT "), true);
  const result = await verifyLedgerCheckpoint(checkpoint, OWNER);
  assert.deepEqual(result, { ok: true, signer: OWNER });
});

test("a checkpoint signed by another key fails expected-signer check", async () => {
  const checkpoint = await signLedgerCheckpoint(checkpointInput(), OTHER_KEY);
  const wrong = await verifyLedgerCheckpoint(checkpoint, OWNER);
  assert.deepEqual(wrong, { ok: false, reason: "wrong_signer" });
  const noExpected = await verifyLedgerCheckpoint(checkpoint);
  assert.equal(noExpected.ok, true);
});

test("a tampered checkpoint payload fails signature verification", async () => {
  const checkpoint = await signLedgerCheckpoint(checkpointInput(), OWNER_KEY);
  const tampered = { ...checkpoint, head_hash: "b".repeat(64) };
  const result = await verifyLedgerCheckpoint(tampered);
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("malformed checkpoints are rejected", async () => {
  assert.deepEqual(await verifyLedgerCheckpoint(null), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifyLedgerCheckpoint({ version: 2 }), { ok: false, reason: "malformed" });
  const checkpoint = await signLedgerCheckpoint(checkpointInput(), OWNER_KEY);
  assert.deepEqual(await verifyLedgerCheckpoint({ ...checkpoint, head_seq: -1 }), {
    ok: false,
    reason: "malformed",
  });
  assert.deepEqual(await verifyLedgerCheckpoint({ ...checkpoint, head_hash: "zz" }), {
    ok: false,
    reason: "malformed",
  });
});

test("buildSafeActivityEvent emits exactly the whitelisted fields", () => {
  const event = buildSafeActivityEvent({
    room_id: "room-1",
    actor_kind: "agent",
    actor_id: "0xabc",
    kind: "connector_executed",
    status: "finished",
    subject_id: "req-9",
    now: NOW,
  });
  assert.deepEqual(Object.keys(event).sort(), [
    "actor_id",
    "actor_kind",
    "created_at",
    "id",
    "kind",
    "room_id",
    "status",
    "subject_id",
  ]);
  assert.equal(event.subject_id, "req-9");
  assert.equal(event.created_at, NOW.toISOString());
  assert.match(event.id, /^[0-9a-f-]{36}$/);
});

test("buildSafeActivityEvent refuses content-carrying fields outright", () => {
  for (const forbidden of ["payload", "content", "params", "params_hash", "body", "to", "subject"]) {
    assert.throws(
      () =>
        buildSafeActivityEvent({
          room_id: "room-1",
          actor_kind: "agent",
          actor_id: "0xabc",
          kind: "k",
          status: "s",
          [forbidden]: "secret",
        } as Parameters<typeof buildSafeActivityEvent>[0]),
      /forbidden/,
      `field ${forbidden} must be rejected`,
    );
  }
  assert.throws(
    () =>
      buildSafeActivityEvent({
        room_id: "room-1",
        actor_kind: "owner" as "agent",
        actor_id: "0xabc",
        kind: "k",
        status: "s",
      }),
    /actor_kind/,
  );
});

async function chainedEntries(dirPrefix: string): Promise<{ file: string; entries: LedgerEntry[] }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), dirPrefix));
  const file = path.join(dir, "ledger.jsonl");
  await appendLedger(
    file,
    buildLedgerEntry({ now: new Date("2026-10-01T00:00:00Z"), kind: "request_sent", requestId: "r1", peer: "0xAAA" }),
  );
  await appendLedger(
    file,
    buildLedgerEntry({ now: new Date("2026-10-01T01:00:00Z"), kind: "request_denied", requestId: "r2", peer: "0xBBB" }),
  );
  await appendLedger(
    file,
    buildLedgerEntry({
      now: new Date("2026-10-01T02:00:00Z"),
      kind: "member_revoked_received",
      peer: "0xCCC",
      sender: "0xDDD",
    }),
  );
  return { file, entries: await readLedger(file) };
}

test("queryLocalActivity filters by actor, kind, status, time range and limit", async () => {
  const { entries } = await chainedEntries("ledger-query-");
  assert.equal(entries.length, 3);

  const byActor = queryLocalActivity(entries, { actor: "0xbbb" });
  assert.equal(byActor.entries.length, 1);
  assert.equal(byActor.entries[0].request_id, "r2");

  const bySender = queryLocalActivity(entries, { actor: "0xddd" });
  assert.equal(bySender.entries.length, 1);
  assert.equal(bySender.entries[0].kind, "member_revoked_received");

  const byKind = queryLocalActivity(entries, { kind: ["request_sent", "member_revoked_received"] });
  assert.equal(byKind.entries.length, 2);

  const byStatus = queryLocalActivity(entries, { status: "denied" });
  assert.equal(byStatus.entries.length, 1);
  assert.equal(byStatus.entries[0].kind, "request_denied");

  const ranged = queryLocalActivity(entries, {
    since: "2026-10-01T00:30:00.000Z",
    until: "2026-10-01T02:00:00.000Z",
  });
  assert.equal(ranged.entries.length, 2);

  const limited = queryLocalActivity(entries, { limit: 2 });
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.entries[0].kind, "request_denied", "limit keeps the most recent entries");
  assert.equal(limited.total, 3);
});

test("queryLocalActivity returns an integrity summary for the entry set", async () => {
  const { entries } = await chainedEntries("ledger-integrity-");
  const clean = queryLocalActivity(entries);
  assert.equal(clean.integrity.ok, true);
  assert.equal(clean.integrity.chained_entries, 3);
  assert.equal(clean.integrity.head?.seq, 3);

  const tampered = entries.map((e, i) => (i === 1 ? { ...e, reason: "forged" } : e));
  const dirty = queryLocalActivity(tampered);
  assert.equal(dirty.integrity.ok, false);
  assert.ok(dirty.integrity.issues.some((i) => i.code === "entry_hash_mismatch"));
});

test("queryLocalActivity can reuse a file-level verification including the anchor", async () => {
  const { file, entries } = await chainedEntries("ledger-anchor-");
  const anchor = { head_seq: 5, head_hash: "f".repeat(64) };
  const verification = await verifyLedger(file, { anchoredCheckpoint: anchor });
  assert.equal(verification.ok, false);
  const result = queryLocalActivity(entries, {}, { verification });
  assert.equal(result.integrity, verification);
  assert.ok(result.integrity.issues.some((i) => i.code === "anchor_truncated"));
});

test("checkpointFromVerification produces a signable payload that anchors the real head", async () => {
  const { file } = await chainedEntries("ledger-cp-");
  const verification = await verifyLedger(file);
  const payload = checkpointFromVerification(verification, { room_id: "room-1", stream_id: "s1" });
  assert.equal(payload.head_seq, 3);
  assert.equal(payload.head_hash, verification.head?.entry_hash);
  assert.equal(payload.entry_count, 3);
  const checkpoint = await signLedgerCheckpoint({ ...payload, now: NOW }, OWNER_KEY);
  assert.equal((await verifyLedgerCheckpoint(checkpoint, OWNER)).ok, true);
  // 同一个 checkpoint 可以直接喂回 verifyLedger 做锚点校验。
  const anchored = await verifyLedger(file, { anchoredCheckpoint: checkpoint });
  assert.equal(anchored.ok, true);
});

test("ledgerEntryStatus maps every known kind to a coarse status", () => {
  const statusOf = (kind: LedgerEntry["kind"]) =>
    ledgerEntryStatus(buildLedgerEntry({ now: NOW, kind }));
  assert.equal(statusOf("request_queued"), "pending");
  assert.equal(statusOf("action_finished"), "ok");
  assert.equal(statusOf("request_denied"), "denied");
  assert.equal(statusOf("send_failed"), "failed");
  assert.equal(statusOf("consent_expired"), "expired");
  assert.equal(statusOf("recovered_uncertain"), "uncertain");
});
