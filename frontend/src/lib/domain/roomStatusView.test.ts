import { describe, expect, it } from "vitest";
import { roomStatusView, type RoomStatusView } from "./roomStatusView";
import type { XmtpSession } from "./xmtpSession";
import type { InviteFlow } from "./inviteFlow";

const token = "sample";
const groupId = "group";
const absent = { kind: "notInGroup", groupId } satisfies XmtpSession;
const idle = { kind: "idle" } satisfies InviteFlow;

describe("room status card", () => {
  it.each<{
    session: XmtpSession;
    invite: InviteFlow;
    role?: string;
    expected: RoomStatusView;
  }>([
    { session: { kind: "locked" }, invite: idle, expected: { kind: "locked" } },
    { session: { kind: "connecting" }, invite: { kind: "pendingApproval", token }, expected: { kind: "connecting" } },
    { session: { kind: "noGroup" }, invite: idle, role: "owner", expected: { kind: "enableGroup" } },
    { session: { kind: "noGroup" }, invite: idle, role: "viewer", expected: { kind: "waitForGroup" } },
    { session: absent, invite: { kind: "redeeming", token }, expected: { kind: "connecting" } },
    { session: absent, invite: { kind: "pendingApproval", token }, expected: { kind: "awaitingApproval" } },
    { session: absent, invite: { kind: "redeemed", token }, expected: { kind: "awaitingAdd" } },
    { session: absent, invite: idle, expected: { kind: "notInGroup" } },
    { session: absent, invite: { kind: "redeemFailed", token, message: "expired link", retryable: false }, expected: { kind: "inviteError", message: "expired link" } },
    { session: { kind: "error", message: "offline" }, invite: { kind: "redeemed", token }, expected: { kind: "error", message: "offline" } },
    { session: { kind: "ready", groupId }, invite: { kind: "pendingApproval", token }, expected: { kind: "ready" } },
  ])("selects only $expected.kind", ({ session, invite, role, expected }) => {
    expect(roomStatusView(session, invite, role)).toEqual(expected);
  });

  it("shows no card when the ready room has messages", () => {
    expect(roomStatusView({ kind: "ready", groupId }, { kind: "redeemed", token }, undefined, true)).toBeNull();
  });
});
