import { useCallback, useEffect, useMemo, useRef } from "react";
import { useChatStore, sanitizeTaskPatch, isTaskProgressEvent } from "../stores/chatStore";
import type { ChatMessage, MessageType, RoomSocketEvent, SenderType } from "../types/chat";

import { useAuthStore } from "../stores/authStore";
import { websocketUrl, apiFetch } from "../lib/api";
import { deliverOutgoing } from "../lib/xmtpSend";

interface SendMessageInput {
  content: string;
  senderId: string;
  senderType: SenderType;
  msgType?: MessageType;
  transport?: string;
  xmtpGroupId?: string | null;
  sendToXmtp?: (groupId: string, content: string) => Promise<void>;
}

function getWebSocketUrl(roomId: string): string {
  const token = localStorage.getItem("mapr-auth-token") ?? "";
  return websocketUrl(`/ws/chat/${roomId}?token=${encodeURIComponent(token)}`);
}

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 10000;

function getReconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), RECONNECT_MAX_DELAY_MS);
}

async function fetchMissedMessages(roomId: string, afterTimestamp: string | null, cursor: number, page: number) {
  try {
    const params = new URLSearchParams({ limit: "100", after_seq: String(cursor), page: String(page) });
    if (afterTimestamp) params.set("after", afterTimestamp);
    const res = await apiFetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/messages?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const messages = data.messages ?? data.data;
    if (!Array.isArray(messages)) return null;
    return { messages: messages as ChatMessage[], nextCursor: data.next_cursor as unknown, hasMore: data.has_more as unknown };
  } catch { return null; }
}

