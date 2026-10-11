import { create } from "zustand";
import type { ChatMessage, MessageLoopState, PresenceParticipant, RoomTask, RoomTaskPatch, TaskProgressEvent } from "../types/chat";

interface ChatState {
  messages: ChatMessage[];
  connectionStatus: "idle" | "connecting" | "open" | "closed" | "error";
  typingUsers: string[];
  participants: PresenceParticipant[];
  tasks: RoomTask[];
  activeLoop: MessageLoopState | null;
  setMessages: (messages: ChatMessage[], roomId?: string) => void;
  addMessage: (message: ChatMessage) => void;
  setParticipants: (participants: PresenceParticipant[]) => void;
  upsertParticipant: (participant: PresenceParticipant) => void;
  removeParticipant: (senderId: string) => void;
  setTasks: (tasks: RoomTask[]) => void;
  upsertTask: (task: RoomTaskPatch) => void;
  updateTaskProgress: (event: TaskProgressEvent, roomId: string) => void;
  setConnectionStatus: (status: ChatState["connectionStatus"]) => void;
  markTyping: (senderId: string) => void;
  setActiveLoop: (loop: MessageLoopState | null) => void;
  appendLoopTurn: (agentName: string, content: string, consensus: boolean, conflicts: string[]) => void;
}

const TASK_STATUSES = new Set(["submitted", "queued", "working", "input_required", "completed", "failed", "canceled"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
const PROGRESS_PHASES = new Set(["queued", "running", "waiting", "finishing"]);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const validSeq = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, limit = 256): value is string => typeof value === "string" && value.length <= limit;

export function sanitizeTaskPatch(input: RoomTaskPatch): RoomTaskPatch | null {
  if (!input || typeof input !== "object" || !own(input, "id") || !text(input.id) || !input.id) return null;
  if (own(input, "event_seq") && input.event_seq !== undefined && !validSeq(input.event_seq)) return null;
  const patch: RoomTaskPatch = { id: input.id };
  if (own(input, "event_seq") && validSeq(input.event_seq)) patch.event_seq = input.event_seq;
  for (const key of ["source_agent", "query", "status", "created_at"] as const) {
    const value = input[key];
    if (!own(input, key) || !text(value, key === "query" ? 65536 : 256)) continue;
    if (key === "status" && !TASK_STATUSES.has(value)) continue;
    if (key === "created_at" && !Number.isFinite(Date.parse(value))) continue;
    patch[key] = value;
  }
  for (const key of ["room_id", "target_agent", "source_message_id", "approval_id", "completed_at"] as const) {
    const value = input[key];
    if (!own(input, key) || (value !== null && !text(value))) continue;
    if (key === "completed_at" && value !== null && !Number.isFinite(Date.parse(value))) continue;
    patch[key] = value;
  }
  // Task results have a narrow display contract; discard arbitrary nested fields.
  if (own(input, "result")) {
    if (input.result === null) patch.result = null;
    else if (Array.isArray(input.result)) {
      patch.result = input.result.slice(0, 50).flatMap((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const clean: Record<string, string> = {};
        for (const key of ["type", "text", "content", "message_id"] as const) {
          const value = (item as Record<string, unknown>)[key];
          if (own(item, key) && text(value, 65536)) clean[key] = value;
        }
        return Object.keys(clean).length ? [clean] : [];
      });
    } else if (input.result && typeof input.result === "object" && own(input.result, "error")) {
      const error = (input.result as Record<string, unknown>).error;
      if (text(error, 65536)) patch.result = { error };
    }
  }
  return patch;
}

export function isTaskProgressEvent(event: TaskProgressEvent): boolean {
  return !!event && typeof event === "object" && event.type === "task_progress" &&
    own(event, "task_id") && text(event.task_id) && !!event.task_id &&
    (event.v === undefined || event.v === 1) &&
    (event.room_id === undefined || text(event.room_id)) &&
    own(event, "phase") && PROGRESS_PHASES.has(event.phase) &&
    own(event, "percent") && Number.isInteger(event.percent) && event.percent >= 0 && event.percent <= 100 &&
    (event.event_seq === undefined || (own(event, "event_seq") && validSeq(event.event_seq)));
}

function mergeTask(existing: RoomTask | undefined, input: RoomTaskPatch): RoomTask | undefined {
  const patch = sanitizeTaskPatch(input);
  if (!patch) return existing;
  if (existing && own(patch, "room_id") && existing.room_id && patch.room_id !== existing.room_id) return existing;
  if (!existing) {
    if (typeof patch.query !== "string" || typeof patch.source_agent !== "string" ||
        !patch.created_at || !patch.status) return undefined;
    return patch as RoomTask;
  }
  const latest = Math.max(existing.event_seq ?? -1, existing.progress?.event_seq ?? -1);
  if (patch.event_seq !== undefined && patch.event_seq < latest) return existing;
  // Equal sequences are replays. Permit missing metadata to be hydrated, never rewrite known state.
  const replay = (patch.event_seq !== undefined && patch.event_seq === existing.event_seq) ||
    (patch.event_seq === undefined && latest >= 0);
  const merged = { ...existing };
  for (const key of Object.keys(patch) as (keyof RoomTaskPatch)[]) {
    if (replay && existing[key] !== undefined) continue;
    Object.assign(merged, { [key]: patch[key] });
  }
  if (Object.keys(patch).every((key) => merged[key as keyof RoomTask] === existing[key as keyof RoomTask])) return existing;
  return merged;
}

function sortTasks(tasks: RoomTask[]): RoomTask[] {
  return tasks.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id));
}

