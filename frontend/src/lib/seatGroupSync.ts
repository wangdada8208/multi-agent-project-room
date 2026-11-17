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
  deps: SeatSyncDeps;
}): Promise<SeatSyncOutcome> {
  const outcome: SeatSyncOutcome = { added: [], reported: [] };
  const { client, roomId, groupId, currentUserId, deps } = input;
  if (!groupId || !currentUserId) return outcome;

  const group = await resolveGroup(client, groupId);
  if (!group || typeof group.addMembersByIdentifiers !== "function") return outcome;

  const targets = pendingOwnSeats(await deps.listSeats(roomId), currentUserId);
  if (targets.length === 0) return outcome;

  await group.sync?.();
  const present = memberAddressSet((await group.members?.()) ?? []);

  for (const seat of targets) {
    const address = seat.xmtp_address.toLowerCase();
    try {
      if (!present.has(address)) {
        const identifier = memberIdentifier(seat.xmtp_address);
        if (client.fetchInboxIdByIdentifier) {
          const inboxId = await client.fetchInboxIdByIdentifier(identifier);
          if (!inboxId) continue;
        }
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
 * 房主端自动把已核销邀请链接的协作者加密地址拉入 XMTP 群。
 */
export async function syncRedeemedInvitesToGroup(input: {
  client: XmtpClientLike;
  roomId: string;
  groupId: string | null | undefined;
  listInvites: (roomId: string) => Promise<{ redeemed_by_address: string | null }[]>;
}): Promise<{ addedAddresses: string[] }> {
  const addedAddresses: string[] = [];
  const { client, roomId, groupId, listInvites } = input;
  if (!groupId) return { addedAddresses };

  const group = await resolveGroup(client, groupId);
  if (!group || typeof group.addMembersByIdentifiers !== "function") {
    return { addedAddresses };
  }

  const invites = await listInvites(roomId);
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const inv of invites) {
    const raw = inv.redeemed_by_address?.trim();
    if (!raw || !isEthAddress(raw)) continue;
    const lower = raw.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    candidates.push(lower);
  }
  if (candidates.length === 0) return { addedAddresses };

  await group.sync?.();
  const present = memberAddressSet((await group.members?.()) ?? []);

  for (const addr of candidates) {
    if (present.has(addr)) continue;
    try {
      const identifier = memberIdentifier(addr);
      if (client.fetchInboxIdByIdentifier) {
        const inboxId = await client.fetchInboxIdByIdentifier(identifier);
        if (!inboxId) continue;
      }
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
