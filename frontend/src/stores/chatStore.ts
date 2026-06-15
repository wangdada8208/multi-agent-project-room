import { create } from "zustand";
import type { ChatMessage } from "../types/chat";

interface ChatState {
  messages: ChatMessage[];
  connectionStatus: "idle" | "connecting" | "open" | "closed" | "error";
  typingUsers: string[];
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  setConnectionStatus: (status: ChatState["connectionStatus"]) => void;
  markTyping: (senderId: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  connectionStatus: "idle",
  typingUsers: [],
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((state) => {
      if (state.messages.some((existing) => existing.id === message.id)) {
        return state;
      }

      return { messages: [...state.messages, message] };
    }),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  markTyping: (senderId) =>
    set((state) => ({
      typingUsers: Array.from(new Set([...state.typingUsers, senderId])),
    })),
}));
