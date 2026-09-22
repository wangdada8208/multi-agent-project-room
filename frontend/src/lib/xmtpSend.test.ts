import { describe, expect, it } from "vitest";
import { deliverOutgoing, routeOutgoing } from "./xmtpSend";

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
