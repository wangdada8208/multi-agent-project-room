import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRequestEnvelope } from "./outgoingRequest.ts";
import { OutgoingRequests, type OutgoingRequestRecord } from "./outgoingRequests.ts";

const SELF = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PEER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const good = { to: PEER.toUpperCase().replace("0X", "0x"), scope: "calendar.free_busy", purpose: "约会", date_from: "2026-10-05", date_to: "2026-10-09" };

test("builds a lowercase request with a fresh id", () => {
  const a = buildRequestEnvelope(good, SELF);
  const b = buildRequestEnvelope(good, SELF);
  assert.equal(a.ok && a.envelope.to, PEER);
  assert.equal(a.ok && b.ok && a.envelope.request_id !== b.envelope.request_id, true);
});

test("rejects bad input", () => {
  assert.deepEqual(buildRequestEnvelope({ ...good, to: "bob" }, SELF), { ok: false, reason: "bad_address" });
  assert.deepEqual(buildRequestEnvelope({ ...good, to: SELF }, SELF), { ok: false, reason: "self_request" });
  assert.deepEqual(buildRequestEnvelope({ ...good, scope: "email.all" }, SELF), { ok: false, reason: "unknown_scope" });
  assert.deepEqual(buildRequestEnvelope({ ...good, date_to: "soon" }, SELF), { ok: false, reason: "bad_range" });
  assert.deepEqual(buildRequestEnvelope({ ...good, purpose: "x".repeat(281) }, SELF), { ok: false, reason: "purpose_too_long" });
});

function outgoingRecord(requestId: string): OutgoingRequestRecord {
  return {
    request_id: requestId,
    to: PEER,
    kind: "data",
    scope: "calendar.free_busy",
    created_at: "2026-11-19T12:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
  };
}

test("corrupt outbound registry refuses to load instead of accepting an empty history", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "outgoing-corrupt-"));
  const file = path.join(dir, "outgoing.json");
  await writeFile(file, "{not-json");
  await assert.rejects(new OutgoingRequests(file).load(), /corrupt/i);
});

test("outbound registry never evicts an unanswered unexpired request", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "outgoing-full-"));
  const file = path.join(dir, "outgoing.json");
  await writeFile(file, JSON.stringify(Array.from({ length: 1000 }, (_, i) => outgoingRecord(`req-${i}`))));
  const registry = new OutgoingRequests(file);
  await registry.load();
  assert.equal(await registry.register(outgoingRecord("req-new")), false);
  assert.ok(registry.get("req-0"));
  assert.equal(registry.get("req-new"), null);
});

test("a failed responded-marker save can be retried in the same process", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "outgoing-retry-"));
  const file = path.join(dir, "outgoing.json");
  const registry = new OutgoingRequests(file);
  await registry.register(outgoingRecord("req-1"));
  await rm(file);
  await mkdir(file);

  await assert.rejects(registry.markResponded("req-1", "grant-1", new Date()));
  assert.equal(registry.get("req-1")?.responded_at, undefined);
  assert.equal(registry.get("req-1")?.response_grant_id, undefined);
  assert.equal(registry.claimResponse("req-1"), true);
  registry.releaseResponse("req-1");

  await rm(file, { recursive: true });
  assert.equal(await registry.markResponded("req-1", "grant-1", new Date()), true);
  assert.ok(registry.get("req-1")?.responded_at);
});
