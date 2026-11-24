import { describe, expect, it } from "vitest";
import { deriveDisplayMessages } from "./displayMessages";
import { toLocalChatMessage } from "../xmtpSend";
import type { HubSeatView } from "../localHelper";

const now = "2026-11-25T00:00:00.000Z";
const cloudAddress = "0x" + "ab".repeat(20);
const localAddress = "0x" + "cd".repeat(20);
const seats: HubSeatView[] = [
  { seat_id: "cloud", room_id: "room", agent_user_id: "cloud-user", owner_user_id: "owner", agent_display_name: "Muse",
    kind: "cloud-agent", source: "invite", group_status: "added", xmtp_address: cloudAddress },
  { seat_id: "local", room_id: "room", agent_user_id: "local-user", owner_user_id: "owner", agent_display_name: "Codex",
    kind: "codex", group_status: "added", xmtp_address: localAddress },
];

describe("display message derivation", () => {
  it("resolves all four XMTP actors while retaining local text and reply metadata", () => {
    const messages = ["my-inbox", "collaborator", "cloud-inbox", "local-inbox"].map((senderInboxId) => ({
      id: senderInboxId, senderInboxId, content: "<b>literal</b>", createdAt: now, replyToId: "earlier",
    }));
    const display = deriveDisplayMessages({
      transport: "xmtp", messages, seats, roomId: "room", myInboxId: "my-inbox", myUsername: "王达", userId: "owner",
      inboxAddresses: { "cloud-inbox": cloudAddress, "local-inbox": localAddress },
    });
    expect(display.map(({ actor, sourceSubtitle }) => [actor, sourceSubtitle])).toEqual([
      ["me", "我"], ["human", "协作者"], ["cloud", "云端 Agent"], ["local", "电脑端 Agent"],
    ]);
    expect(display[2]).toMatchObject({ sender_name: "Muse", trustTier: "cloud-api", replyToId: "earlier", content: "<b>literal</b>" });
    expect(display[0]).toMatchObject({ sender_id: "owner", xmtpSenderInboxId: "my-inbox" });
  });

  it("retains Hub sender IDs and classifies known cloud seats", () => {
    const message = toLocalChatMessage({ id: "msg", roomId: "room", content: "hello", senderId: "cloud-user", senderName: "Muse", senderType: "agent", createdAt: now });
    expect(deriveDisplayMessages({ transport: "hub", messages: [message], seats })).toEqual([
      { ...message, actor: "cloud", sourceSubtitle: "云端 Agent" },
    ]);
  });
});
