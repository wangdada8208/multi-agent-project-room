import { create } from "zustand";

export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  user_type: "human" | "agent";
  email?: string | null;
  email_verified?: boolean;
  avatar_url?: string | null;
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

const safeStorage =
  typeof localStorage !== "undefined" && typeof localStorage?.getItem === "function"
    ? localStorage
    : null;

let storedToken = safeStorage?.getItem("mapr-auth-token") ?? null;
const storedUser = safeStorage?.getItem("mapr-auth-user") ?? null;
let initialUser: AuthUser | null = null;
if (storedUser) {
  try {
    initialUser = JSON.parse(storedUser) as AuthUser;
  } catch {
    safeStorage?.removeItem("mapr-auth-user");
    safeStorage?.removeItem("mapr-auth-token");
    storedToken = null;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  user: initialUser,
  token: storedToken,
  displayName: initialUser?.display_name ?? "Human Demo",
  userType: initialUser?.user_type ?? "human",
  isAuthenticated: Boolean(storedToken && initialUser),
  setSession: (user, token) => {
    safeStorage?.setItem("mapr-auth-token", token);
    safeStorage?.setItem("mapr-auth-user", JSON.stringify(user));
    set({
      user,
      token,
      displayName: user.display_name,
      userType: user.user_type,
      isAuthenticated: true,
    });
  },
  logout: () => {
    safeStorage?.removeItem("mapr-auth-token");
    safeStorage?.removeItem("mapr-auth-user");
    set({
      user: null,
      token: null,
      displayName: "Human Demo",
      userType: "human",
      isAuthenticated: false,
    });
  },
}));
