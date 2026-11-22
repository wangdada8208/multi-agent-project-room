import type { ChatMessage, SenderType } from "../types/chat";

export async function deliverOutgoing(input: {
  transport?: string;
  content: string;
  xmtpGroupId?: string | null;
  sendToXmtp?: (groupId: string, content: string) => Promise<void>;
}): Promise<{ delivered: boolean }> {
  if (input.transport !== "xmtp" || !input.xmtpGroupId || !input.sendToXmtp) {
    return { delivered: false };
  }
  await input.sendToXmtp(input.xmtpGroupId, input.content);
  return { delivered: true };
}

async function resolveGroupConversation(client: any, groupId: string): Promise<any> {
  if (!client) {
    throw new Error("XMTP client is not initialized");
  }
  let conversation = await client.conversations.getConversationById(groupId);
  if (!conversation && typeof client.conversations.syncAll === "function") {
    await client.conversations.syncAll();
    conversation = await client.conversations.getConversationById(groupId);
  }
  if (!conversation) {
    throw new Error(`Conversation ${groupId} not found`);
  }
  return conversation;
}

export const XMTP_TEXT_CONTENT_TYPE = {
  authorityId: "xmtp.org",
  typeId: "text",
  versionMajor: 1,
  versionMinor: 0,
} as const;

export function encodeXmtpText(text: string): {
  type: typeof XMTP_TEXT_CONTENT_TYPE;
  parameters: Record<string, string>;
  content: Uint8Array;
} {
  return {
    type: XMTP_TEXT_CONTENT_TYPE,
    parameters: {},
    content: new TextEncoder().encode(text),
  };
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 确定性幂等键：同一群、同一正文永远得到同一个键。
 * 手动重试「不确定是否送达」的消息时，XMTP 会按此键去重，避免重复入群。
 * 注意：用户刻意连发两条完全相同的文本也会被去重为同一条消息；
 * 调用方若需要强制视作独立消息，可显式传入自定义 idempotencyKey。
 */
export async function defaultIdempotencyKey(parts: string[]): Promise<string | undefined> {
  const joined = parts.join("\n");
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(joined));
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return `mapr-${hex}`;
    }
  } catch {
    // 退回轻量散列，仍保持确定性
  }
  return `mapr-${fnv1aHex(joined)}`;
}

async function idempotentSendOpts(
  explicit: string | undefined,
  parts: string[],
): Promise<{ idempotencyKey: string } | undefined> {
  const key = explicit ?? (await defaultIdempotencyKey(parts));
  return key ? { idempotencyKey: key } : undefined;
}

export async function sendXmtpMessage(options: {
  groupId: string;
  content: string;
  client?: any;
  /** 幂等键；缺省时按 (groupId, content) 派生确定性键，供手动重试去重。 */
  idempotencyKey?: string;
}): Promise<void> {
  const conversation = await resolveGroupConversation(options.client, options.groupId);
  const opts = await idempotentSendOpts(options.idempotencyKey, [
    options.groupId,
    options.content,
  ]);
  await conversation.sendText(options.content, opts);
}

/**
 * 发送 XMTP 回复消息（SDK ≥7.1 的 sendReply + Reply codec）。
 * 若对端会话不支持 sendReply，退化为带引用前缀的普通文本，保证消息仍可送达。
 */
export async function sendXmtpReply(options: {
  groupId: string;
  content: string;
  referenceId: string;
  referenceInboxId?: string;
  fallbackQuote?: string;
  client?: any;
  /** 幂等键；缺省时按 (groupId, referenceId, content) 派生确定性键。 */
  idempotencyKey?: string;
}): Promise<void> {
  const conversation = await resolveGroupConversation(options.client, options.groupId);
  const opts = await idempotentSendOpts(options.idempotencyKey, [
    options.groupId,
    options.referenceId,
    options.content,
  ]);
  if (typeof conversation.sendReply === "function") {
    await conversation.sendReply(
      {
        content: encodeXmtpText(options.content),
        reference: options.referenceId,
        referenceInboxId: options.referenceInboxId,
      },
      opts,
    );
    return;
  }
  const prefix = options.fallbackQuote ? `${options.fallbackQuote}\n` : "";
  await conversation.sendText(`${prefix}${options.content}`, opts);
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
