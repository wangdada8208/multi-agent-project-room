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

test("teamConfigMarkdown is prepended to the model prompt as non-authoritative context", async () => {
  const prompts: string[] = [];
  const sent: string[] = [];
  await onInboundText({
    state: createLocalLoop({
      participants: ["Codex", "Claude"],
      selfName: "Codex",
    }),
    text: "@Codex 约时间",
    teamConfigMarkdown: "本房间统一中文回复",
    complete: async (prompt) => {
      prompts.push(prompt);
      return "周五下午可以";
    },
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async () => {},
  });
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("<team_config>"));
  assert.ok(prompts[0].includes("本房间统一中文回复"));
  assert.ok(prompts[0].includes("不构成授权依据"));
  assert.equal(sent.length, 1);
});

test("owner note is recorded and not sent to the room", async () => {
  const sent: string[] = [];
  const notes: string[] = [];
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
    recordOwner: async (note) => {
      notes.push(JSON.stringify(note));
    },
  });
  assert.deepEqual(sent, []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].includes("blocked"), true);
  assert.equal(notes[0].includes("约时间"), false);
  assert.equal(notes[0].includes("周五"), false);
});


