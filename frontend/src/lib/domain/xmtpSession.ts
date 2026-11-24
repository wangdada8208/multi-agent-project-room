export type XmtpSession =
  | { kind: "locked" | "connecting" | "noGroup" }
  | { kind: "notInGroup" | "ready"; groupId: string }
  | { kind: "error"; message: string };

export type XmtpSessionEvent =
  | { type: "lock" | "connect" | "groupMissing" }
  | { type: "notInGroup" | "ready"; groupId: string }
  | { type: "failed"; message: string };

export const lockedXmtpSession: XmtpSession = { kind: "locked" };

export function xmtpSessionReducer(state: XmtpSession, event: XmtpSessionEvent): XmtpSession {
  if (event.type === "lock") return lockedXmtpSession;
  if (event.type === "connect") return { kind: "connecting" };
  if (state.kind === "locked") return state;
  switch (event.type) {
    case "groupMissing": return { kind: "noGroup" };
    case "notInGroup": return { kind: "notInGroup", groupId: event.groupId };
    case "ready": return { kind: "ready", groupId: event.groupId };
    case "failed": return { kind: "error", message: event.message };
  }
  return state;
}
