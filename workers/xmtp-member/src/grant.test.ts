import assert from "node:assert/strict";
import test from "node:test";
import { buildGrant, signGrant, verifyGrant } from "./grant.ts";

// Hardhat 公开测试账号，只用于单元测试，不能用于任何真实网络。
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const AUDIENCE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const NOW = new Date("2026-10-01T08:00:00Z");
const payload = {
  scope: "calendar.free_busy" as const,
  date_from: "2026-10-05",
  date_to: "2026-10-09",
  busy: [{ start: "2026-10-05T09:00:00.000Z", end: "2026-10-05T10:00:00.000Z" }],
};

function makeGrant() {
  return buildGrant({
    owner: OWNER,
    audience: AUDIENCE,
    requestId: "req-1",
    scope: "calendar.free_busy",
    constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
    payload,
    now: NOW,
  });
}

test("a signed grant verifies for the right owner, audience and payload", async () => {
  const grant = makeGrant();
  const signature = await signGrant(grant, OWNER_KEY);
  const result = await verifyGrant({
    grant, signature, expectedOwner: OWNER, expectedAudience: AUDIENCE, payload, now: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test("signing with a key that is not the owner throws", async () => {
  await assert.rejects(signGrant(makeGrant(), OTHER_KEY), /does not match/);
});

test("a tampered payload is rejected", async () => {
  const grant = makeGrant();
  const signature = await signGrant(grant, OWNER_KEY);
  const tampered = { ...payload, busy: [] };
  const result = await verifyGrant({
    grant, signature, expectedOwner: OWNER, expectedAudience: AUDIENCE, payload: tampered, now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: "payload_mismatch" });
});

test("a grant sent by someone other than its owner is rejected", async () => {
  const grant = makeGrant();
  const signature = await signGrant(grant, OWNER_KEY);
  const result = await verifyGrant({
    grant, signature, expectedOwner: AUDIENCE, expectedAudience: AUDIENCE, payload, now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: "wrong_owner" });
});

test("an edited grant field breaks the signature", async () => {
  const grant = makeGrant();
  const signature = await signGrant(grant, OWNER_KEY);
  const edited = { ...grant, constraints: { date_from: "2026-10-01", date_to: "2026-10-30" } };
  const result = await verifyGrant({
    grant: edited, signature, expectedOwner: OWNER, expectedAudience: AUDIENCE, payload, now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("an expired grant is rejected", async () => {
  const grant = makeGrant();
  const signature = await signGrant(grant, OWNER_KEY);
  const later = new Date(NOW.getTime() + 11 * 60 * 1000);
  const result = await verifyGrant({
    grant, signature, expectedOwner: OWNER, expectedAudience: AUDIENCE, payload, now: later,
  });
  assert.deepEqual(result, { ok: false, reason: "expired" });
});
