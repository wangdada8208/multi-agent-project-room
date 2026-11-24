import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeSeatFromRoom } from "./useSeatActions";
import type { HubSeatView } from "../../lib/localHelper";

const address = "0x" + "ab".repeat(20);
const seat: HubSeatView = {
  seat_id: "seat", room_id: "room", agent_user_id: "agent", owner_user_id: "owner",
  agent_display_name: "Codex", kind: "codex", xmtp_address: address, group_status: "added",
};
const fetcher = vi.fn<typeof fetch>();
const remove = vi.fn<() => Promise<void>>();
const group = {
  members: async () => [{ accountIdentifiers: [{ identifier: address }] }],
  addMembersByIdentifiers: vi.fn(),
  removeMembersByIdentifiers: remove,
};
const client = { conversations: { getConversationById: vi.fn(async () => group) } };

beforeEach(() => {
  vi.clearAllMocks();
  fetcher.mockImplementation(async () => new Response(null, { status: 204 }));
  remove.mockResolvedValue();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

it("waits until XMTP removal has completed before deleting the Hub seat", async () => {
  let finish: () => void = () => {};
  remove.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const removing = removeSeatFromRoom(seat, client, "group");
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
  expect(fetcher).not.toHaveBeenCalled();
  finish();
  await removing;
  expect(fetcher).toHaveBeenCalledWith("/api/v1/rooms/room/seats/seat", expect.objectContaining({ method: "DELETE" }));
});

it("never calls XMTP for a pending seat", async () => {
  await removeSeatFromRoom({ ...seat, group_status: "pending" }, client, "group");
  expect(client.conversations.getConversationById).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce();
});

it("leaves the Hub seat in place if XMTP removal fails or the identity is locked", async () => {
  remove.mockRejectedValue(new Error("XMTP offline"));
  await expect(removeSeatFromRoom(seat, client, "group")).rejects.toThrow("席位记录未删除");
  await expect(removeSeatFromRoom(seat, null, "group")).rejects.toThrow("解锁");
  expect(fetcher).not.toHaveBeenCalled();
});
