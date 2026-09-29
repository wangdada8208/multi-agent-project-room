import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Agent } from "@xmtp/agent-sdk";
import { buildBindingPayload } from "./binding.ts";
import { missingMembers } from "./groupMembers.ts";
import { fetchHubGroupId, resolveGroupPlan } from "./groupPlan.ts";
import { appendLedger, buildLedgerEntry } from "./ledger.ts";
import {
  createLocalLoop,
  loadLoopState,
  saveLoopState,
  type LocalLoopState,
} from "./localLoop.ts";
import { completeWithFetch } from "./modelComplete.ts";
import { onInboundText } from "./onInboundText.ts";
import type { OwnerNote } from "./ownerNote.ts";
import {
  createOwnerNotesServer,
  ownerNotesBindAddress,
} from "./ownerNotesHttp.ts";
import { isAllowedSender, parseAllowedSenders } from "./senderPolicy.ts";

export interface MemberConfig {
  selfName?: string;
  participants?: string[];
  xmtpWalletKey?: string;
  xmtpDbEncryptionKey?: string;
  xmtpEnv?: string;
  xmtpPeerAddresses?: string[];
  xmtpGroupId?: string;
  allowedSenders: string[];
  hubBaseUrl?: string;
  hubToken?: string;
  hubRoomId?: string;
  loopStatePath?: string;
  memberModelApiKey?: string;
  memberModelUrl?: string;
  approvedDays?: string[];
  sensitiveKeywords?: string[];
  ownerNotesPort?: string;
}

