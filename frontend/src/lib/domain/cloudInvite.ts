import { cloudAgentConnectCommand } from "../agentPresets";

export type CloudInvite =
  | { kind: "idle" | "generating" }
  | { kind: "ready" | "copied" | "pending" | "approved" | "denied" | "expired"; token: string; command: string };

export type CloudInviteEvent =
  | { type: "generate" | "generationFailed" | "reset" }
  | { type: "generated"; token: string; command: Parameters<typeof cloudAgentConnectCommand>[0] }
  | { type: "copied" | "pending" | "approved" | "denied" | "expired"; token: string };

export function cloudInviteReducer(state: CloudInvite, event: CloudInviteEvent): CloudInvite {
  if (event.type === "reset") return { kind: "idle" };
  if (event.type === "generate") return state.kind === "idle" ? { kind: "generating" } : state;
  if (event.type === "generationFailed") return state.kind === "generating" ? { kind: "idle" } : state;
  if (event.type === "generated") {
    return state.kind === "generating"
      ? { kind: "ready", token: event.token, command: cloudAgentConnectCommand(event.command) }
      : state;
  }
  if (!("token" in state) || !("token" in event) || state.token !== event.token) return state;
  if (state.kind === "approved" || state.kind === "denied" || state.kind === "expired") return state;
  if (event.type === "copied" && state.kind !== "ready") return state;
  return { ...state, kind: event.type };
}

type InviteNameStorage = Pick<Storage, "getItem" | "setItem">;
const nameKey = (token: string) => `mapr-cloud-invite:${token}`;

export function rememberCloudInviteName(token: string, title: string, storage?: InviteNameStorage) {
  try {
    (storage ?? sessionStorage).setItem(nameKey(token), title);
  } catch {
    // Storage is optional, including when disabled by browser policy.
  }
}

export function cloudInviteName(token: string, storage?: Pick<Storage, "getItem">): string | null {
  try {
    return (storage ?? sessionStorage).getItem(nameKey(token));
  } catch {
    return null;
  }
}
