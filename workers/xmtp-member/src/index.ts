import { Agent } from "@xmtp/agent-sdk";
import { buildBindingPayload } from "./binding.ts";

export interface MemberConfig {
  xmtpWalletKey?: string;
  xmtpDbEncryptionKey?: string;
  xmtpEnv?: string;
  xmtpPeerAddresses?: string[];
  hubBaseUrl?: string;
  hubToken?: string;
  hubRoomId?: string;
}

export function loadConfigFromEnv(): MemberConfig {
  const peerAddressesRaw = process.env.XMTP_PEER_ADDRESSES || "";
  const peerAddresses = peerAddressesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    xmtpWalletKey: process.env.XMTP_WALLET_KEY,
    xmtpDbEncryptionKey: process.env.XMTP_DB_ENCRYPTION_KEY,
    xmtpEnv: process.env.XMTP_ENV || "dev",
    xmtpPeerAddresses: peerAddresses,
    hubBaseUrl: process.env.HUB_BASE_URL,
    hubToken: process.env.HUB_TOKEN,
    hubRoomId: process.env.HUB_ROOM_ID,
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
