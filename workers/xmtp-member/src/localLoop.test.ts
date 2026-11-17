import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalLoop, ingest, saveLoopState, loadLoopState } from "./localLoop.ts";

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

test("saved loop state restores counters and omits message text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-"));
  const file = path.join(dir, "loop.json");
  const secret = "这句不能进状态文件";
  const state = ingest(
    createLocalLoop({ participants: ["Codex", "Claude"], selfName: "Codex" }),
    secret,
  ).state;

  await saveLoopState(file, state);
  const raw = await readFile(file, "utf8");
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes("content"), false);

  const restored = await loadLoopState(file);
  assert.deepEqual(restored, state);
});


test("loop guard pauses after N consecutive agent turns and resumes on human", () => {
  let state = createLocalLoop({
    participants: ["Codex", "Claude"],
    selfName: "Claude",
    turnIndex: 1,
  });

  for (let i = 0; i < 5; i++) {
    const r = ingest(state, "@Claude 继续", { senderIsAgent: true, guardLimit: 6 });
    assert.equal(r.reason, "mentioned");
    assert.ok(r.outbound !== null);
    state = r.state;
  }

  const crossed = ingest(state, "@Claude 继续", { senderIsAgent: true, guardLimit: 6 });
  assert.equal(crossed.reason, "loop_guard");
  assert.match(crossed.outbound ?? "", /先停一下/);
  state = crossed.state;

  const silent = ingest(state, "@Claude 继续", { senderIsAgent: true, guardLimit: 6 });
  assert.equal(silent.reason, "loop_guard");
  assert.equal(silent.outbound, null);
  state = silent.state;

  const human = ingest(state, "@Claude 继续", { senderIsAgent: false, guardLimit: 6 });
  assert.equal(human.reason, "mentioned");
  assert.ok(human.outbound !== null);
  assert.equal(human.state.agentChain, 0);
});

test("loop guard does not fire on human messages and unknown senders stay human", () => {
  let state = createLocalLoop({
    participants: ["Codex", "Claude"],
    selfName: "Claude",
    turnIndex: 1,
  });
  for (let i = 0; i < 10; i++) {
    const r = ingest(state, "@Claude 继续", { guardLimit: 6 });
    assert.equal(r.reason, "mentioned");
    state = r.state;
  }
  assert.equal(state.agentChain, 0);
});

test("guard limit 0 disables the guard", () => {
  let state = createLocalLoop({
    participants: ["Codex", "Claude"],
    selfName: "Claude",
    turnIndex: 1,
  });
  for (let i = 0; i < 10; i++) {
    const r = ingest(state, "@Claude 继续", { senderIsAgent: true, guardLimit: 0 });
    assert.equal(r.reason, "mentioned");
    state = r.state;
  }
});
