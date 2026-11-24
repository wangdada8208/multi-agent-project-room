/**
 * 把「待入群」的席位与受邀人类协作者拉进 XMTP 加密群（WP5 + 多人加密入群闭环）。
 *
 * 背景：本机助手（用户电脑上的 mapr-helper）创建席位后，Hub 里该席位
 * group_status="pending" 且带 xmtp_address，但席位自己无法入群——XMTP 群的
 * 新成员必须由「已经在群里的人」加入。同理，受邀协作者核销邀请令牌后，
 * 由房主客户端自动或手动将其 0x 加密地址拉进同一个 XMTP 加密群。
 */
import type { Identifier } from "@xmtp/browser-sdk";
import type { HubSeatView } from "./localHelper";
import { isEthAddress, memberIdentifier } from "./xmtpGroup";

export interface XmtpGroupLike {
  sync?(): Promise<unknown>;
  members?(): Promise<{ inboxId?: string; accountIdentifiers?: { identifier?: string }[] }[]>;
  addMembersByIdentifiers(identifiers: Identifier[]): Promise<unknown>;
  removeMembersByIdentifiers?(identifiers: Identifier[]): Promise<unknown>;
  send?(text: string): Promise<unknown>;
}

export interface XmtpClientLike {
  fetchInboxIdByIdentifier?(identifier: Identifier): Promise<string | null | undefined>;
  conversations: {
    syncAll?(): Promise<unknown>;
    getConversationById(groupId: string): Promise<unknown>;
  };
}

export interface SeatSyncDeps {
  listSeats(roomId: string): Promise<HubSeatView[]>;
  markAdded(roomId: string, seatId: string): Promise<void>;
}

export interface SeatSyncOutcome {
  added: string[];
  reported: string[];
}

export function pendingOwnSeats(seats: HubSeatView[], currentUserId: string): HubSeatView[] {
  return seats.filter(
    (s) =>
      s.group_status === "pending" &&
      s.owner_user_id === currentUserId &&
      isEthAddress(s.xmtp_address),
  );
}

/** 云端邀请入房的待入群席位（source="invite"）：云端 Agent 没有本机助手，入群只能由房主客户端完成。 */
export function pendingInviteSeats(seats: HubSeatView[]): HubSeatView[] {
  return seats.filter(
    (s) =>
      s.group_status === "pending" &&
      s.source === "invite" &&
      isEthAddress(s.xmtp_address),
  );
}

function memberAddressSet(members: { accountIdentifiers?: { identifier?: string }[] }[]): Set<string> {
  const set = new Set<string>();
  for (const m of members) {
    for (const id of m.accountIdentifiers ?? []) {
      if (id.identifier) set.add(String(id.identifier).toLowerCase());
    }
  }
  return set;
}

async function resolveGroup(client: XmtpClientLike, groupId: string): Promise<XmtpGroupLike | undefined> {
  let group = (await client.conversations.getConversationById(groupId)) as XmtpGroupLike | undefined;
  if (!group && typeof client.conversations.syncAll === "function") {
    await client.conversations.syncAll();
    group = (await client.conversations.getConversationById(groupId)) as XmtpGroupLike | undefined;
  }
  return group;
}

