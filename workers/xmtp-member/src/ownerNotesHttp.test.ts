import assert from "node:assert/strict";
import test from "node:test";
import { handleOwnerNotes } from "./ownerNotesHttp.ts";

test("returns saved notes for loopback and nothing else", async () => {
  const response = await handleOwnerNotes({
    host: "127.0.0.1",
    notes: [
      { self_name: "Codex", turns_seen: 2, action: "blocked", block_reason: "unapproved_day" },
    ],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.notes, [
    { self_name: "Codex", turns_seen: 2, action: "blocked", block_reason: "unapproved_day" },
  ]);
});

test("refuses a non-loopback host", async () => {
  const response = await handleOwnerNotes({
    host: "10.0.0.8",
    notes: [
      { self_name: "Codex", turns_seen: 1, action: "sent", block_reason: null },
    ],
  });
  assert.equal(response.status, 403);
  assert.deepEqual(response.body.notes, []);
});
