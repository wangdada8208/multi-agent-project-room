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
  await conversation.send(options.content);
}