export async function syncPendingSeatsToGroup(input: {
  client: XmtpClientLike;
  roomId: string;
  groupId: string | null | undefined;
  currentUserId: string | null | undefined;
  /** 当前用户是房主时，第三趟顺带拉起云端邀请席（它们没有本机助手，入群只能等房主客户端）。 */
  isRoomOwner?: boolean;
  deps: SeatSyncDeps;
  isActive?: () => boolean;
}): Promise<SeatSyncOutcome> {
  const outcome: SeatSyncOutcome = { added: [], reported: [] };
  const { client, roomId, groupId, currentUserId, deps } = input;
  if (!groupId || !currentUserId) return outcome;

  const group = await resolveGroup(client, groupId);
  if (!group || typeof group.addMembersByIdentifiers !== "function") return outcome;

  const seats = await deps.listSeats(roomId);
  const targets = pendingOwnSeats(seats, currentUserId);
  if (input.isRoomOwner) {
    const seen = new Set(targets.map((s) => s.seat_id));
    for (const seat of pendingInviteSeats(seats)) {
      if (!seen.has(seat.seat_id)) targets.push(seat);
    }
  }
  if (targets.length === 0) return outcome;

  await group.sync?.();
  const present = memberAddressSet((await group.members?.()) ?? []);

  for (const seat of targets) {
    if (input.isActive?.() === false) break;
    const address = seat.xmtp_address.toLowerCase();
    try {
      if (!present.has(address)) {
        const identifier = memberIdentifier(seat.xmtp_address);
        if (client.fetchInboxIdByIdentifier) {
          const inboxId = await client.fetchInboxIdByIdentifier(identifier);
          if (!inboxId) continue;
        }
        if (input.isActive?.() === false) break;
        await group.addMembersByIdentifiers([identifier]);
        present.add(address);
        outcome.added.push(seat.seat_id);
      }
      await deps.markAdded(roomId, seat.seat_id);
      outcome.reported.push(seat.seat_id);
    } catch {
      // 单个席位失败不阻塞其它席位；下轮轮询会按最新状态重试。
    }
  }
  return outcome;
}

/**
 * 汇总「应该已经在加密群里」的受邀地址（纯函数，可测）：
 * - 已批准/已核销的人类 redemptions 的 redeemer_address；
 * - 成员行上已绑定的 xmtp_address；
 * - 旧版邀请行的 redeemed_by_address（过渡字段）。
 * 绝不包含 pending/denied/expired/revoked 的核销地址——未批准的申请者不能进加密群。
 */
export function collectGroupSyncAddresses(input: {
  invites?: { redeemed_by_address?: string | null }[];
  redemptions?: { kind?: string; status?: string; redeemer_address?: string | null }[];
  members?: { xmtp_address?: string | null; user_type?: string }[];
}): string[] {
  const candidates: string[] = [];
  const blocked = new Set((input.redemptions ?? [])
    .filter((redemption) => redemption.status === "pending" || redemption.status === "denied" ||
      redemption.status === "expired" || redemption.status === "revoked")
    .map((redemption) => redemption.redeemer_address?.trim().toLowerCase()));
  // Agent membership is managed by the live seat path. Historical approvals
  // and legacy invite fields may still contain addresses of removed seats.
  const agentAddresses = new Set((input.redemptions ?? []).filter((entry) => entry.kind === "agent")
    .map((entry) => entry.redeemer_address?.trim().toLowerCase()));
  const seen = new Set<string>();
  const push = (raw: string | null | undefined, approved = false) => {
    const trimmed = raw?.trim();
    if (!trimmed || !isEthAddress(trimmed)) return;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower) || agentAddresses.has(lower) || (!approved && blocked.has(lower))) return;
    seen.add(lower);
    candidates.push(lower);
  };
  for (const inv of input.invites ?? []) push(inv.redeemed_by_address);
  for (const red of input.redemptions ?? []) {
    if (red.status === "approved" || red.status === "consumed") {
      push(red.redeemer_address, true);
    }
  }
  for (const member of input.members ?? []) {
    if (member.user_type !== "agent") push(member.xmtp_address);
  }
  return candidates;
}

/**
 * 房主端自动把已核销/已批准邀请的协作者加密地址拉入 XMTP 群。
 * 地址来源由调用方用 collectGroupSyncAddresses 组装（redemptions + 成员行 + 旧邀请字段）。
 */