function splitList(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfigFromEnv(): MemberConfig {
  const participants = splitList(process.env.XMTP_PARTICIPANTS);
  const approvedDays = splitList(process.env.XMTP_APPROVED_DAYS);
  const sensitiveKeywords = splitList(process.env.XMTP_SENSITIVE_KEYWORDS);

  const defaultStatePath = existsSync("workers/xmtp-member")
    ? path.resolve("workers/xmtp-member/.state/loop.json")
    : path.resolve(".state/loop.json");

  return {
    selfName: process.env.XMTP_SELF_NAME || "Codex",
    participants: participants.length > 0 ? participants : ["Codex", "Claude"],
    xmtpWalletKey: process.env.XMTP_WALLET_KEY,
    xmtpDbEncryptionKey: process.env.XMTP_DB_ENCRYPTION_KEY,
    xmtpEnv: process.env.XMTP_ENV || "dev",
    xmtpPeerAddresses: splitList(process.env.XMTP_PEER_ADDRESSES).map((s) => s.toLowerCase()),
    xmtpGroupId: process.env.XMTP_GROUP_ID || undefined,
    allowedSenders: parseAllowedSenders(process.env.XMTP_ALLOWED_SENDERS),
    hubBaseUrl: process.env.HUB_BASE_URL,
    hubToken: process.env.HUB_TOKEN,
    hubRoomId: process.env.HUB_ROOM_ID,
    loopStatePath: process.env.XMTP_LOOP_STATE_PATH || defaultStatePath,
    memberModelApiKey: process.env.MEMBER_MODEL_API_KEY,
    memberModelUrl: process.env.MEMBER_MODEL_URL,
    approvedDays: approvedDays.length > 0 ? approvedDays : undefined,
    sensitiveKeywords: sensitiveKeywords.length > 0 ? sensitiveKeywords : undefined,
    ownerNotesPort: process.env.OWNER_NOTES_PORT,
  };
}

export async function appendOwnerNote(
  filePath: string,
  note: OwnerNote
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(note) + "\n", "utf8");
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
  if (config.allowedSenders.length === 0) {
    throw new Error("XMTP_ALLOWED_SENDERS is empty; refusing to start");
  }
  const agent = await Agent.createFromEnv();
  const selfAddress = (agent.address || "").toLowerCase();

  const statePath =
    config.loopStatePath ||
    (existsSync("workers/xmtp-member")
      ? path.resolve("workers/xmtp-member/.state/loop.json")
      : path.resolve(".state/loop.json"));
  const stateDir = path.dirname(statePath);
  const ownerNotesPath = path.join(stateDir, "owner-notes.jsonl");
  const ledgerPath = path.join(stateDir, "ledger.jsonl");

  const ownerNotesServer = createOwnerNotesServer(ownerNotesPath);
  const ownerNotesPort = parseInt(config.ownerNotesPort || "8787", 10);
  ownerNotesServer.listen(ownerNotesPort, ownerNotesBindAddress());

  let loopState: LocalLoopState;
  if (existsSync(statePath)) {
    loopState = await loadLoopState(statePath);
  } else {
    loopState = createLocalLoop({
      participants: config.participants || ["Codex", "Claude"],
      selfName: config.selfName || "Codex",
    });
  }

  const complete =
    config.memberModelApiKey && config.memberModelUrl
      ? (prompt: string) =>
          completeWithFetch({
            apiKey: config.memberModelApiKey!,
            url: config.memberModelUrl!,
            prompt,
          })
      : undefined;

  async function ensurePeersInGroup(groupId: string, peers: string[]): Promise<void> {
    if (peers.length === 0) return;
    await agent.client.conversations.syncAll();
    const ctx = await agent.getConversationContext(groupId);
    if (!ctx || !ctx.isGroup()) {
      console.warn(`[member] group ${groupId} not found locally; is this member in the group?`);
      return;
    }
    const members = await ctx.conversation.members();
    const present = members.flatMap((m) => m.accountIdentifiers.map((i) => i.identifier));
    const missing = missingMembers(present, peers);
    if (missing.length === 0) return;
    await agent.addMembersWithAddresses(ctx.conversation, missing as `0x${string}`[]);
    console.log(`[member] added ${missing.length} peer(s) to group`);
  }

  agent.on("text", async (ctx: any) => {
    const sender = ((await ctx.getSenderAddress()) || "").toLowerCase();
    if (sender && sender === selfAddress) return;
    if (!isAllowedSender(sender, config.allowedSenders)) {
      await appendLedger(
        ledgerPath,
        buildLedgerEntry({
          now: new Date(),
          kind: "sender_dropped",
          peer: sender || null,
          reason: "sender_not_allowed",
        })
      );
      return;
    }

    const text =
      typeof ctx.message?.content === "string"
        ? ctx.message.content
        : ctx.message?.content?.text || "";

    try {
      loopState = await onInboundText({
        state: loopState,
        text,
        complete,
        approvedDays: config.approvedDays,
        sensitiveKeywords: config.sensitiveKeywords,
        recordOwner: async (note) => {
          await appendOwnerNote(ownerNotesPath, note);
        },
        sendText: async (body: string) => {
          await ctx.conversation.sendText(body);
        },
        saveState: async (nextState: LocalLoopState) => {
          await saveLoopState(statePath, nextState);
        },
      });
    } catch (err: any) {
      console.error("Worker process error:", err.message);
    }
  });

  const hubConfigured = Boolean(config.hubBaseUrl && config.hubRoomId && config.hubToken);
  const hubGroupId = hubConfigured
    ? await fetchHubGroupId({
        hubBaseUrl: config.hubBaseUrl!,
        hubRoomId: config.hubRoomId!,
        hubToken: config.hubToken!,
      })
    : null;

  const plan = resolveGroupPlan({
    envGroupId: config.xmtpGroupId,
    hubGroupId,
    peerAddresses: config.xmtpPeerAddresses || [],
  });

  if (plan.action === "create") {
    const group = await agent.createGroupWithAddresses(
      (config.xmtpPeerAddresses || []) as `0x${string}`[]
    );
    console.log(`[member] created group ${group.id}`);
    if (hubConfigured) {
      await bindGroupToHub(config.hubBaseUrl!, config.hubRoomId!, config.hubToken!, group.id);
    }
  } else if (plan.action === "use") {
    console.log(`[member] using group ${plan.groupId} from ${plan.source}`);
    await ensurePeersInGroup(plan.groupId, config.xmtpPeerAddresses || []);
  } else {
    console.log("[member] no group configured; listening only");
  }

  console.log(`[member] address ${selfAddress}`);
  await agent.start();
}

if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  startMember().catch((err) => {
    console.error("Worker process error:", err.message);
    process.exit(1);
  });
}
