import { trustTierOf, type HubSeatView, type TrustTier } from "./localHelper";
import { isEthAddress } from "./xmtpGroup";

export interface XmtpMemberLike {
  inboxId?: string;
  accountIdentifiers?: { identifier?: string }[];
}

export interface ResolvedXmtpSender {
  senderName: string;
  senderType: "human" | "agent";
  trustTier?: TrustTier;
  address?: string;
}

/**
 * 从 XMTP group.members() 构建 inboxId -> 小写 0x 地址映射表。
 */
export function buildInboxAddressMap(members: XmtpMemberLike[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const member of members) {
    const inboxId = member.inboxId?.trim();
    if (!inboxId) continue;
    for (const id of member.accountIdentifiers ?? []) {
      const candidate = id?.identifier?.trim();
      if (candidate && isEthAddress(candidate)) {
        map[inboxId] = candidate.toLowerCase();
        break;
      }
    }
  }
  return map;
}

/**
 * 根据 XMTP 发送者 inboxId、成员地址映射与房间 Agent 席位列表，
 * 解析出真实的发送者名称、人类/Agent 身份与诚实信任分级徽章。
 */
export function resolveXmtpSender(input: {
  senderInboxId: string;
  myInboxId: string;
  myUsername: string;
  inboxAddresses: Record<string, string>;
  seats: HubSeatView[];
}): ResolvedXmtpSender {
  const { senderInboxId, myInboxId, myUsername, inboxAddresses, seats } = input;

  if (myInboxId && senderInboxId === myInboxId) {
    return {
      senderName: myUsername || "我",
      senderType: "human",
    };
  }

  const address = inboxAddresses[senderInboxId]?.toLowerCase();
  if (address) {
    const matchedSeat =
      seats.find((s) => s.group_status !== "removed" && s.xmtp_address.toLowerCase() === address) ??
      seats.find((s) => s.xmtp_address.toLowerCase() === address);

    if (matchedSeat) {
      return {
        senderName: matchedSeat.agent_display_name,
        senderType: "agent",
        trustTier: matchedSeat.trust_tier ?? trustTierOf(matchedSeat.kind),
        address,
      };
    }

    return {
      senderName: `协作者 (${address.slice(0, 6)}…${address.slice(-4)})`,
      senderType: "human",
      address,
    };
  }

  return {
    senderName: `协作者 (${senderInboxId.slice(0, 6)})`,
    senderType: "human",
  };
}