export async function syncRedeemedInvitesToGroup(input: {
  client: XmtpClientLike;
  roomId: string;
  groupId: string | null | undefined;
  listAddresses: (roomId: string) => Promise<(string | null | undefined)[]>;
  isActive?: () => boolean;
}): Promise<{ addedAddresses: string[] }> {
  const addedAddresses: string[] = [];
  const { client, roomId, groupId, listAddresses } = input;
  if (!groupId) return { addedAddresses };

  const group = await resolveGroup(client, groupId);
  if (!group || typeof group.addMembersByIdentifiers !== "function") {
    return { addedAddresses };
  }

  const rawAddresses = await listAddresses(roomId);
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawAddresses) {
    const trimmed = raw?.trim();
    if (!trimmed || !isEthAddress(trimmed)) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    candidates.push(lower);
  }
  if (candidates.length === 0) return { addedAddresses };

  await group.sync?.();
  const present = memberAddressSet((await group.members?.()) ?? []);

  for (const addr of candidates) {
    if (input.isActive?.() === false) break;
    if (present.has(addr)) continue;
    try {
      const identifier = memberIdentifier(addr);
      if (client.fetchInboxIdByIdentifier) {
        const inboxId = await client.fetchInboxIdByIdentifier(identifier);
        if (!inboxId) continue;
      }
      if (input.isActive?.() === false) break;
      await group.addMembersByIdentifiers([identifier]);
      present.add(addr);
      addedAddresses.push(addr);
    } catch {
      // 单个地址入群失败不阻塞其余受邀者；下一轮自动重试。
    }
  }

  return { addedAddresses };
}

/**
 * 房主手动输入协作者 0x 地址直接拉入 XMTP 加密群。
 */
export async function addAddressToXmtpGroup(
  client: XmtpClientLike,
  groupId: string,
  rawAddress: string,
): Promise<"added" | "already-member"> {
  const trimmed = rawAddress.trim();
  if (!isEthAddress(trimmed)) {
    throw new Error("请输入有效的 0x 开头 42 位加密身份地址");
  }
  const addr = trimmed.toLowerCase();
  const group = await resolveGroup(client, groupId);
  if (!group || typeof group.addMembersByIdentifiers !== "function") {
    throw new Error("当前浏览器尚未连接房间加密群，请先解锁身份后重试");
  }

  await group.sync?.();
  const present = memberAddressSet((await group.members?.()) ?? []);
  if (present.has(addr)) {
    return "already-member";
  }

  const identifier = memberIdentifier(addr);
  if (client.fetchInboxIdByIdentifier) {
    const inboxId = await client.fetchInboxIdByIdentifier(identifier);
    if (!inboxId) {
      throw new Error("该地址尚未在浏览器中解锁激活加密身份，请让对方先打开房间解锁一次");
    }
  }

  await group.addMembersByIdentifiers([identifier]);
  return "added";
}

/**
 * 构造 member_revoked 群广播正文（与 workers/xmtp-member 的 MAPR1 信封同构）。
 * 收到的一方只把它当作「重新核实群成员」的提示，不据此直接信任。
 */
export function memberRevokedNotice(address: string, reason = "owner_removed"): string {
  const requestId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `mr-${crypto.randomUUID()}`
      : `mr-${Date.now()}`;
  return `MAPR1 ${JSON.stringify({
    kind: "member_revoked",
    request_id: requestId,
    to: "*",
    address: address.toLowerCase(),
    reason,
  })}`;
}

/**
 * 把某个加密地址移出 XMTP 群，并向群内广播 member_revoked 通知。
 * 「移除」必须先出群、后删 Hub 行——顺序反了会留下仍可解密新消息的孤儿成员。
 */
export async function removeAddressFromXmtpGroup(
  client: XmtpClientLike,
  groupId: string,
  rawAddress: string,
  opts: { notify?: boolean; reason?: string } = {},
): Promise<"removed" | "not-member"> {
  const trimmed = rawAddress.trim();
  if (!isEthAddress(trimmed)) {
    throw new Error("无效的加密身份地址");
  }
  const addr = trimmed.toLowerCase();
  const group = await resolveGroup(client, groupId);
  if (!group || typeof group.removeMembersByIdentifiers !== "function") {
    throw new Error("当前浏览器尚未连接房间加密群，请先解锁身份后重试");
  }

  await group.sync?.();
  const present = memberAddressSet((await group.members?.()) ?? []);
  if (!present.has(addr)) {
    return "not-member";
  }

  await group.removeMembersByIdentifiers([memberIdentifier(addr)]);
  if (opts.notify !== false && typeof group.send === "function") {
    try {
      await group.send(memberRevokedNotice(addr, opts.reason));
    } catch {
      // 广播失败不影响移除本身；其余成员下一次 members() 拉取同样会失效缓存。
    }
  }
  return "removed";
}
