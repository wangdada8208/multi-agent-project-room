import type { InviteFlow } from "./inviteFlow";
import type { XmtpErrorReason, XmtpSession } from "./xmtpSession";

export type RoomStatusView =
  | { kind: "locked" | "connecting" | "enableGroup" | "waitForGroup" | "awaitingApproval" | "awaitingAdd" | "notInGroup" | "ready" }
  | { kind: "error" | "inviteError"; message: string; reason?: XmtpErrorReason };

export function roomStatusView(
  session: XmtpSession, invite: InviteFlow, role?: string, hasMessages = false,
): RoomStatusView | null {
  switch (session.kind) {
    case "locked": return { kind: "locked" };
    case "connecting": return { kind: "connecting" };
    case "noGroup": return { kind: role === "owner" ? "enableGroup" : "waitForGroup" };
    case "error": return {
      kind: "error",
      message: session.message,
      ...(session.reason ? { reason: session.reason } : {}),
    };
    case "ready": return hasMessages ? null : { kind: "ready" };
    case "notInGroup":
      switch (invite.kind) {
        case "redeeming": return { kind: "connecting" };
        case "pendingApproval": return { kind: "awaitingApproval" };
        case "redeemed": return { kind: "awaitingAdd" };
        case "redeemFailed": return { kind: "inviteError", message: invite.message };
        default: return { kind: "notInGroup" };
      }
  }
}
