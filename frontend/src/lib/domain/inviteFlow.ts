export type InviteFlow =
  | { kind: "idle" }
  | { kind: "accepting" | "accepted" | "redeeming" | "pendingApproval" | "redeemed"; token: string }
  | { kind: "acceptFailed"; token: string; message: string }
  | { kind: "redeemFailed"; token: string; message: string; retryable: boolean };

export type InviteEvent =
  | { type: "accept" | "accepted" | "redeem" | "pendingApproval" | "redeemed"; token: string }
  | { type: "acceptFailed"; token: string; message: string }
  | { type: "redeemFailed"; token: string; message: string; retryable: boolean };

export const idleInviteFlow: InviteFlow = { kind: "idle" };

export function inviteFlowReducer(state: InviteFlow, event: InviteEvent): InviteFlow {
  if (event.type === "accept") return { kind: "accepting", token: event.token };
  if (state.kind === "idle" || state.token !== event.token) return state;
  const { token } = event;

  switch (event.type) {
    case "accepted":
      return state.kind === "accepting" ? { kind: "accepted", token } : state;
    case "acceptFailed":
      return state.kind === "accepting" ? { kind: "acceptFailed", token, message: event.message } : state;
    case "redeem":
      return state.kind === "accepted" || state.kind === "acceptFailed" || (state.kind === "redeemFailed" && state.retryable)
        ? { kind: "redeeming", token }
        : state;
    case "pendingApproval":
    case "redeemed":
      return state.kind === "redeeming" ? { kind: event.type, token } : state;
    case "redeemFailed":
      return state.kind === "redeeming" ? { kind: "redeemFailed", token, message: event.message, retryable: event.retryable } : state;
  }
}
