import { create } from "zustand";
import type { ChatMessage, MessageLoopState, PresenceParticipant, RoomTask } from "../types/chat";

interface ChatState {
  messages: ChatMessage[];
  connectionStatus: "idle" | "connecting" | "open" | "closed" | "error";
  typingUsers: string[];
  participants: PresenceParticipant[];
  tasks: RoomTask[];
  activeLoop: MessageLoopState | null;
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  setParticipants: (participants: PresenceParticipant[]) => void;
  upsertParticipant: (participant: PresenceParticipant) => void;
  removeParticipant: (senderId: string) => void;
  setTasks: (tasks: RoomTask[]) => void;
  upsertTask: (task: RoomTask) => void;
  setConnectionStatus: (status: ChatState["connectionStatus"]) => void;
  markTyping: (senderId: string) => void;
  setActiveLoop: (loop: MessageLoopState | null) => void;
  appendLoopTurn: (agentName: string, content: string, consensus: boolean, conflicts: string[]) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  connectionStatus: "idle",
  typingUsers: [],
  participants: [],
  tasks: [],
  activeLoop: null,
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((state) => {
      if (state.messages.some((existing) => existing.id === message.id)) return state;
      return { messages: [...state.messages, message] };
    }),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setParticipants: (participants) => set({ participants }),
  upsertParticipant: (participant) =>
    set((state) => ({
      participants: [
        ...state.participants.filter((item) => item.sender_id !== participant.sender_id),
        participant,
      ],
    })),
  removeParticipant: (senderId) =>
    set((state) => ({
      participants: state.participants.filter((item) => item.sender_id !== senderId),
    })),
  setTasks: (tasks) => set({ tasks }),
  upsertTask: (task) =>
    set((state) => ({
      tasks: [task, ...state.tasks.filter((item) => item.id !== task.id)].sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
      ),
    })),
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
