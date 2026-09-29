import assert from "node:assert/strict";
import test from "node:test";
import { buildOwnerNote } from "./ownerNote.ts";

test("sent note has no inbound or model text", () => {
  const note = buildOwnerNote({
    selfName: "Codex",
    turnsSeen: 2,
    action: "sent",
    inbound: "@Codex 约时间",
    modelText: "周三 14:00 可以",
  });
  const encoded = JSON.stringify(note);
  assert.equal(note.action, "sent");
  assert.equal(note.turns_seen, 2);
  assert.equal(note.self_name, "Codex");
  assert.equal(encoded.includes("约时间"), false);
  assert.equal(encoded.includes("14:00"), false);
});

test("blocked note records the reason only", () => {
  const note = buildOwnerNote({
    selfName: "Codex",
    turnsSeen: 3,
    action: "blocked",
    blockReason: "unapproved_day",
    inbound: "周五秘密会议室",
    modelText: "周五可以，秘密会议室见",
  });
  const encoded = JSON.stringify(note);
  assert.equal(note.action, "blocked");
  assert.equal(note.block_reason, "unapproved_day");
  assert.equal(encoded.includes("秘密会议室"), false);
  assert.equal(encoded.includes("周五"), false);
});