export function useWebSocket(roomId: string, transport: string = "xmtp") {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);

  const addMessage = useChatStore((state) => state.addMessage);
  const markTyping = useChatStore((state) => state.markTyping);
  const setParticipants = useChatStore((state) => state.setParticipants);
  const upsertParticipant = useChatStore((state) => state.upsertParticipant);
  const removeParticipant = useChatStore((state) => state.removeParticipant);
  const upsertTask = useChatStore((state) => state.upsertTask);
  const updateTaskProgress = useChatStore((state) => state.updateTaskProgress);
  const setConnectionStatus = useChatStore((state) => state.setConnectionStatus);

  useEffect(() => {
    let disposed = false;
    let needsCatchUp = false;
    let gapTimestamp: string | null = null;
    let snapshotPresence = false;
    setParticipants([]);
    const taskFetches = new Map<string, Promise<void>>();

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = (socket: WebSocket) => {
      if (disposed || reconnectTimerRef.current !== null) return;
      if (socketRef.current === socket) socketRef.current = null;

      if (!needsCatchUp) {
        // Use server timestamps, not the client clock; overlap equal timestamps.
        const timestamps = useChatStore.getState().messages.filter((message) => message.room_id === roomId && !message.id.startsWith("sys-"))
          .map((message) => Date.parse(message.created_at)).filter(Number.isFinite);
        gapTimestamp = timestamps.length ? new Date(Math.max(...timestamps) - 1).toISOString() : null;
      }
      needsCatchUp = true;

      reconnectAttemptRef.current += 1;
      const delay = getReconnectDelay(reconnectAttemptRef.current);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!disposed) connect();
      }, delay);
    };

    const catchUpMissedMessages = async (socket: WebSocket) => {
      if (transport === "xmtp" || !needsCatchUp) return;
      // Start at zero: a largest-seen sequence could hide a gap in WS delivery.
      // Server retention bounds this replay; IDs deduplicate HTTP and WS overlap.
      let cursor = 0;
      const seen = new Set<string>();
      for (let page = 1; page <= 100; page++) {
        const batch = await fetchMissedMessages(roomId, gapTimestamp, cursor, page);
        if (disposed || socketRef.current !== socket || !batch) return;
        let fresh = 0;
        for (const message of batch.messages) {
          if (!message || message.room_id !== roomId) continue;
          if (!seen.has(message.id)) { seen.add(message.id); fresh++; }
          addMessage(message);
        }
        if (batch.hasMore === false || (batch.hasMore !== true && batch.messages.length < 100)) {
          needsCatchUp = false;
          gapTimestamp = null;
          return;
        }
        if (!fresh) return; // Legacy servers may ignore paging; never loop forever.
        if (typeof batch.nextCursor === "number" && Number.isSafeInteger(batch.nextCursor) && batch.nextCursor > cursor)
          cursor = batch.nextCursor;
      }
    };

    const connect = () => {
      clearReconnectTimer();
      const token = localStorage.getItem("mapr-auth-token");
      if (!token) {
        setConnectionStatus("idle");
        return;
      }
      setConnectionStatus("connecting");

      const socket = new WebSocket(getWebSocketUrl(roomId));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed || socketRef.current !== socket) return;
        reconnectAttemptRef.current = 0;
        setConnectionStatus("open");
        const auth = useAuthStore.getState();
        if (auth.user) {
          socket.send(JSON.stringify({
            type: "identify",
            sender_id: auth.user.id,
            sender_name: auth.user.display_name,
            sender_type: auth.user.user_type,
          }));
        }
        // Fetch messages sent while disconnected
        void catchUpMissedMessages(socket);
      });

      socket.addEventListener("close", (event) => {
        if (disposed || socketRef.current !== socket) return;
        setConnectionStatus("closed");
        if (event.code === 4001) {
          // Authentication required; do not endlessly hammer the server
          return;
        }
        scheduleReconnect(socket);
      });

      socket.addEventListener("error", () => {
        if (disposed || socketRef.current !== socket) return;
        setConnectionStatus("error");
        scheduleReconnect(socket);
        socket.close();
      });

      const hydrateTask = (taskId: string): Promise<void> => {
        const pending = taskFetches.get(taskId);
        if (pending) return pending;
        const fetch = apiFetch(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
          .then(async (response) => {
            if (!response.ok) return;
            const data = await response.json();
            if (disposed || socketRef.current !== socket || data.task?.id !== taskId || data.task?.room_id !== roomId) return;
            upsertTask(data.task);
          }).catch(() => { /* The next reconciliation or room refresh retries. */ })
          .finally(() => { taskFetches.delete(taskId); });
        taskFetches.set(taskId, fetch);
        return fetch;
      };

      socket.addEventListener("message", (event) => {
        if (disposed || socketRef.current !== socket) return;
        let payload: RoomSocketEvent;
        try {
          payload = JSON.parse(event.data);
        } catch (error) {
          console.warn("Failed to parse room socket event");
          return;
        }

        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

        if (transport !== "xmtp" && payload.type === "message" && payload.message?.room_id === roomId) {
          addMessage(payload.message);
        }

        if (payload.type === "system" && payload.content) {
          addMessage({
            id: `sys-${Date.now()}`,
            room_id: roomId,
            sender_id: "system",
            sender_type: "system",
            content: payload.content,
            msg_type: "system",
            created_at: new Date().toISOString(),
          });
        }

        if (payload.type === "typing") {
          markTyping(payload.sender_id);
        }

        if (payload.type === "presence_snapshot") {
          if (payload.room_id !== undefined && payload.room_id !== roomId) return;
          if (!Array.isArray(payload.participants)) return;
          snapshotPresence = true;
          setParticipants(payload.participants);
        }

        if (payload.type === "user_online" && payload.participant && !snapshotPresence && (payload.room_id === undefined || payload.room_id === roomId)) {
          upsertParticipant(payload.participant);
        }

        if (payload.type === "user_offline" && payload.participant && !snapshotPresence && (payload.room_id === undefined || payload.room_id === roomId)) {
          removeParticipant(payload.participant.sender_id);
        }

        if (payload.type === "task_update" && payload.task) {
          const task = sanitizeTaskPatch(payload.task);
          if (!task) return;
          const existing = useChatStore.getState().tasks.find((item) => item.id === task.id);
          if (existing?.room_id && existing.room_id !== roomId) return;
          if (task.room_id !== roomId && !(task.room_id === undefined && existing?.room_id === roomId)) return;
          // State-only patches update immediately; HTTP fills missing task metadata.
          upsertTask(task);
          if (!useChatStore.getState().tasks.some((item) => item.id === task.id && item.room_id === roomId)) {
            void hydrateTask(task.id).then(() => {
              if (!disposed && socketRef.current === socket) upsertTask(task);
            });
          }
        }

        if (payload.type === "task_progress") {
          if (!isTaskProgressEvent(payload) || (payload.room_id !== undefined && payload.room_id !== roomId)) return;
          const existing = useChatStore.getState().tasks.find((task) => task.id === payload.task_id);
          if (existing?.room_id && existing.room_id !== roomId) return;
          if (useChatStore.getState().tasks.some((task) => task.id === payload.task_id && task.room_id === roomId)) {
            updateTaskProgress(payload, roomId);
          } else {
            void hydrateTask(payload.task_id).then(() => {
              if (!disposed && socketRef.current === socket) updateTaskProgress(payload, roomId);
            });
          }
        }

        if (transport !== "xmtp" && payload.type === "agent_dialogue_message" && payload.message?.room_id === roomId) {
          addMessage(payload.message);
        }

        if (payload.type === "agent_dialogue_ended") {
          console.log("Dialogue ended", payload.dialogue);
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      const socket = socketRef.current;
      if (socket) {
        socketRef.current = null;
        socket.close();
      }
    };
  }, [transport, addMessage, markTyping, removeParticipant, roomId, setConnectionStatus, setParticipants, upsertParticipant, upsertTask, updateTaskProgress]);

  const sendMessage = useCallback(async (input: SendMessageInput): Promise<boolean> => {
    const socket = socketRef.current;
    const displayName = useAuthStore.getState().displayName;
    const user = useAuthStore.getState().user;

    const delivery = await deliverOutgoing({
      transport: input.transport ?? transport,
      content: input.content,
      xmtpGroupId: input.xmtpGroupId,
      sendToXmtp: input.sendToXmtp,
    });

    if (delivery.hubPayload === null) {
      // Encrypted room messages are delivered via XMTP, not Hub WebSocket
      // The XMTP stream supplies the canonical message ID, including our own sends.
      return delivery.delivered;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(
      JSON.stringify({
        type: "message",
        sender_id: user?.id ?? input.senderId,
        sender_type: input.senderType,
        sender_name: user?.display_name ?? displayName,
        msg_type: input.msgType ?? "text",
        content: delivery.hubPayload.content,
      }),
    );

    return true;
  }, [transport]);

  return useMemo(() => ({ sendMessage }), [sendMessage]);
}
