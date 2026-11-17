import assert from "node:assert/strict";
import test from "node:test";
import { loadConfigFromEnv } from "./index.ts";
import { createLocalLoop, ingest } from "./localLoop.ts";
import { decideReply, hasBroadcastMention } from "./turnPolicy.ts";

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

test("hasBroadcastMention recognizes @all and @全体 without matching substrings or emails", () => {
  assert.equal(hasBroadcastMention("@all 大家给个意见"), true);
  assert.equal(hasBroadcastMention("请 @ALL 同步方案"), true);
  assert.equal(hasBroadcastMention("@全体 报一下进度"), true);
  assert.equal(hasBroadcastMention("辛苦@全体，对齐一下"), true);
  assert.equal(hasBroadcastMention("contact@all.example.com"), false);
  assert.equal(hasBroadcastMention("@allen 你好"), false);
  assert.equal(hasBroadcastMention("@all-hands meeting"), false);
  assert.equal(hasBroadcastMention("user@全体"), false);
});

test("broadcast mention wakes every seat even when participants is empty, while respecting loop_guard", () => {
  for (const selfName of ["Claude Code", "Codex", "Grok", "Muse"]) {
    // Unmentioned in mention-only mode (participants = []) stays silent on every turn
    assert.deepEqual(
      decideReply({ text: "随便聊聊", selfName, participants: [], turnIndex: 0 }),
      { reply: false, reason: "not_this_turn" }
    );
    // Broadcast @all and @全体 wake every seat
    assert.deepEqual(
      decideReply({ text: "@all 大家给个意见", selfName, participants: [], turnIndex: 0 }),
      { reply: true, reason: "mentioned" }
    );
    assert.deepEqual(
      decideReply({ text: "@全体 报一下进度", selfName, participants: [], turnIndex: 3 }),
      { reply: true, reason: "mentioned" }
    );
  }

  // Guardrail still pauses broadcast mentions from runaway agent chains
  let state = createLocalLoop({ participants: [], selfName: "Grok" });
  for (let i = 0; i < 5; i++) {
    state = ingest(state, "@all 继续", { senderIsAgent: true, guardLimit: 6 }).state;
  }
  const guarded = ingest(state, "@全体 还要继续吗", { senderIsAgent: true, guardLimit: 6 });
  assert.equal(guarded.reason, "loop_guard");
});

test("loadConfigFromEnv sets participants=[] when XMTP_MENTION_ONLY=1 and XMTP_PARTICIPANTS is unset", () => {
  const mentionOnlyCfg = loadConfigFromEnv({ XMTP_MENTION_ONLY: "1", XMTP_SELF_NAME: "Codex" });
  assert.deepEqual(mentionOnlyCfg.participants, []);

  const explicitCfg = loadConfigFromEnv({
    XMTP_MENTION_ONLY: "1",
    XMTP_PARTICIPANTS: "Codex, Claude",
  });
  assert.deepEqual(explicitCfg.participants, ["Codex", "Claude"]);

  const legacyCfg = loadConfigFromEnv({});
  assert.deepEqual(legacyCfg.participants, ["Codex", "Claude"]);
});

test("longest-match-first @Agent mention resolution prevents prefix collision (Gemini vs Gemini CLI)", () => {
  // 1. "@Gemini CLI 你好" wakes "Gemini CLI", NOT "Gemini"
  assert.deepEqual(
    decideReply({
      text: "@Gemini CLI 你好",
      selfName: "Gemini",
      participants: [],
      peerNames: ["Gemini CLI"],
      turnIndex: 0,
    }),
    { reply: false, reason: "not_this_turn" }
  );
  assert.deepEqual(
    decideReply({
      text: "@Gemini CLI 你好",
      selfName: "Gemini CLI",
      participants: [],
      peerNames: ["Gemini"],
      turnIndex: 0,
    }),
    { reply: true, reason: "mentioned" }
  );

  // 2. "@Gemini @Gemini CLI 你好" wakes BOTH "Gemini" and "Gemini CLI"
  assert.deepEqual(
    decideReply({
      text: "@Gemini @Gemini CLI 你好",
      selfName: "Gemini",
      participants: [],
      peerNames: ["Gemini CLI"],
      turnIndex: 0,
    }),
    { reply: true, reason: "mentioned" }
  );
  assert.deepEqual(
    decideReply({
      text: "@Gemini @Gemini CLI 你好",
      selfName: "Gemini CLI",
      participants: [],
      peerNames: ["Gemini"],
      turnIndex: 0,
    }),
    { reply: true, reason: "mentioned" }
  );

  // 3. Reversed order "@Gemini CLI @Gemini 你好" also wakes BOTH, and ingest forwards peerNames
  const loopShort = createLocalLoop({ participants: [], selfName: "Claude" });
  assert.equal(
    ingest(loopShort, "@Claude Code 帮我看下", { peerNames: ["Claude Code"] }).reason,
    "not_this_turn"
  );
  assert.equal(
    ingest(loopShort, "@Claude Code 和 @Claude 都帮我看下", { peerNames: ["Claude Code"] }).reason,
    "mentioned"
  );
});
