import { describe, expect, it, vi } from "vitest";
import { deliverOutgoing, routeOutgoing, sendXmtpMessage, toLocalChatMessage } from "./xmtpSend";

describe("routeOutgoing", () => {
  it("does not put xmtp room text into the hub payload", () => {
    const route = routeOutgoing({
      transport: "xmtp",
      content: "只有成员能看",
    });
    expect(route.channel).toBe("xmtp");
    expect(route.hubPayload).toBeNull();
  });
});

describe("deliverOutgoing", () => {
  it("treats a missing transport as not deliverable on the hub", async () => {
    const result = await deliverOutgoing({
      transport: "hub",
      content: "旧明文",
      xmtpGroupId: null,
    });
    expect(result.delivered).toBe(false);
    expect(result.hubPayload).toBeNull();
  });
  it("does not report success when the xmtp sender is missing", async () => {
    const result = await deliverOutgoing({
      transport: "xmtp",
      content: "只有成员能看",
      xmtpGroupId: null,
    });
    expect(result.delivered).toBe(false);
    expect(result.hubPayload).toBeNull();
  });

  it("reports success only after the xmtp sender resolves", async () => {
    const seen: string[] = [];
    const result = await deliverOutgoing({
      transport: "xmtp",
      content: "只有成员能看",
      xmtpGroupId: "group-dev-1",
      sendToXmtp: async (groupId, content) => {
        seen.push(`${groupId}:${content}`);
      },
    });
    expect(result.delivered).toBe(true);
    expect(result.hubPayload).toBeNull();
    expect(seen).toEqual(["group-dev-1:只有成员能看"]);
  });
});

describe("sendXmtpMessage", () => {
  it("sends with sendText and does not call send", async () => {
    const sendText = vi.fn(async (_text: string) => {});
    const send = vi.fn(async (_text: string) => {});
    const client = {
      conversations: {
        getConversationById: async () => ({ sendText, send }),
      },
    };
    await sendXmtpMessage({
      groupId: "group-dev-2",
      content: "phase-send-text",
      client,
    });
    expect(sendText).toHaveBeenCalledWith("phase-send-text");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("sendXmtpMessage after being added to a group", () => {
  it("syncs once when the group is not known locally yet", async () => {
    const sendText = vi.fn(async (_text: string) => {});
    let synced = false;
    const client = {
      conversations: {
        syncAll: vi.fn(async () => {
          synced = true;
        }),
        getConversationById: async () => (synced ? { sendText } : undefined),
      },
    };
    await sendXmtpMessage({ groupId: "group-new", content: "hi", client });
    expect(client.conversations.syncAll).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("hi");
  });

  it("still throws when the group is missing after sync", async () => {
    const client = {
      conversations: {
        syncAll: async () => {},
        getConversationById: async () => undefined,
      },
    };
    await expect(sendXmtpMessage({ groupId: "group-x", content: "hi", client })).rejects.toThrow("not found");
  });
});


describe("toLocalChatMessage", () => {
  it("builds a local chat message without a hub id", () => {
    const message = toLocalChatMessage({
      roomId: "room-1",
      content: "成员端可见",
      senderId: "me",
      senderName: "我",
    });
    expect(message.room_id).toBe("room-1");
    expect(message.content).toBe("成员端可见");
    expect(message.id.length).toBeGreaterThan(0);
  });
});
