import { describe, expect, it, vi } from "vitest";
import { deliverOutgoing, routeOutgoing, sendXmtpMessage } from "./xmtpSend";

describe("routeOutgoing", () => {
  it("keeps hub rooms on the websocket payload", () => {
    const route = routeOutgoing({
      transport: "hub",
      content: "hello",
    });
    expect(route.channel).toBe("hub");
    expect(route.hubPayload?.content).toBe("hello");
  });

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
