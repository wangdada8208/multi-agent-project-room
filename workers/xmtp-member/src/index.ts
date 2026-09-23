import { existsSync } from "node:fs";
import path from "node:path";
import { Agent } from "@xmtp/agent-sdk";
import { buildBindingPayload } from "./binding.ts";
import {
  createLocalLoop,
  loadLoopState,
  saveLoopState,
  type LocalLoopState,
} from "./localLoop.ts";
import { onInboundText } from "./onInboundText.ts";

export interface MemberConfig {
  selfName?: string;
  participants?: string[];
  xmtpWalletKey?: string;
  xmtpDbEncryptionKey?: string;
  xmtpEnv?: string;
  xmtpPeerAddresses?: string[];
  hubBaseUrl?: string;
  hubToken?: string;
  hubRoomId?: string;
  loopStatePath?: string;
}

export function loadConfigFromEnv(): MemberConfig {
  const peerAddressesRaw = process.env.XMTP_PEER_ADDRESSES || "";
  const peerAddresses = peerAddressesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const participantsRaw = process.env.XMTP_PARTICIPANTS || "";
  const participants = participantsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const defaultStatePath = existsSync("workers/xmtp-member")
    ? path.resolve("workers/xmtp-member/.state/loop.json")
    : path.resolve(".state/loop.json");

  return {
    selfName: process.env.XMTP_SELF_NAME || "Codex",
    participants: participants.length > 0 ? participants : ["Codex", "Claude"],
    xmtpWalletKey: process.env.XMTP_WALLET_KEY,
    xmtpDbEncryptionKey: process.env.XMTP_DB_ENCRYPTION_KEY,
    xmtpEnv: process.env.XMTP_ENV || "dev",
    xmtpPeerAddresses: peerAddresses,
    hubBaseUrl: process.env.HUB_BASE_URL,
    hubToken: process.env.HUB_TOKEN,
    hubRoomId: process.env.HUB_ROOM_ID,
    loopStatePath: process.env.XMTP_LOOP_STATE_PATH || defaultStatePath,
  };
}

export async function bindGroupToHub(
  hubBaseUrl: string,
  hubRoomId: string,
  hubToken: string,
  groupId: string
): Promise<void> {
  const payload = buildBindingPayload({ xmtpGroupId: groupId });
  const url = `${hubBaseUrl.replace(/\/$/, "")}/api/v1/rooms/${hubRoomId}/xmtp-binding`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hubToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`Failed to bind group to hub: HTTP status ${resp.status}`);
  }
}

export async function startMember(): Promise<void> {
  const config = loadConfigFromEnv();
  const agent = await Agent.createFromEnv();

  const statePath =
    config.loopStatePath ||
    (existsSync("workers/xmtp-member")
      ? path.resolve("workers/xmtp-member/.state/loop.json")
      : path.resolve(".state/loop.json"));

  let loopState: LocalLoopState;
  if (existsSync(statePath)) {
    loopState = await loadLoopState(statePath);
  } else {
    loopState = createLocalLoop({
      participants: config.participants || ["Codex", "Claude"],
      selfName: config.selfName || "Codex",
    });
  }

  agent.on("text", async (ctx: any) => {
    const text =
      typeof ctx.message?.content === "string"
        ? ctx.message.content
        : ctx.message?.content?.text || "";

    try {
      loopState = await onInboundText({
        state: loopState,
        text,
        sendText: async (body: string) => {
          if (typeof ctx.sendText === "function") {
            await ctx.sendText(body);
          } else if (ctx.conversation && typeof ctx.conversation.sendText === "function") {
            await ctx.conversation.sendText(body);
          }
        },
        saveState: async (nextState: LocalLoopState) => {
          await saveLoopState(statePath, nextState);
        },
      });
    } catch (err: any) {
      console.error("Worker process error:", err.message);
    }
  });

  if (
    config.hubBaseUrl &&
    config.hubRoomId &&
    config.hubToken &&
    config.xmtpPeerAddresses &&
    config.xmtpPeerAddresses.length > 0
  ) {
    const group = await agent.createGroupWithAddresses(
      config.xmtpPeerAddresses
    );
    const groupId = group.id;
    await bindGroupToHub(
      config.hubBaseUrl,
      config.hubRoomId,
      config.hubToken,
      groupId
    );
  }

  await agent.start();
}

if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  startMember().catch((err) => {
    console.error("Worker process error:", err.message);
    process.exit(1);
  });
}
