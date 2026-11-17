/**
 * 把「待入群」的席位拉进 XMTP 加密群（WP5）。
 *
 * 背景：本机助手（用户电脑上的 mapr-helper）创建席位后，Hub 里该席位
 * group_status="pending" 且带 xmtp_address，但席位自己无法入群——XMTP 群的
 * 新成员必须由「已经在群里的人」加入。打开房间页的用户如果本身就是群成员，
 * TA 的浏览器 XMTP 客户端正好能充当这个邀请人。
 *
 * 安全边界（方案 5.4）：Hub 的 GET seats 对任何房间成员开放，会返回所有人的
 * 席位。这里只处理 owner_user_id === 当前用户 的席位——只能拉自己的 Agent
 * 进群。后端 mark_group_added 也只允许席位属主上报，双重保证。
 *
 * 幂等性：每轮都重新读「群成员列表」这个真实状态，只做差量。上一轮加群成功
 * 但上报失败时，下一轮会看到地址已在群里 → 跳过加群、直接补上报。任何一步
 * 失败都留给下一轮重试，不产生重复加群。
 */
import type { Identifier } from "@xmtp/browser-sdk";
import type { HubSeatView } from "./localHelper";
import { isEthAddress, memberIdentifier } from "./xmtpGroup";

/**
 * 只需要 XMTP Client 的一小块能力，用结构化类型描述。
 * RoomPage 传入真实的 Client；测试传入假实现，不必 mock 整个 SDK。
 */
export interface XmtpGroupLike {
  sync?(): Promise<unknown>;
  members?(): Promise<{ accountIdentifiers?: { identifier?: string }[] }[]>;
  addMembersByIdentifiers(identifiers: Identifier[]): Promise<unknown>;
}

export interface XmtpClientLike {
  /** 地址是否已在 XMTP 网络注册身份。未注册的地址加群会失败，先探一下省得白抛错。 */
  fetchInboxIdByIdentifier?(identifier: Identifier): Promise<string | null | undefined>;
  conversations: {
    syncAll?(): Promise<unknown>;
    getConversationById(groupId: string): Promise<unknown>;
  };
}

/** Hub 侧两个端口的形状与 localHelper.ts 的 listRoomSeats / markSeatGroupAdded 一致。 */
export interface SeatSyncDeps {
  listSeats(roomId: string): Promise<HubSeatView[]>;
  markAdded(roomId: string, seatId: string): Promise<void>;
}

export interface SeatSyncOutcome {
  /** 本轮真正执行了 addMembers 的席位 id。 */
  added: string[];
  /** 本轮 group-added 上报成功的席位 id（含「上一轮已进群、本轮补报」的）。 */
  reported: string[];
}

/**
 * 一轮同步里要处理的席位：待入群 + 属于当前用户 + 地址格式合法。
 * 纯函数，方便单测；Hub 返回的数据不可信，地址在边界处先校验。
 */
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

/**
 * 执行一轮「待入群席位 → XMTP 群」的差量同步。
 *
 * 跳过的情形（本轮什么都不做，等下一轮）：
 * - 房间还没绑定加密群（groupId 为空）；
 * - 本地客户端里找不到这个群（我不是群成员，或群还没同步到本机）；
 * - 席位的 xmtp_address 尚未在 XMTP 网络注册（Agent 进程还没起来）。
 *
 * 抛错的情形：拉取群对象、拉取席位列表这类「整轮失败」会直接抛给调用方；
 * 单个席位内部的失败只记在该席位上、继续处理其它席位。两种失败都靠
 * 下一轮轮询收敛，调用方（RoomPage 的定时器）兜底 catch 即可。
 */
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

  // 群可能刚从别的设备建立、本地还没同步到，先按 sendXmtpMessage 的惯例补一次 syncAll。
  let group = (await client.conversations.getConversationById(groupId)) as XmtpGroupLike | undefined;
  if (!group && typeof client.conversations.syncAll === "function") {
    await client.conversations.syncAll();
    group = (await client.conversations.getConversationById(groupId)) as XmtpGroupLike | undefined;
  }
  if (!group || typeof group.addMembersByIdentifiers !== "function") return outcome;

  const targets = pendingOwnSeats(await deps.listSeats(roomId), currentUserId);
  if (targets.length === 0) return outcome;

  // 先拿到最新群成员，逐个比对，只在差量上动手。
  await group.sync?.();
  const present = memberAddressSet((await group.members?.()) ?? []);

  // 串行处理：XMTP 群按 epoch 提交，并发加人会互相冲突；席位数量小，串行足够快。
  for (const seat of targets) {
    const address = seat.xmtp_address.toLowerCase();
    try {
      if (!present.has(address)) {
        const identifier = memberIdentifier(seat.xmtp_address);
        // 身份还没注册时 addMembers 必败：跳过本轮，等 Agent 进程启动后下一轮再拉。
        if (client.fetchInboxIdByIdentifier) {
          const inboxId = await client.fetchInboxIdByIdentifier(identifier);
          if (!inboxId) continue;
        }
        await group.addMembersByIdentifiers([identifier]);
        present.add(address);
        outcome.added.push(seat.seat_id);
      }
      // 地址已在群里（本轮刚加，或上一轮加了但上报失败）→ 上报，让 Hub 把席位标成 added。
      await deps.markAdded(roomId, seat.seat_id);
      outcome.reported.push(seat.seat_id);
    } catch {
      // 单个席位失败不阻塞其它席位；下轮轮询会按最新状态重试。
    }
  }
  return outcome;
}
