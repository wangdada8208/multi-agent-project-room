import { useCallback, useEffect, useState } from "react";
import { describeEnvelope } from "../../lib/envelopeView";
import { buildInboxAddressMap, type XmtpMemberLike } from "../../lib/roomIdentity";
import { extractXmtpMessageText } from "../../lib/xmtpSearch";
import type { RawXmtpMessage } from "../../lib/domain/displayMessages";
import type { XmtpSessionEvent } from "../../lib/domain/xmtpSession";
import type { RoomXmtpClient } from "./useXmtpSession";
import type { DecodedMessage } from "@xmtp/browser-sdk";
import { XMTP_NETWORK_ERROR_MESSAGE } from "../../lib/xmtpLocalIdentity";

const emptyMessages: RawXmtpMessage[] = [];
const emptyAddresses: Record<string, string> = {};

export function useXmtpMessages(client: RoomXmtpClient | null, groupId: string | null | undefined, retry: number, dispatch: (event: XmtpSessionEvent) => void) {
  const [history, setHistory] = useState<{ groupId: string; messages: RawXmtpMessage[] }>();
  const [addresses, setAddresses] = useState<{ groupId: string; map: Record<string, string> }>();
  const updateInboxMap = useCallback((members: XmtpMemberLike[]) => {
    if (!groupId) return;
    const map = buildInboxAddressMap(members);
    setAddresses((previous) => {
      if (previous?.groupId === groupId && Object.keys(previous.map).length === Object.keys(map).length &&
        Object.entries(map).every(([key, value]) => previous.map[key] === value)) return previous;
      return { groupId, map };
    });
  }, [groupId]);

  useEffect(() => {
    if (!client || !groupId) return;
    let active = true;
    let stop: (() => void) | undefined;
    dispatch({ type: "connect" });

    function toEntry(message: DecodedMessage): RawXmtpMessage | null {
      if (message.conversationId !== groupId) return null;
      const extracted = extractXmtpMessageText(message);
      if (!extracted) return null;
      return {
        id: String(message.id),
        senderInboxId: String(message.senderInboxId ?? ""),
        content: describeEnvelope(extracted.text) ?? extracted.text,
        createdAt: message.sentAt instanceof Date ? message.sentAt.toISOString() : new Date().toISOString(),
        ...(extracted.replyToId ? { replyToId: extracted.replyToId } : {}),
      };
    }

    function upsert(targetGroupId: string, entries: RawXmtpMessage[]) {
      if (entries.length === 0) return;
      setHistory((previous) => {
        const byId = new Map(previous?.groupId === targetGroupId ? previous.messages.map((entry) => [entry.id, entry]) : []);
        const oldSize = byId.size;
        for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
        if (byId.size === oldSize) return previous;
        const messages = [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
        return { groupId: targetGroupId, messages };
      });
    }

    async function listen(targetGroupId: string, listeningClient: RoomXmtpClient) {
      try {
        const stream = await listeningClient.conversations.streamAllMessages();
        stop = () => { void stream.return().catch(() => {}); };
        if (!active) return;
        await listeningClient.conversations.syncAll();
        const group = await listeningClient.conversations.getConversationById(targetGroupId);
        if (!active) return;
        if (!group) {
          dispatch({ type: "notInGroup", groupId: targetGroupId });
          return;
        }
        await group.sync();
        const members = typeof group.members === "function" ? await group.members() : [];
        const initial = (await group.messages()).map(toEntry).filter((entry) => entry !== null);
        if (!active) return;
        updateInboxMap(members);
        upsert(targetGroupId, initial);
        dispatch({ type: "ready", groupId: targetGroupId });

        let knownAddresses = buildInboxAddressMap(members);
        for await (const message of stream) {
          if (!active) return;
          if (!message) continue;
          const entry = toEntry(message);
          if (!entry) continue;
          upsert(targetGroupId, [entry]);
          if (entry.senderInboxId !== listeningClient.inboxId && !knownAddresses[entry.senderInboxId]) {
            void group.sync().then(async () => {
              const updated = typeof group.members === "function" ? await group.members() : [];
              if (!active) return;
              knownAddresses = buildInboxAddressMap(updated);
              updateInboxMap(updated);
            }).catch(() => {});
          }
        }
        if (active) dispatch({ type: "failed", message: XMTP_NETWORK_ERROR_MESSAGE, reason: "stream" });
      } catch {
        if (active) dispatch({ type: "failed", message: XMTP_NETWORK_ERROR_MESSAGE, reason: "stream" });
      } finally {
        stop?.();
        stop = undefined;
      }
    }

    void listen(groupId, client);
    return () => {
      active = false;
      stop?.();
      stop = undefined;
    };
  }, [client, groupId, retry, dispatch, updateInboxMap]);

  return {
    rawXmtpMessages: history?.groupId === groupId && history ? history.messages : emptyMessages,
    inboxAddresses: addresses?.groupId === groupId && addresses ? addresses.map : emptyAddresses,
    updateInboxMap,
  };
}
