import { describe, expect, it, vi } from "vitest";
import type { Identifier } from "@xmtp/browser-sdk";
import {
  addAddressToXmtpGroup,
  syncPendingSeatsToGroup,
  syncRedeemedInvitesToGroup,
} from "./seatGroupSync";
import type { XmtpClientLike } from "./seatGroupSync";
import type { HubSeatView } from "./localHelper";

const ME = "user-me";
const OTHER = "user-other";
const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function seat(partial: Partial<HubSeatView>): HubSeatView {
  return {
    seat_id: "seat-1",
    room_id: "room-1",
    agent_user_id: "agent-1",
    agent_display_name: "Agent",
    owner_user_id: ME,
    kind: "webhook",
    xmtp_address: ADDR_A,
    group_status: "pending",
    ...partial,
  };
}

function fakeGroup(initialMembers: string[] = []) {
  const memberAddrs = [...initialMembers];
  const addCalls: string[][] = [];
  const group = {
    sync: vi.fn(async () => {}),
    members: vi.fn(async () =>
      memberAddrs.map((a) => ({ accountIdentifiers: [{ identifier: a }] }))),
    addMembersByIdentifiers: vi.fn(async (ids: Identifier[]) => {
      for (const id of ids) memberAddrs.push(id.identifier.toLowerCase());
      addCalls.push(ids.map((i) => i.identifier));
    }),
  };
  return { group, addCalls };
}

function fakeClient(group: unknown, opts: { inboxId?: string | null } = {}) {
  const inboxId = opts.inboxId === undefined ? "inbox-1" : opts.inboxId;
  return {
    fetchInboxIdByIdentifier: vi.fn(async () => inboxId),
    conversations: {
      syncAll: vi.fn(async () => {}),
      getConversationById: vi.fn(async () => group),
    },
  };
}

function syncWith(input: {
  client: XmtpClientLike;
  groupId?: string | null;
  seats?: HubSeatView[];
  markAdded?: (roomId: string, seatId: string) => Promise<void>;
}) {
  const listSeats = vi.fn(async () => input.seats ?? []);
  const markAdded = vi.fn(input.markAdded ?? (async () => {}));
  return {
    listSeats,
    markAdded,
    run: () =>
      syncPendingSeatsToGroup({
        client: input.client,
        roomId: "room-1",
        groupId: input.groupId === undefined ? "group-1" : input.groupId,
        currentUserId: ME,
        deps: { listSeats, markAdded },
      }),
  };
}

describe("syncPendingSeatsToGroup", () => {
  it("只拉自己的待入群席位：别人的、非 pending 的、地址不合法的都跳过", async () => {
    const { group, addCalls } = fakeGroup();
    const { run, markAdded } = syncWith({
      client: fakeClient(group),
      seats: [
        seat({ seat_id: "mine-pending", xmtp_address: ADDR_A }),
        seat({ seat_id: "other-pending", owner_user_id: OTHER, xmtp_address: ADDR_B }),
        seat({ seat_id: "mine-added", group_status: "added", xmtp_address: ADDR_B }),
        seat({ seat_id: "mine-removed", group_status: "removed", xmtp_address: ADDR_B }),
        seat({ seat_id: "mine-bad-addr", xmtp_address: "not-an-address" }),
      ],
    });
    const outcome = await run();
    expect(addCalls).toEqual([[ADDR_A]]);
    expect(markAdded).toHaveBeenCalledTimes(1);
    expect(markAdded).toHaveBeenCalledWith("room-1", "mine-pending");
    expect(outcome.added).toEqual(["mine-pending"]);
    expect(outcome.reported).toEqual(["mine-pending"]);
  });

  it("地址已在群里时不重复加人，但仍补一次上报", async () => {
    const { group, addCalls } = fakeGroup([`0x${ADDR_A.slice(2).toUpperCase()}`]);
    const { run, markAdded } = syncWith({
      client: fakeClient(group),
      seats: [seat({ seat_id: "seat-1", xmtp_address: ADDR_A })],
    });
    const outcome = await run();
    expect(addCalls).toEqual([]);
    expect(markAdded).toHaveBeenCalledWith("room-1", "seat-1");
    expect(outcome.reported).toEqual(["seat-1"]);
  });

  it("上报失败后下一轮不重复加人、只重试上报", async () => {
    const { group, addCalls } = fakeGroup();
    let failFirst = true;
    let markCalls = 0;
    const markAdded = async (_roomId: string, _seatId: string) => {
      markCalls += 1;
      if (failFirst) {
        failFirst = false;
        throw new Error("hub 503");
      }
    };
    const { run } = syncWith({
      client: fakeClient(group),
      seats: [seat({ seat_id: "seat-1", xmtp_address: ADDR_A })],
      markAdded,
    });
    const first = await run();
    expect(first.added).toEqual(["seat-1"]);
    expect(first.reported).toEqual([]);

    const second = await run();
    expect(addCalls).toEqual([[ADDR_A]]);
    expect(markCalls).toBe(2);
    expect(second.reported).toEqual(["seat-1"]);
  });

  it("房间还没绑定加密群时直接跳过，不拉席位列表", async () => {
    const { run, listSeats, markAdded } = syncWith({
      client: fakeClient(fakeGroup().group),
      groupId: null,
      seats: [seat({})],
    });
    const outcome = await run();
    expect(outcome.added).toEqual([]);
    expect(listSeats).not.toHaveBeenCalled();
    expect(markAdded).not.toHaveBeenCalled();
  });

  it("本地客户端里找不到群（我不是成员或群未同步）时跳过本轮", async () => {
    const missingGroupClient = {
      fetchInboxIdByIdentifier: vi.fn(async () => "inbox-1"),
      conversations: {
        syncAll: vi.fn(async () => {}),
        getConversationById: vi.fn(async () => undefined),
      },
    };
    const { run, listSeats, markAdded } = syncWith({
      client: missingGroupClient,
      seats: [seat({})],
    });
    const outcome = await run();
    expect(outcome.added).toEqual([]);
    expect(listSeats).not.toHaveBeenCalled();
    expect(markAdded).not.toHaveBeenCalled();
  });

  it("席位地址还没注册 XMTP 身份（Agent 未启动）时跳过，不加人不上报", async () => {
    const { group, addCalls } = fakeGroup();
    const { run, markAdded } = syncWith({
      client: fakeClient(group, { inboxId: null }),
      seats: [seat({ seat_id: "seat-1" })],
    });
    const outcome = await run();
    expect(addCalls).toEqual([]);
    expect(markAdded).not.toHaveBeenCalled();
    expect(outcome.added).toEqual([]);
  });

  it("单个席位加群失败不阻塞其它席位", async () => {
    const { group } = fakeGroup();
    group.addMembersByIdentifiers.mockImplementation(async (ids: Identifier[]) => {
      if (ids[0].identifier === ADDR_A) throw new Error("xmtp reject");
    });
    const { run, markAdded } = syncWith({
      client: fakeClient(group),
      seats: [
        seat({ seat_id: "seat-a", xmtp_address: ADDR_A }),
        seat({ seat_id: "seat-b", xmtp_address: ADDR_B }),
      ],
    });
    const outcome = await run();
    expect(outcome.added).toEqual(["seat-b"]);
    expect(markAdded).toHaveBeenCalledTimes(1);
    expect(markAdded).toHaveBeenCalledWith("room-1", "seat-b");
  });
});

