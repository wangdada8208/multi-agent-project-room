import { create } from "zustand";

interface WorkspaceUiState {
  createRoomOpen: boolean;
  openCreateRoom: () => void;
  closeCreateRoom: () => void;
}

export const useWorkspaceUiStore = create<WorkspaceUiState>((set) => ({
  createRoomOpen: false,
  openCreateRoom: () => set({ createRoomOpen: true }),
  closeCreateRoom: () => set({ createRoomOpen: false }),
}));
