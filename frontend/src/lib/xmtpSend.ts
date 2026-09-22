import type { ChatMessage, SenderType } from "../types/chat";

export interface RouteOutgoingInput {
  transport?: string;
  content: string;
}

export interface RouteOutgoingResult {
  channel: "hub" | "xmtp";
  hubPayload: { content: string } | null;
}

export function routeOutgoing(input: RouteOutgoingInput): RouteOutgoingResult {
  if (input.transport === "xmtp") {
    return {
      channel: "xmtp",
      hubPayload: null,
    };
  }

  return {
    channel: "hub",
    hubPayload: {
      content: input.content,
    },
  };
}

export async function deliverOutgoing(input: {
  transport?: string;
  content: string;
  xmtpGroupId?: string | null;
  sendToXmtp?: (groupId: string, content: string) => Promise<void>;
}): Promise<{ delivered: boolean; hubPayload: { content: string } | null }> {
  const route = routeOutgoing({
    transport: input.transport,
    content: input.content,
  });
  if (route.hubPayload) {
    return { delivered: true, hubPayload: route.hubPayload };
  }
  if (!input.xmtpGroupId || !input.sendToXmtp) {
    return { delivered: false, hubPayload: null };
  }
  await input.sendToXmtp(input.xmtpGroupId, input.content);
  return { delivered: true, hubPayload: null };
}

export async function sendXmtpMessage(options: {
  groupId: string;
  content: string;
  client?: any;
}): Promise<void> {
  if (!options.client) {
    throw new Error("XMTP client is not initialized");
  }
  const conversation = await options.client.conversations.getConversationById(options.groupId);
  if (!conversation) {
    throw new Error(`Conversation ${options.groupId} not found`);
  }
  await conversation.sendText(options.content);
}

export function toLocalChatMessage(input: {
  roomId: string;
  content: string;
  senderId: string;
  senderName: string;
  senderType?: SenderType;
  id?: string;
  createdAt?: string;
}): ChatMessage {
  const genId = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  };
  return {
    id: input.id ?? genId(),
    room_id: input.roomId,
    sender_id: input.senderId,
    sender_type: input.senderType ?? "human",
    sender_name: input.senderName,
    msg_type: "text",
    content: input.content,
    created_at: input.createdAt ?? new Date().toISOString(),
  };
}
