import { resolveXmtpSender } from "../roomIdentity";
import type { HubSeatView, TrustTier } from "../localHelper";
import { toLocalChatMessage } from "../xmtpSend";
import type { ChatMessage } from "../../types/chat";

export type ActorKind = "me" | "human" | "cloud" | "local";
export interface RawXmtpMessage {
  id: string;
  senderInboxId: string;
  content: string;
  createdAt: string;
  replyToId?: string;
}
export interface DisplayMessage extends ChatMessage {
  actor: ActorKind;
  sourceSubtitle: string;
  trustTier?: TrustTier;
  replyToId?: string;
  xmtpSenderInboxId?: string;
}

function enrich(message: ChatMessage, me: boolean, seat?: HubSeatView, trustTier?: TrustTier): DisplayMessage {
  const actor: ActorKind = me ? "me" : message.sender_type !== "agent" ? "human"
    : seat?.source === "invite" || seat?.kind === "cloud-agent" ? "cloud" : "local";
  const sourceSubtitle = { me: "我", human: "协作者", cloud: "云端 Agent", local: "电脑端 Agent" }[actor];
  return { ...message, actor, sourceSubtitle, ...(trustTier ? { trustTier } : {}) };
}

type Source =
  | { transport: "hub"; messages: readonly ChatMessage[]; seats: readonly HubSeatView[]; userId?: string }
  | {
      transport: "xmtp"; messages: readonly RawXmtpMessage[]; inboxAddresses: Record<string, string>;
      seats: HubSeatView[]; roomId: string; myInboxId: string; myUsername: string; userId?: string;
    };

export function deriveDisplayMessages(source: Source): DisplayMessage[] {
  if (source.transport === "hub") {
    return source.messages.map((message) => enrich(message, message.sender_id === source.userId,
      source.seats.find((seat) => seat.agent_user_id === message.sender_id)));
  }
  const { messages, inboxAddresses, seats, roomId, myInboxId, myUsername, userId } = source;
  return messages.map((raw) => {
    const resolved = resolveXmtpSender({ senderInboxId: raw.senderInboxId, myInboxId, myUsername, inboxAddresses, seats });
    const me = Boolean(myInboxId && raw.senderInboxId === myInboxId);
    const seat = seats.find((item) => item.group_status !== "removed" && item.xmtp_address.toLowerCase() === resolved.address)
      ?? seats.find((item) => item.xmtp_address.toLowerCase() === resolved.address);
    const message = toLocalChatMessage({
      id: raw.id, roomId, content: raw.content,
      senderId: me ? userId ?? raw.senderInboxId : raw.senderInboxId,
      senderName: resolved.senderName, senderType: resolved.senderType, createdAt: raw.createdAt,
    });
    return {
      ...enrich(message, me, seat, resolved.trustTier),
      xmtpSenderInboxId: raw.senderInboxId,
      ...(raw.replyToId ? { replyToId: raw.replyToId } : {}),
    };
  });
}
