import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { searchMessages } from "../../lib/api";
import type { DisplayMessage, RawXmtpMessage } from "../../lib/domain/displayMessages";
import { toLocalChatMessage } from "../../lib/xmtpSend";
import { XmtpSearchIndex } from "../../lib/xmtpSearch";
import type { ChatMessage } from "../../types/chat";

export function useMessageSearch({ roomId, transport, groupId, rawMessages, displayById }: {
  roomId: string; transport?: string; groupId?: string | null;
  rawMessages: RawXmtpMessage[]; displayById: ReadonlyMap<string, DisplayMessage>;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<ChatMessage[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchSender, setSearchSender] = useState("");
  const [searchError, setSearchError] = useState("");
  const sequence = useRef(0);
  const index = useMemo(() => new XmtpSearchIndex(), [roomId, groupId, transport]);

  useEffect(() => {
    if (transport === "xmtp") index.ingest(rawMessages);
  }, [index, transport, rawMessages]);

  const handleSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query || !transport) return;
    setSearchError("");
    if (transport === "xmtp") {
      setSearchResults(index.search(query, { senderInboxId: searchSender || undefined }).map((entry) => {
        const display = displayById.get(entry.id);
        return toLocalChatMessage({
          id: entry.id, roomId, content: entry.content, senderId: entry.senderInboxId,
          senderName: display?.sender_name ?? entry.senderInboxId.slice(0, 8),
          senderType: display?.sender_type ?? "human", createdAt: entry.createdAt,
        });
      }));
      return;
    }
    const request = ++sequence.current;
    setIsSearching(true);
    try {
      const results = await searchMessages(roomId, query);
      if (request === sequence.current) setSearchResults(results);
    } catch {
      if (request === sequence.current) {
        setSearchResults([]);
        setSearchError("搜索失败，请重试。");
      }
    } finally {
      if (request === sequence.current) setIsSearching(false);
    }
  }, [searchQuery, searchSender, transport, index, displayById, roomId]);

  useEffect(() => {
    if (transport === "xmtp" && showSearch && searchQuery.trim()) void handleSearch();
  }, [transport, showSearch, searchQuery, handleSearch]);

  useEffect(() => {
    setSearchResults([]);
    setSearchError("");
    setIsSearching(false);
    return () => { sequence.current += 1; };
  }, [index]);

  function closeSearch() {
    sequence.current += 1;
    setShowSearch(false);
    setSearchResults([]);
    setSearchError("");
    setSearchQuery("");
    setSearchSender("");
    setIsSearching(false);
  }

  const xmtpSenderOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const message of displayById.values()) {
      if (message.xmtpSenderInboxId && !options.has(message.xmtpSenderInboxId)) {
        options.set(message.xmtpSenderInboxId, message.sender_name ?? message.sender_id.slice(0, 8));
      }
    }
    return [...options.entries()];
  }, [displayById]);

  return { searchQuery, setSearchQuery, showSearch, setShowSearch, searchResults, isSearching, searchSender,
    setSearchSender, xmtpSenderOptions, handleSearch, closeSearch, searchError };
}