// Keep legacy/local messages in chronological slots; order sequenced messages
// within each room without a non-transitive mixed timestamp/sequence comparator.
function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[], roomId?: string): ChatMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) {
    if (!message || !text(message.id) || !message.id || !text(message.room_id) ||
        (roomId !== undefined && message.room_id !== roomId) ||
        typeof message.content !== "string" || !Number.isFinite(Date.parse(message.created_at))) continue;
    const previous = byId.get(message.id);
    if (previous) {
      if (previous.room_id === message.room_id && previous.room_seq === undefined && validSeq(message.room_seq))
        byId.set(message.id, { ...previous, room_seq: message.room_seq });
      continue;
    }
    const { room_seq, ...rest } = message;
    byId.set(message.id, { ...rest, ...(validSeq(room_seq) ? { room_seq } : {}) });
  }
  const messages = [...byId.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  const rooms = new Set(messages.map((message) => message.room_id));
  for (const room of rooms) {
    const slots = messages.flatMap((message, index) => message.room_id === room && validSeq(message.room_seq) ? [index] : []);
    const ordered = slots.map((index) => messages[index]).sort((a, b) => a.room_seq! - b.room_seq! || a.id.localeCompare(b.id));
    slots.forEach((index, offset) => { messages[index] = ordered[offset]; });
  }
  return messages;
}

function normalizeParticipants(participants: PresenceParticipant[]): PresenceParticipant[] {
  const byId = new Map<string, PresenceParticipant>();
  for (const participant of participants) {
    if (!participant || !text(participant.sender_id) || !participant.sender_id ||
        !text(participant.sender_name) || !["human", "agent", "system"].includes(participant.sender_type) ||
        !Number.isFinite(Date.parse(participant.joined_at)) || !Number.isFinite(Date.parse(participant.last_seen_at))) continue;
    const previous = byId.get(participant.sender_id);
    if (previous && Date.parse(previous.last_seen_at) > Date.parse(participant.last_seen_at)) continue;
    byId.set(participant.sender_id, {
      sender_id: participant.sender_id, sender_name: participant.sender_name, sender_type: participant.sender_type,
      joined_at: participant.joined_at, last_seen_at: participant.last_seen_at,
      ...(validSeq(participant.connection_count) ? { connection_count: participant.connection_count } : {}),
    });
  }
  return [...byId.values()].sort((a, b) => a.sender_id.localeCompare(b.sender_id));
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  connectionStatus: "idle",
  typingUsers: [],
  participants: [],
  tasks: [],
  activeLoop: null,
  setMessages: (messages, roomId) => set((state) => ({ messages: mergeMessages(state.messages, messages, roomId) })),
  addMessage: (message) => set((state) => ({ messages: mergeMessages(state.messages, [message]) })),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setParticipants: (participants) => set({ participants: normalizeParticipants(participants) }),
  upsertParticipant: (participant) => set((state) => ({
    participants: normalizeParticipants([...state.participants, participant]),
  })),
  removeParticipant: (senderId) =>
    set((state) => ({
      participants: state.participants.filter((item) => item.sender_id !== senderId),
    })),
  setTasks: (tasks) => set((state) => ({
    // Preserve newer WS state/progress when a polling response arrives late.
    tasks: sortTasks(tasks.flatMap((task) => {
      const existing = state.tasks.find((item) => item.id === task.id && item.room_id === task.room_id);
      const merged = mergeTask(existing, task);
      return merged ? [merged] : [];
    })),
  })),
  upsertTask: (patch) => set((state) => {
    const existing = state.tasks.find((item) => item.id === patch?.id);
    const task = mergeTask(existing, patch);
    if (!task || task === existing) return state;
    return { tasks: sortTasks([task, ...state.tasks.filter((item) => item.id !== task.id)]) };
  }),
  updateTaskProgress: (event, roomId) => set((state) => {
    if (!isTaskProgressEvent(event) || (event.room_id !== undefined && event.room_id !== roomId)) return state;
    const task = state.tasks.find((item) => item.id === event.task_id && item.room_id === roomId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return state;
    const progress = task.progress;
    // Progress has its own cursor: reconciliation sends a task snapshot followed by older latest progress.
    if (progress?.event_seq !== undefined && (event.event_seq === undefined || event.event_seq <= progress.event_seq)) return state;
    if (progress?.phase === event.phase && progress.percent === event.percent && progress.event_seq === event.event_seq) return state;
    const next = { phase: event.phase, percent: event.percent, ...(event.event_seq !== undefined ? { event_seq: event.event_seq } : {}) };
    return { tasks: state.tasks.map((item) => item === task ? { ...task, progress: next } : item) };
  }),
  markTyping: (senderId) =>
    set((state) => ({
      typingUsers: Array.from(new Set([...state.typingUsers, senderId])),
    })),
  setActiveLoop: (activeLoop) => set({ activeLoop }),
  appendLoopTurn: (agentName, content, consensus, conflicts) =>
    set((state) => {
      if (!state.activeLoop) return state;
      return {
        activeLoop: {
          ...state.activeLoop,
          current_round: state.activeLoop.current_round + 1,
          turns: [
            ...state.activeLoop.turns,
            {
              agent_name: agentName,
              content,
              turn_number: state.activeLoop.turns.length + 1,
              signals_consensus: consensus,
              conflicts,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      };
    }),
}));
