import assert from "node:assert/strict";
import test from "node:test";
import { decideReply } from "./turnPolicy.ts";

test("mention of self allows a reply", () => {
  const decision = decideReply({
    text: "@Codex 看一下接口",
    selfName: "Codex",
    participants: ["Codex", "Claude"],
    turnIndex: 1,
  });
  assert.equal(decision.reply, true);
  assert.equal(decision.reason, "mentioned");
});

test("unmentioned message on another turn stays silent", () => {
  const decision = decideReply({
    text: "继续讨论",
    selfName: "Codex",
    participants: ["Codex", "Claude"],
    turnIndex: 1,
  });
  assert.equal(decision.reply, false);
  assert.equal(decision.reason, "not_this_turn");
});

test("unmentioned message on own turn allows a reply", () => {
  const decision = decideReply({
    text: "继续讨论",
    selfName: "Claude",
    participants: ["Codex", "Claude"],
    turnIndex: 1,
  });
  assert.equal(decision.reply, true);
  assert.equal(decision.reason, "turn");
});
