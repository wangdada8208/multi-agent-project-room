import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestEnvelope } from "./outgoingRequest.ts";

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
