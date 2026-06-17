import { create } from "zustand";

export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  user_type: "human" | "agent";
  last_seen_at?: string | null;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  displayName: string;
  userType: "human" | "agent";
  isAuthenticated: boolean;
  setSession: (user: AuthUser, token: string) => void;
  logout: () => void;
}

const storedToken = localStorage.getItem("mapr-auth-token");
const storedUser = localStorage.getItem("mapr-auth-user");
const initialUser = storedUser ? JSON.parse(storedUser) as AuthUser : null;

export const useAuthStore = create<AuthState>((set) => ({
  user: initialUser,
  token: storedToken,
  displayName: initialUser?.display_name ?? "Human Demo",
  userType: initialUser?.user_type ?? "human",
  isAuthenticated: Boolean(storedToken && initialUser),
  setSession: (user, token) => {
    localStorage.setItem("mapr-auth-token", token);
    localStorage.setItem("mapr-auth-user", JSON.stringify(user));
    set({
      user,
      token,
      displayName: user.display_name,
      userType: user.user_type,
      isAuthenticated: true,
    });
  },
  logout: () => {
    localStorage.removeItem("mapr-auth-token");
    localStorage.removeItem("mapr-auth-user");
    set({
      user: null,
      token: null,
      displayName: "Human Demo",
      userType: "human",
      isAuthenticated: false,
    });
  },
}));