describe("syncRedeemedInvitesToGroup", () => {
  it("deduplicates valid redeemed addresses, skips existing members, and adds new ones sequentially", async () => {
    const { group, addCalls } = fakeGroup([ADDR_A]);
    const listInvites = vi.fn(async () => [
      { redeemed_by_address: null },
      { redeemed_by_address: "invalid" },
      { redeemed_by_address: ADDR_A.toUpperCase().replace("0X", "0x") },
      { redeemed_by_address: `0x${ADDR_B.slice(2).toUpperCase()}` },
      { redeemed_by_address: ADDR_B },
    ]);

    const outcome = await syncRedeemedInvitesToGroup({
      client: fakeClient(group),
      roomId: "room-1",
      groupId: "group-1",
      listInvites,
    });

    expect(outcome.addedAddresses).toEqual([ADDR_B]);
    expect(addCalls).toEqual([[ADDR_B]]);
  });

  it("skips addresses without an activated XMTP inbox yet", async () => {
    const { group, addCalls } = fakeGroup();
    const outcome = await syncRedeemedInvitesToGroup({
      client: fakeClient(group, { inboxId: null }),
      roomId: "room-1",
      groupId: "group-1",
      listInvites: async () => [{ redeemed_by_address: ADDR_A }],
    });
    expect(outcome.addedAddresses).toEqual([]);
    expect(addCalls).toEqual([]);
  });
});

describe("addAddressToXmtpGroup", () => {
  it("throws friendly Chinese error when address format is invalid", async () => {
    const { group } = fakeGroup();
    await expect(addAddressToXmtpGroup(fakeClient(group), "group-1", "bad-addr")).rejects.toThrow(
      "请输入有效的 0x 开头 42 位加密身份地址",
    );
  });

  it("returns already-member when address is already in XMTP group", async () => {
    const { group, addCalls } = fakeGroup([ADDR_A]);
    const res = await addAddressToXmtpGroup(
      fakeClient(group),
      "group-1",
      `  0x${ADDR_A.slice(2).toUpperCase()}  `,
    );
    expect(res).toBe("already-member");
    expect(addCalls).toEqual([]);
  });

  it("throws friendly Chinese error when address has not registered XMTP inbox yet", async () => {
    const { group } = fakeGroup();
    await expect(
      addAddressToXmtpGroup(fakeClient(group, { inboxId: null }), "group-1", ADDR_B),
    ).rejects.toThrow("该地址尚未在浏览器中解锁激活加密身份，请让对方先打开房间解锁一次");
  });

  it("adds valid registered address and returns added", async () => {
    const { group, addCalls } = fakeGroup();
    const res = await addAddressToXmtpGroup(fakeClient(group), "group-1", ADDR_B);
    expect(res).toBe("added");
    expect(addCalls).toEqual([[ADDR_B]]);
  });
});
