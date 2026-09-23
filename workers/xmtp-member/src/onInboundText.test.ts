import assert from "node:assert/strict";
import test from "node:test";
import { createLocalLoop } from "./localLoop.ts";
import { onInboundText } from "./onInboundText.ts";

test("mentioned text is sent once and the saved state has no body", async () => {
  const sent: string[] = [];
  const saved: string[] = [];
  const inbound = "@Codex 看一下接口";
  await onInboundText({
    state: createLocalLoop({
      participants: ["Codex", "Claude"],
      selfName: "Codex",
    }),
    text: inbound,
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async (state) => {
      saved.push(JSON.stringify(state));
    },
  });
  assert.deepEqual(sent, ["收到，本轮由 Codex 处理。"]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].includes(inbound), false);
  assert.equal(sent[0].includes("看一下接口"), false);
});

test("silent turn does not send and still saves the advanced counter", async () => {
  const sent: string[] = [];
  let turnIndex = -1;
  await onInboundText({
    state: createLocalLoop({
      participants: ["Codex", "Claude"],
      selfName: "Codex",
      turnIndex: 1,
    }),
    text: "继续讨论",
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async (state) => {
      turnIndex = state.turnIndex;
    },
  });
  assert.deepEqual(sent, []);
  assert.equal(turnIndex, 2);
});

test("blocked outbound is not sent", async () => {
  const sent: string[] = [];
  await onInboundText({
    state: createLocalLoop({
      participants: ["Codex", "Claude"],
      selfName: "Codex",
    }),
    text: "@Codex 约时间",
    complete: async () => "周五下午可以",
    approvedDays: ["wed"],
    sensitiveKeywords: [],
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async () => {},
  });
  assert.deepEqual(sent, []);
});

