import { describe, expect, it, vi } from "vitest";
import {
  defaultIdempotencyKey,
  deliverOutgoing,
  encodeXmtpText,
  sendXmtpMessage,
  sendXmtpReply,
  toLocalChatMessage,
} from "./xmtpSend";

describe("deliverOutgoing", () => {
  it("does not deliver non-xmtp transports", async () => {
    const result = await deliverOutgoing({
      transport: "hub",
      content: "旧明文",
      xmtpGroupId: null,
    });
    expect(result.delivered).toBe(false);
  });
  it("does not report success when the xmtp sender is missing", async () => {
    const result = await deliverOutgoing({
      transport: "xmtp",
      content: "只有成员能看",
      xmtpGroupId: null,
    });
    expect(result.delivered).toBe(false);
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
    expect(seen).toEqual(["group-dev-1:只有成员能看"]);
  });
});

describe("defaultIdempotencyKey", () => {
  it("is deterministic for identical parts and differs across parts", async () => {
    const a = await defaultIdempotencyKey(["g1", "hello"]);
    const b = await defaultIdempotencyKey(["g1", "hello"]);
    const c = await defaultIdempotencyKey(["g1", "hello!"]);
    const d = await defaultIdempotencyKey(["g2", "hello"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^mapr-[0-9a-f]+$/);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe("sendXmtpMessage", () => {
  it("sends with sendText and does not call send", async () => {
    const sendText = vi.fn(async (_text: string, _opts?: unknown) => {});
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
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0]).toBe("phase-send-text");
    expect(send).not.toHaveBeenCalled();
  });

  it("passes a deterministic idempotencyKey so manual retries dedupe", async () => {
    const sendText = vi.fn(async (_text: string, _opts?: unknown) => {});
    const client = {
      conversations: {
        getConversationById: async () => ({ sendText }),
      },
    };
    await sendXmtpMessage({ groupId: "g-idem", content: "同一句话", client });
    await sendXmtpMessage({ groupId: "g-idem", content: "同一句话", client });
    const first = sendText.mock.calls[0][1] as { idempotencyKey: string };
    const second = sendText.mock.calls[1][1] as { idempotencyKey: string };
    expect(first.idempotencyKey).toMatch(/^mapr-/);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  it("derives different keys for different content and honors an explicit override", async () => {
    const sendText = vi.fn(async (_text: string, _opts?: unknown) => {});
    const client = {
      conversations: {
        getConversationById: async () => ({ sendText }),
      },
    };
    await sendXmtpMessage({ groupId: "g-idem", content: "A", client });
    await sendXmtpMessage({ groupId: "g-idem", content: "B", client });
    await sendXmtpMessage({
      groupId: "g-idem",
      content: "B",
      client,
      idempotencyKey: "custom-key-1",
    });
    const keyA = (sendText.mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey;
    const keyB = (sendText.mock.calls[1][1] as { idempotencyKey: string }).idempotencyKey;
    const keyCustom = (sendText.mock.calls[2][1] as { idempotencyKey: string }).idempotencyKey;
    expect(keyA).not.toBe(keyB);
    expect(keyCustom).toBe("custom-key-1");
  });
});

describe("sendXmtpMessage after being added to a group", () => {
  it("syncs once when the group is not known locally yet", async () => {
    const sendText = vi.fn(async (_text: string, _opts?: unknown) => {});
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
    expect(sendText.mock.calls[0][0]).toBe("hi");
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


describe("sendXmtpReply", () => {
  it("sends a real XMTP reply with an encoded text body and reference", async () => {
    const sendReply = vi.fn(async (_reply: unknown) => "msg-id");
    const sendText = vi.fn(async (_text: string) => {});
    const client = {
      conversations: {
        getConversationById: async () => ({ sendReply, sendText }),
      },
    };
    await sendXmtpReply({
      groupId: "group-r1",
      content: "回复正文",
      referenceId: "orig-msg-1",
      referenceInboxId: "inbox-xyz",
      client,
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledTimes(1);
    const reply = sendReply.mock.calls[0][0] as {
      reference: string;
      referenceInboxId?: string;
      content: { type: { typeId: string }; parameters: Record<string, string>; content: Uint8Array };
    };
    expect(reply.reference).toBe("orig-msg-1");
    expect(reply.referenceInboxId).toBe("inbox-xyz");
    expect(reply.content.type.typeId).toBe("text");
    expect(reply.content.type).toMatchObject({ authorityId: "xmtp.org", versionMajor: 1, versionMinor: 0 });
    expect(new TextDecoder().decode(reply.content.content)).toBe("回复正文");
  });

  it("falls back to quoted text when the conversation has no sendReply", async () => {
    const sendText = vi.fn(async (_text: string, _opts?: unknown) => {});
    const client = {
      conversations: {
        getConversationById: async () => ({ sendText }),
      },
    };
    await sendXmtpReply({
      groupId: "group-r2",
      content: "正文",
      referenceId: "orig-1",
      fallbackQuote: "↩ Alice: 原消息摘录",
      client,
    });
    expect(sendText.mock.calls[0][0]).toBe("↩ Alice: 原消息摘录\n正文");
  });

  it("passes an idempotencyKey to sendReply derived from group, reference and content", async () => {
    const sendReply = vi.fn(async (_reply: unknown, _opts?: unknown) => "msg-id");
    const client = {
      conversations: {
        getConversationById: async () => ({ sendReply }),
      },
    };
    const base = { groupId: "g-r", content: "同一回复", referenceId: "orig-9", client };
    await sendXmtpReply(base);
    await sendXmtpReply(base);
    const optsA = sendReply.mock.calls[0][1] as { idempotencyKey: string };
    const optsB = sendReply.mock.calls[1][1] as { idempotencyKey: string };
    expect(optsA.idempotencyKey).toBe(optsB.idempotencyKey);
    await sendXmtpReply({ ...base, referenceId: "orig-10" });
    const optsC = sendReply.mock.calls[2][1] as { idempotencyKey: string };
    expect(optsC.idempotencyKey).not.toBe(optsA.idempotencyKey);
  });

  it("syncs once when the group is not known locally yet", async () => {
    const sendReply = vi.fn(async (_reply: unknown) => "ok");
    let synced = false;
    const client = {
      conversations: {
        syncAll: vi.fn(async () => {
          synced = true;
        }),
        getConversationById: async () => (synced ? { sendReply } : undefined),
      },
    };
    await sendXmtpReply({ groupId: "group-new", content: "hi", referenceId: "r", client });
    expect(client.conversations.syncAll).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  it("throws when the group is missing after sync", async () => {
    const client = {
      conversations: {
        syncAll: async () => {},
        getConversationById: async () => undefined,
      },
    };
    await expect(
      sendXmtpReply({ groupId: "group-x", content: "hi", referenceId: "r", client }),
    ).rejects.toThrow("not found");
  });
});

describe("encodeXmtpText", () => {
  it("produces the standard xmtp.org/text:1.0 encoded content", () => {
    const encoded = encodeXmtpText("hello");
    expect(encoded.type).toEqual({
      authorityId: "xmtp.org",
      typeId: "text",
      versionMajor: 1,
      versionMinor: 0,
    });
    expect(encoded.parameters).toEqual({});
    expect(new TextDecoder().decode(encoded.content)).toBe("hello");
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
