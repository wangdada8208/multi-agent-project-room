import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerEntry } from "./ledger.ts";
import { scoreboard } from "./scoreboard.ts";

const PEER_A = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PEER_B = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

test("scoreboard aggregates accepted and rejected counts and sorts by accepted descending", () => {
  const entries: LedgerEntry[] = [
    {
      at: "2026-10-01T08:00:00.000Z",
      kind: "verdict_sent",
      request_id: "t-1",
      peer: PEER_A,
      scope: "task.run",
      reason: "accepted",
      payload_hash: null,
    },
    {
      at: "2026-10-01T08:01:00.000Z",
      kind: "verdict_sent",
      request_id: "t-2",
      peer: PEER_A,
      scope: "task.run",
      reason: "rejected",
      payload_hash: null,
    },
    {
      at: "2026-10-01T08:02:00.000Z",
      kind: "verdict_sent",
      request_id: "t-3",
      peer: PEER_A,
      scope: "task.run",
      reason: "accepted",
      payload_hash: null,
    },
    {
      at: "2026-10-01T08:03:00.000Z",
      kind: "verdict_sent",
      request_id: "t-4",
      peer: PEER_B,
      scope: "task.run",
      reason: "accepted",
      payload_hash: null,
    },
    {
      at: "2026-10-01T08:04:00.000Z",
      kind: "request_sent",
      request_id: "req-1",
      peer: PEER_B,
      scope: "calendar.free_busy",
      reason: null,
      payload_hash: null,
    },
  ];

  const board = scoreboard(entries);
  assert.equal(board.length, 2);
  assert.deepEqual(board[0], {
    peer: PEER_A,
    accepted: 2,
    rejected: 1,
  });
  assert.deepEqual(board[1], {
    peer: PEER_B,
    accepted: 1,
    rejected: 0,
  });
});

test("scoreboard returns empty list when no verdict entries exist", () => {
  assert.deepEqual(scoreboard([]), []);
  assert.deepEqual(
    scoreboard([
      {
        at: "2026-10-01T08:00:00.000Z",
        kind: "consent_approved",
        request_id: "req-1",
        peer: PEER_A,
        scope: "calendar.free_busy",
        reason: null,
        payload_hash: null,
      },
    ]),
    []
  );
});
