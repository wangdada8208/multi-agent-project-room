import { describe, expect, it } from "vitest";
import { routeOutgoing } from "./xmtpSend";

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
