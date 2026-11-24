import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindXmtpGroup, createRoomFromTemplate, searchMessages } from "./api";
import {
  acceptRoomInvite, approveRedemption, createRoomInvite, denyRedemption, issueSignatureNonce,
  listRoomRedemptions, pauseRoomSeat, redeemRoomInvite, removeRoomSeat, resumeRoomSeat,
} from "./localHelper";

const fetcher = vi.fn<typeof fetch>();
const room = "room 42";
const seat = "seat/7";
const request = "request/9";
const token = "token?x";
const seatsPath = "/api/v1/rooms/room%2042/seats/seat%2F7";
const redemptionsPath = "/api/v1/rooms/room%2042/redemptions";

beforeEach(() => {
  fetcher.mockReset().mockImplementation(async () => Response.json({ room: {}, invite: {}, redemption: {} }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

function expectRequest(path: string, method: string, body?: unknown) {
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe(path);
  expect(options?.method ?? "GET").toBe(method);
  if (body === undefined) expect(options?.body).toBeUndefined();
  else expect(options?.body).toBe(JSON.stringify(body));
}

it.each([
  [removeRoomSeat, seatsPath, "DELETE"],
  [pauseRoomSeat, `${seatsPath}/pause`, "POST"],
  [resumeRoomSeat, `${seatsPath}/resume`, "POST"],
] as const)("preserves the seat mutation %s", async (fn, path, method) => {
  await fn(room, seat);
  expectRequest(path, method);
});

it("requests pending redemptions through the original endpoint", async () => {
  await listRoomRedemptions(room, "pending");
  expectRequest(`${redemptionsPath}?status=pending`, "GET");
});

it("preserves approval path and approved scopes", async () => {
  const options = { approved_scopes: ["task.run"], display_name: "Muse" };
  await approveRedemption(room, request, options);
  expectRequest(`${redemptionsPath}/request%2F9/approve`, "POST", options);
});

it("preserves denial path and optional reason", async () => {
  await denyRedemption(room, request, "请求超出范围");
  expectRequest(`${redemptionsPath}/request%2F9/deny`, "POST", { reason: "请求超出范围" });
});

it("preserves cloud invite creation body", async () => {
  await createRoomInvite(room, { max_uses: 2, requires_approval: true });
  expectRequest("/api/v1/rooms/room%2042/invites", "POST", {
    proposed_scopes: [], expires_hours: 72, max_uses: 2, requires_approval: true, role: "member",
  });
});

it("preserves invite acceptance", async () => {
  await acceptRoomInvite(token);
  expectRequest("/api/v1/invites/token%3Fx/accept", "POST");
});

it("preserves one-time nonce issue parameters", async () => {
  const body = { action: "invite-redeem", resource: token, address: "0x" + "aa".repeat(20) } as const;
  await issueSignatureNonce(body);
  expectRequest("/api/v1/invites/nonce", "POST", body);
});

it("preserves signed invite redemption", async () => {
  const body = { xmtp_address: "0x" + "aa".repeat(20), nonce: "sample-nonce", signature: "sample-signature" };
  await redeemRoomInvite(token, body);
  expectRequest("/api/v1/invites/token%3Fx/redeem", "POST", body);
});

it("preserves template create-room overrides", async () => {
  const overrides = { house_rules: { scopes: { "gmail.send": "ask" as const }, notes: [] }, team_config_markdown: "team", default_max_rounds: 2 };
  await createRoomFromTemplate("research", "Example room", overrides);
  expectRequest("/api/v1/templates/create-room", "POST", { template_key: "research", name: "Example room", ...overrides });
});

it("preserves XMTP group binding", async () => {
  await bindXmtpGroup("room", "group");
  expectRequest("/api/v1/rooms/room/xmtp-binding", "POST", { xmtp_group_id: "group" });
});

it("preserves Hub search query encoding", async () => {
  await searchMessages("room", "two & words");
  expectRequest("/api/v1/rooms/room/messages/search?q=two%20%26%20words", "GET");
});
