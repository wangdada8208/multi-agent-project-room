import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidence } from "./evidence.ts";

test("evidence keeps the group id and rejects a private key", () => {
  const evidence = buildEvidence({
    groupId: "965627937735f844c4248315a1e8d966",
    probeReceivedByPeer: true,
    replyReceivedBySender: true,
    hubPlaintextCount: 0,
    messagesTablePresent: true,
    hubDatabase: "local-dev",
  });
  assert.equal(evidence.group_id, "965627937735f844c4248315a1e8d966");
  assert.equal(evidence.probe_received_by_peer, true);
  assert.throws(() =>
    buildEvidence({
      groupId: "group-1",
      probeReceivedByPeer: true,
      replyReceivedBySender: true,
      hubPlaintextCount: 0,
      messagesTablePresent: true,
      hubDatabase: "0x" + "ab".repeat(32),
    }),
  );
});
