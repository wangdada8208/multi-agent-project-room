import assert from "node:assert/strict";
import test from "node:test";
import { decodeEnvelope, encodeEnvelope, type MemberRevokedEnvelope } from "./envelope.ts";
import { handleEnvelope, type HandleEnvelopeDeps } from "./handleEnvelope.ts";
import type { LedgerEntry } from "./ledger.ts";
import type { Policy } from "./policy.ts";
import type { MemberRevokedOutcome } from "./revocations.ts";

const SELF = "0x1111111111111111111111111111111111111111";
const REVOKED = "0x2222222222222222222222222222222222222222";
const SENDER = "0x3333333333333333333333333333333333333333";

function makeDeps(input: {
  onMemberRevoked?: (
    address: string,
    conversationId: string,
    sender: string,
    requestId: string
  ) => Promise<MemberRevokedOutcome>;
  policy?: Policy;
}) {
  const ledger: LedgerEntry[] = [];
  const sent: string[] = [];
  const deps: HandleEnvelopeDeps = {
    selfAddress: SELF,
    policy: input.policy ?? { allow: {}, max_range_days: 14 },
    queue: { add: async () => "added" } as any,
    send: async (_id: string, text: string) => {
      sent.push(text);
    },
    appendLedger: async (entry) => {
      ledger.push(entry);
    },
    storeDisclosure: async () => true,
    onMemberRevoked: input.onMemberRevoked,
    now: () => new Date("2026-11-19T12:00:00Z"),
  };
  return { deps, ledger, sent };
}

function revokedEnvelope(to: string): MemberRevokedEnvelope {
  return {
    kind: "member_revoked",
    request_id: "mr-1",
    to,
    address: REVOKED,
    reason: "owner_removed",
  };
}

test("member_revoked broadcast passes sender+requestId to the verifier and ledgers outcome+sender", async () => {
  const calls: string[] = [];
  const { deps, ledger } = makeDeps({
    onMemberRevoked: async (address, conversationId, sender, requestId) => {
      calls.push(`${address}@${conversationId}#${sender}#${requestId}`);
      return "applied";
    },
  });

  const env = decodeEnvelope(encodeEnvelope(revokedEnvelope("*")))!;
  const outcome = await handleEnvelope(
    { envelope: env, sender: SENDER, conversationId: "group-1" },
    deps
  );

  assert.equal(outcome, "noted");
  assert.deepEqual(calls, [`${REVOKED}@group-1#${SENDER}#mr-1`]);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "member_revoked_received");
  assert.equal(ledger[0].peer, REVOKED);
  assert.equal(ledger[0].sender, SENDER);
  assert.equal(ledger[0].reason, "applied");
});

test("member_revoked from a still-present member is not trusted", async () => {
  const { deps, ledger } = makeDeps({
    onMemberRevoked: async () => "unconfirmed",
  });

  const env = decodeEnvelope(encodeEnvelope(revokedEnvelope("*")))!;
  const outcome = await handleEnvelope(
    { envelope: env, sender: SENDER, conversationId: "group-1" },
    deps
  );

  assert.equal(outcome, "noted");
  assert.equal(ledger[0].kind, "member_revoked_received");
  assert.equal(ledger[0].reason, "unconfirmed");
});

test("member_revoked in a non-group context is recorded as ignored_context", async () => {
  const { deps, ledger } = makeDeps({
    onMemberRevoked: async () => "ignored_context",
  });
  const env = decodeEnvelope(encodeEnvelope(revokedEnvelope("*")))!;
  const outcome = await handleEnvelope(
    { envelope: env, sender: SENDER, conversationId: "dm-1" },
    deps
  );
  assert.equal(outcome, "noted");
  assert.equal(ledger[0].reason, "ignored_context");
  assert.equal(ledger[0].sender, SENDER);
});

test("member_revoked without a handler is ledgered but harmless", async () => {
  const { deps, ledger } = makeDeps({});
  const env = decodeEnvelope(encodeEnvelope(revokedEnvelope("*")))!;
  const outcome = await handleEnvelope(
    { envelope: env, sender: SENDER, conversationId: "group-1" },
    deps
  );
  assert.equal(outcome, "noted");
  assert.equal(ledger[0].reason, "unconfirmed");
});

test("member_revoked for a target without revocable state leaves no persistent audit spam", async () => {
  const { deps, ledger } = makeDeps({
    onMemberRevoked: async () => "no_revocable_state",
  });
  const env = decodeEnvelope(encodeEnvelope(revokedEnvelope("*")))!;
  const outcome = await handleEnvelope(
    { envelope: env, sender: SENDER, conversationId: "group-1" },
    deps
  );
  assert.equal(outcome, "noted");
  assert.equal(ledger.length, 0);
});

test("member_revoked addressed to someone else is ignored", async () => {
  const { deps, ledger } = makeDeps({
    onMemberRevoked: async () => {
      throw new Error("must not be called");
    },
  });
  const env = decodeEnvelope(encodeEnvelope(revokedEnvelope(SENDER)))!; // to != self, to != "*"
  const outcome = await handleEnvelope(
    { envelope: env, sender: SENDER, conversationId: "group-1" },
    deps
  );
  assert.equal(outcome, "ignored");
  assert.equal(ledger.length, 0);
});
