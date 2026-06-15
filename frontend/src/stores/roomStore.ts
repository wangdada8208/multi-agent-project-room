import { create } from "zustand";
import type { Room } from "../types/chat";

interface RoomState {
  rooms: Room[];
  activeRoomId: string;
  setRooms: (rooms: Room[]) => void;
  setActiveRoomId: (activeRoomId: string) => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  rooms: [],
  activeRoomId: "demo-room",
  setRooms: (rooms) => set({ rooms }),
  setActiveRoomId: (activeRoomId) => set({ activeRoomId }),
}));
