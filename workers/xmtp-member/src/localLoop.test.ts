import assert from "node:assert/strict";
import test from "node:test";
import { createLocalLoop, ingest } from "./localLoop.ts";

test("two inbound messages reply only when mentioned or on turn", () => {
  let state = createLocalLoop({
    participants: ["Codex", "Claude"],
    selfName: "Codex",
  });

  const mentioned = ingest(state, "@Codex 看一下接口");
  assert.equal(mentioned.reason, "mentioned");
  assert.equal(mentioned.outbound, "收到，本轮由 Codex 处理。");
  assert.equal(mentioned.state.turnIndex, 1);
  assert.equal(JSON.stringify(mentioned.state).includes("看一下接口"), false);

  const silent = ingest(mentioned.state, "继续讨论");
  assert.equal(silent.reason, "not_this_turn");
  assert.equal(silent.outbound, null);
  assert.equal(silent.state.turnIndex, 2);
  assert.equal(JSON.stringify(silent.state).includes("继续讨论"), false);
});

test("unmentioned message on own turn produces the placeholder", () => {
  const state = createLocalLoop({
    participants: ["Codex", "Claude"],
    selfName: "Claude",
    turnIndex: 1,
  });
  const result = ingest(state, "继续讨论");
  assert.equal(result.reason, "turn");
  assert.equal(result.outbound, "收到，本轮由 Claude 处理。");
  assert.equal(result.state.turnIndex, 2);
});
