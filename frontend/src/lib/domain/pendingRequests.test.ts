import { expect, it, vi } from "vitest";
import { pendingRequestsFrom } from "./pendingRequests";
import { collectGroupSyncAddresses } from "../seatGroupSync";
import type { RedemptionView } from "../localHelper";

const address = "0x" + "ab".repeat(20);
const approvedAddress = "0x" + "cd".repeat(20);
const pending: RedemptionView = {
  id: "pending", token: "sample", kind: "agent", status: "pending", redeemer_address: address,
  redeemer_user_id: null, agent_user_id: null, seat_id: null, approved_scopes: null, decided_by: null,
  decided_at: null, deny_reason: null, expires_at: null, created_at: null,
};

it("merges pending humans and agents, with the preset name only for the matching Agent token", () => {
  const lookup = vi.fn((token) => token === "sample" ? "Muse" : null);
  const requests = pendingRequestsFrom([
    pending,
    { ...pending, id: "human", kind: "human" },
    { ...pending, id: "unknown", token: "unknown" },
    { ...pending, id: "approved", status: "approved" },
    { ...pending, id: "denied", status: "denied" },
    { ...pending, id: "expired", status: "expired" },
  ], lookup);
  expect(requests.map(({ id, displayName }) => [id, displayName])).toEqual([
    ["pending", "Muse"], ["human", "协作者（0xabab…abab）"], ["unknown", "云端 Agent（0xabab…abab）"],
  ]);
  expect(lookup.mock.calls).toEqual([["sample"], ["unknown"]]);
});

it("blocks unapproved addresses even when duplicated in legacy invite or permissions data", () => {
  expect(collectGroupSyncAddresses({
    invites: [{ redeemed_by_address: address }],
    members: [{ xmtp_address: address.toUpperCase().replace("0X", "0x") }],
    redemptions: [pending, { ...pending, kind: "human", status: "approved", redeemer_address: approvedAddress }],
  })).toEqual([approvedAddress]);
});

it("does not resurrect a removed cloud seat from its historical approval", () => {
  expect(collectGroupSyncAddresses({
    invites: [{ redeemed_by_address: address }],
    members: [{ xmtp_address: address, user_type: "agent" }],
    redemptions: [{ ...pending, status: "consumed" }],
  })).toEqual([]);
});
