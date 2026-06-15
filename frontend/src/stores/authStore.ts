import { create } from "zustand";

interface AuthState {
  displayName: string;
  userType: "human" | "agent";
  setDisplayName: (displayName: string) => void;
  setUserType: (userType: AuthState["userType"]) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  displayName: "Human Demo",
  userType: "human",
  setDisplayName: (displayName) => set({ displayName }),
  setUserType: (userType) => set({ userType }),
}));
