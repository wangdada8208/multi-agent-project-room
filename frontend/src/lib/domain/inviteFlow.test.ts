import { describe, expect, it } from "vitest";
import { idleInviteFlow, inviteFlowReducer as reduce, type InviteFlow } from "./inviteFlow";

const token = "sample-invite";
const accepting = reduce(idleInviteFlow, { type: "accept", token });
const accepted = reduce(accepting, { type: "accepted", token });
const redeeming = reduce(accepted, { type: "redeem", token });

describe("invite flow", () => {
  it("accepts before redeeming and distinguishes pending and immediate admission", () => {
    expect(accepting).toEqual({ kind: "accepting", token });
    expect(accepted).toEqual({ kind: "accepted", token });
    expect(redeeming).toEqual({ kind: "redeeming", token });
    expect(reduce(redeeming, { type: "pendingApproval", token })).toEqual({ kind: "pendingApproval", token });
    expect(reduce(redeeming, { type: "redeemed", token })).toEqual({ kind: "redeemed", token });
  });

  it("retains the acceptance error and permits a member with room access to redeem", () => {
    const failed = reduce(accepting, { type: "acceptFailed", token, message: "already joined" });
    expect(failed).toEqual({ kind: "acceptFailed", token, message: "already joined" });
    expect(reduce(failed, { type: "redeem", token })).toEqual(redeeming);
  });

  it.each([true, false])("handles redemption errors with retryable=%s", (retryable) => {
    const failed = reduce(redeeming, { type: "redeemFailed", token, message: "failure", retryable });
    expect(failed).toEqual({ kind: "redeemFailed", token, message: "failure", retryable });
    expect(reduce(failed, { type: "redeem", token })).toEqual(retryable ? redeeming : failed);
  });

  it("ignores late callbacks from old tokens and illegal transitions", () => {
    const replaced: InviteFlow = { kind: "accepting", token: "new" };
    expect(reduce(replaced, { type: "accepted", token })).toBe(replaced);
    expect(reduce(accepted, { type: "redeemed", token })).toBe(accepted);
    expect(reduce(accepting, { type: "redeem", token })).toBe(accepting);
    expect(reduce(idleInviteFlow, { type: "redeem", token })).toBe(idleInviteFlow);
  });
});
