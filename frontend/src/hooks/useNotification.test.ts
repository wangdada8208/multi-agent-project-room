import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types/chat";
import {
  createNotificationTrackerState,
  evaluateNotificationPayloads,
} from "./useNotification";

function makeMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    id: overrides.id,
    room_id: overrides.room_id ?? "room-1",
    sender_id: overrides.sender_id ?? "seat-claude",
    sender_name: overrides.sender_name ?? "Claude Code",
    sender_type: overrides.sender_type ?? "agent",
    content: overrides.content ?? "已完成代码检查",
    msg_type: overrides.msg_type ?? "text",
    created_at: overrides.created_at ?? "2026-11-18T00:00:00Z",
  };
}

describe("evaluateNotificationPayloads", () => {
  it("suppresses historical messages during async XMTP/REST load and fires emoji-free notifications only for live agent replies", () => {
    const tracker = createNotificationTrackerState();

    // 1. Mount while history is still loading (ready: false) with empty array
    expect(
      evaluateNotificationPayloads(tracker, {
        messages: [],
        scopeKey: "room-1",
        ready: false,
        enabled: true,
        currentUserId: "user-me",
      }),
    ).toEqual([]);

    // 2. First ready pass arrives with historical messages -> baselined, 0 notifications
    const history = [makeMessage({ id: "hist-1" }), makeMessage({ id: "hist-2" })];
    expect(
      evaluateNotificationPayloads(tracker, {
        messages: history,
        scopeKey: "room-1",
        ready: true,
        enabled: true,
        currentUserId: "user-me",
      }),
    ).toEqual([]);

    // 3. Live agent reply + human reply arrive -> only live agent reply notifies, zero emojis in title
    const live = [
      ...history,
      makeMessage({ id: "human-1", sender_id: "user-other", sender_type: "human", sender_name: "林蔚" }),
      makeMessage({ id: "live-agent-1", sender_name: "Codex", content: "修复方案已提交" }),
    ];
    const payloads = evaluateNotificationPayloads(tracker, {
      messages: live,
      scopeKey: "room-1",
      ready: true,
      enabled: true,
      currentUserId: "user-me",
    });

    expect(payloads).toEqual([
      {
        title: "Codex 回复了",
        body: "修复方案已提交",
        tag: "live-agent-1",
      },
    ]);
    expect(/\p{Extended_Pictographic}/u.test(payloads[0].title)).toBe(false);
  });

  it("resets baseline when switching rooms so another room's history does not spam notifications", () => {
    const tracker = createNotificationTrackerState();

    evaluateNotificationPayloads(tracker, {
      messages: [makeMessage({ id: "r1-m1", room_id: "room-1" })],
      scopeKey: "room-1",
      ready: true,
      enabled: true,
    });

    // Switch to room-2 with existing history
    const room2Pass = evaluateNotificationPayloads(tracker, {
      messages: [makeMessage({ id: "r2-hist-1", room_id: "room-2" })],
      scopeKey: "room-2",
      ready: true,
      enabled: true,
    });
    expect(room2Pass).toEqual([]);
  });
});
