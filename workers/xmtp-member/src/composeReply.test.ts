import assert from "node:assert/strict";
import test from "node:test";
import { composeReply } from "./composeReply.ts";

test("silent turn does not call the model", async () => {
  let calls = 0;
  const outbound = await composeReply({
    shouldReply: false,
    selfName: "Codex",
    inbound: "继续讨论",
    complete: async () => {
      calls += 1;
      return "模型回复";
    },
  });
  assert.equal(outbound, null);
  assert.equal(calls, 0);
});

test("reply turn uses the model text", async () => {
  const outbound = await composeReply({
    shouldReply: true,
    selfName: "Codex",
    inbound: "@Codex 看一下接口",
    complete: async (prompt) => {
      assert.equal(prompt.includes("@Codex 看一下接口"), true);
      assert.equal(prompt.includes("Codex"), true);
      return "接口可以保持现有路径。";
    },
  });
  assert.equal(outbound, "接口可以保持现有路径。");
});

test("empty model text falls back to the placeholder", async () => {
  const outbound = await composeReply({
    shouldReply: true,
    selfName: "Codex",
    inbound: "@Codex 在吗",
    complete: async () => "   ",
  });
  assert.equal(outbound, "收到，本轮由 Codex 处理。");
});
