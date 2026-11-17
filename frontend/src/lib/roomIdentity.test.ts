import { describe, expect, it } from "vitest";
import { buildInboxAddressMap, resolveXmtpSender } from "./roomIdentity";
import { detectConflicts } from "../components/ChatMessage";
import type { HubSeatView } from "./localHelper";

const ADDR_CLAUDE = "0x1111111111111111111111111111111111111111";
const ADDR_GROK = "0x2222222222222222222222222222222222222222";
const ADDR_PEER = "0x333333333333333333333333333333333333abcd";

const SEATS: HubSeatView[] = [
  {
    seat_id: "seat-claude",
    room_id: "room-1",
    agent_user_id: "u-agent-1",
    agent_display_name: "Claude Code",
    owner_user_id: "u-owner",
    kind: "claude-code",
    trust_tier: "local-cli",
    xmtp_address: ADDR_CLAUDE,
    group_status: "added",
  },
  {
    seat_id: "seat-grok",
    room_id: "room-1",
    agent_user_id: "u-agent-2",
    agent_display_name: "Grok / Grokbot",
    owner_user_id: "u-peer",
    kind: "openai-compatible",
    xmtp_address: `0x${ADDR_GROK.slice(2).toUpperCase()}`,
    group_status: "added",
  },
];

describe("buildInboxAddressMap", () => {
  it("maps each inboxId to its lowercased 0x Ethereum address", () => {
    const map = buildInboxAddressMap([
      {
        inboxId: "inbox-claude",
        accountIdentifiers: [{ identifier: `0x${ADDR_CLAUDE.slice(2).toUpperCase()}` }],
      },
      {
        inboxId: "inbox-peer",
        accountIdentifiers: [{ identifier: "not-eth" }, { identifier: ADDR_PEER }],
      },
      {
        inboxId: "",
        accountIdentifiers: [{ identifier: ADDR_GROK }],
      },
    ]);

    expect(map).toEqual({
      "inbox-claude": ADDR_CLAUDE,
      "inbox-peer": ADDR_PEER,
    });
  });
});

describe("resolveXmtpSender", () => {
  const inboxAddresses = {
    "inbox-claude": ADDR_CLAUDE,
    "inbox-grok": ADDR_GROK,
    "inbox-peer": ADDR_PEER,
  };

  it("identifies own messages as human with myUsername or fallback 我", () => {
    expect(
      resolveXmtpSender({
        senderInboxId: "inbox-me",
        myInboxId: "inbox-me",
        myUsername: "王大大",
        inboxAddresses,
        seats: SEATS,
      }),
    ).toEqual({
      senderName: "王大大",
      senderType: "human",
    });

    expect(
      resolveXmtpSender({
        senderInboxId: "inbox-me",
        myInboxId: "inbox-me",
        myUsername: "",
        inboxAddresses,
        seats: SEATS,
      }),
    ).toEqual({
      senderName: "我",
      senderType: "human",
    });
  });

  it("resolves Agent seats to their real display name and trustTier (including fallback by kind)", () => {
    expect(
      resolveXmtpSender({
        senderInboxId: "inbox-claude",
        myInboxId: "inbox-me",
        myUsername: "我",
        inboxAddresses,
        seats: SEATS,
      }),
    ).toEqual({
      senderName: "Claude Code",
      senderType: "agent",
      trustTier: "local-cli",
      address: ADDR_CLAUDE,
    });

    expect(
      resolveXmtpSender({
        senderInboxId: "inbox-grok",
        myInboxId: "inbox-me",
        myUsername: "我",
        inboxAddresses,
        seats: SEATS,
      }),
    ).toEqual({
      senderName: "Grok / Grokbot",
      senderType: "agent",
      trustTier: "cloud-api",
      address: ADDR_GROK,
    });
  });

  it("identifies another human collaborator in the encrypted group as human (never robot)", () => {
    expect(
      resolveXmtpSender({
        senderInboxId: "inbox-peer",
        myInboxId: "inbox-me",
        myUsername: "我",
        inboxAddresses,
        seats: SEATS,
      }),
    ).toEqual({
      senderName: "协作者 (0x3333…abcd)",
      senderType: "human",
      address: ADDR_PEER,
    });
  });

  it("falls back to short inboxId as human collaborator when inbox address is not yet mapped", () => {
    expect(
      resolveXmtpSender({
        senderInboxId: "abcdef1234567890",
        myInboxId: "inbox-me",
        myUsername: "我",
        inboxAddresses: {},
        seats: SEATS,
      }),
    ).toEqual({
      senderName: "协作者 (abcdef)",
      senderType: "human",
    });
  });
});

describe("detectConflicts", () => {
  it("ignores normal Chinese conjunctions such as 但是 / 不过 / 然而 / 问题在于", () => {
    expect(
      detectConflicts("方案整体可行，但是需要补充缓存；不过接口保持不变，然而延迟更低，问题在于超时参数。"),
    ).toEqual([]);
  });

  it("extracts explicit [CONFLICT] and 【冲突】 lines only", () => {
    expect(
      detectConflicts("普通分析内容\n[CONFLICT] 数据库主键方案不一致\n【冲突】：鉴权头命名存在分歧"),
    ).toEqual(["数据库主键方案不一致", "鉴权头命名存在分歧"]);
  });
});
