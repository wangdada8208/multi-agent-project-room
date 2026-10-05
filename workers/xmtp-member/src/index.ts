import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Agent } from "@xmtp/agent-sdk";
import { buildBindingPayload } from "./binding.ts";
import { loadCalendar } from "./calendar.ts";
import { approveConsent, denyConsent, expireDue, type ConsentActionDeps } from "./consentActions.ts";
import { ConsentQueue } from "./consentQueue.ts";
import { decodeEnvelope, encodeEnvelope, ENVELOPE_PREFIX, isAddress, type TaskEnvelope } from "./envelope.ts";
import { missingMembers } from "./groupMembers.ts";
import { fetchHubGroupId, resolveGroupPlan } from "./groupPlan.ts";
import { handleEnvelope, type HandleEnvelopeDeps } from "./handleEnvelope.ts";
import { appendInboxOnce, readInbox } from "./inbox.ts";
import { appendLedger, buildLedgerEntry, readLedger, type LedgerEntry } from "./ledger.ts";
import {
  createLocalLoop,
  loadLoopState,
  saveLoopState,
  type LocalLoopState,
} from "./localLoop.ts";
import { completeWithFetch } from "./modelComplete.ts";
import { onInboundText } from "./onInboundText.ts";
import { buildRequestEnvelope } from "./outgoingRequest.ts";
import type { OwnerNote } from "./ownerNote.ts";
import { createOwnerConsoleServer } from "./ownerConsole.ts";
import { ownerNotesBindAddress, readOwnerNotesFile } from "./ownerNotesHttp.ts";
import { loadPolicy } from "./policy.ts";
import { scoreboard } from "./scoreboard.ts";
import { isAllowedSender, parseAllowedSenders } from "./senderPolicy.ts";
import { TaskStore } from "./taskStore.ts";
import type { Connector } from "./connectors/types.ts";
import { LocalCalendarConnector } from "./connectors/localCalendar.ts";
import { GoogleCalendarConnector } from "./connectors/googleCalendar.ts";
import { GmailReceiptConnector } from "./connectors/gmailReceipt.ts";

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
  calendarFile?: string;
  role?: string;
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
    calendarFile: process.env.MAPR_CALENDAR_FILE || undefined,
    role: process.env.XMTP_ROLE || "member",
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
  if (!config.xmtpWalletKey) {
    throw new Error("XMTP_WALLET_KEY is required");
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
  const policyPath = path.join(stateDir, "policy.json");
  const consentsPath = path.join(stateDir, "consents.json");
  const inboxPath = path.join(stateDir, "inbox.json");
  const tasksPath = path.join(stateDir, "tasks.json");
  const calendarPath = config.calendarFile || path.join(stateDir, "calendar.json");

  const policy = config.role === "observer"
    ? { allow: {}, max_range_days: 0 }
    : await loadPolicy(policyPath);
  const queue = new ConsentQueue(consentsPath);
  await queue.load();
  const taskStore = new TaskStore(tasksPath);
  await taskStore.load();

  const credDir = path.join(stateDir, "credentials");
  const googleCred = path.join(credDir, "google.json");
  const gmailCred = path.join(credDir, "gmail.json");

  const connectors: Connector[] = [];
  if (existsSync(googleCred)) {
    connectors.push(new GoogleCalendarConnector({ credentialPath: googleCred }));
  } else {
    connectors.push(new LocalCalendarConnector(calendarPath));
  }
  if (existsSync(gmailCred)) {
    connectors.push(new GmailReceiptConnector({ credentialPath: gmailCred }));
  }

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

  const writeLedger = (entry: LedgerEntry) => appendLedger(ledgerPath, entry);

  async function sendToConversation(conversationId: string, text: string): Promise<void> {
    let ctx = await agent.getConversationContext(conversationId);
    if (!ctx) {
      await agent.client.conversations.syncAll();
      ctx = await agent.getConversationContext(conversationId);
    }
    if (!ctx) throw new Error("conversation not found");
    await ctx.conversation.sendText(text);
  }

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

  const envelopeDeps: HandleEnvelopeDeps = {
    selfAddress,
    policy,
    queue,
    taskStore,
    completeModel: complete,
    send: sendToConversation,
    appendLedger: writeLedger,
    storeDisclosure: (disclosure, from) =>
      appendInboxOnce(inboxPath, {
        received_at: new Date().toISOString(),
        from,
        request_id: disclosure.request_id,
        grant_id: disclosure.grant.grant_id,
        payload: disclosure.payload,
      }),
    now: () => new Date(),
  };

  const actionDeps: ConsentActionDeps = {
    selfAddress,
    privateKey: config.xmtpWalletKey,
    queue,
    connectors,
    loadCalendar: () => loadCalendar(calendarPath),
    send: sendToConversation,
    appendLedger: writeLedger,
    now: () => new Date(),
  };

  let activeGroupId: string | null = null;

  const consoleServer = createOwnerConsoleServer({
    selfAddress,
    role: config.role,
    queue,
    readLedger: () => readLedger(ledgerPath),
    readInbox: () => readInbox(inboxPath),
    readOwnerNotes: () => readOwnerNotesFile(ownerNotesPath),
    readScoreboard: async () => scoreboard(await readLedger(ledgerPath)),
    readTasks: () => taskStore.list(),
    approve: (id) => approveConsent(id, actionDeps),
    deny: (id) => denyConsent(id, "owner_denied", actionDeps),
    sendRequest: async (body) => {
      if (!activeGroupId) return { ok: false, reason: "no_group" };
      const built = buildRequestEnvelope(body, selfAddress);
      if (!built.ok) return { ok: false, reason: built.reason };
      await sendToConversation(activeGroupId, encodeEnvelope(built.envelope));
      await writeLedger(
        buildLedgerEntry({
          now: new Date(),
          kind: "request_sent",
          requestId: built.envelope.request_id,
          peer: built.envelope.to,
          scope: built.envelope.scope,
        })
      );
      return { ok: true, request_id: built.envelope.request_id };
    },
    sendTask: async (body) => {
      if (!activeGroupId) return { ok: false, reason: "no_group" };
      if (!isAddress(body?.to)) return { ok: false, reason: "invalid_to" };
      if (typeof body?.goal !== "string" || body.goal.trim().length === 0 || body.goal.length > 500) {
        return { ok: false, reason: "invalid_goal" };
      }
      if (!Array.isArray(body?.acceptance) || body.acceptance.length === 0 || body.acceptance.length > 5) {
        return { ok: false, reason: "invalid_acceptance" };
      }
      const taskEnv: TaskEnvelope = {
        kind: "task",
        request_id: randomUUID(),
        to: body.to.toLowerCase(),
        goal: body.goal.trim(),
        acceptance: body.acceptance.map((a: any) => String(a).slice(0, 200)),
        round: 1,
      };
      await taskStore.add(taskEnv);
      await sendToConversation(activeGroupId, encodeEnvelope(taskEnv));
      await writeLedger(
        buildLedgerEntry({
          now: new Date(),
          kind: "task_sent",
          requestId: taskEnv.request_id,
          peer: taskEnv.to,
          scope: "task.run",
        })
      );
      return { ok: true, request_id: taskEnv.request_id };
    },
  });
  const consolePort = parseInt(config.ownerNotesPort || "8787", 10);
  consoleServer.listen(consolePort, ownerNotesBindAddress());

  const expiryTimer = setInterval(() => {
    expireDue(actionDeps).catch((err) => console.error("Expiry error:", err.message));
  }, 30_000);
  expiryTimer.unref();

  agent.on("text", async (ctx: any) => {
    const sender = ((await ctx.getSenderAddress()) || "").toLowerCase();
    if (sender && sender === selfAddress) return;
    if (!isAllowedSender(sender, config.allowedSenders)) {
      await writeLedger(
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

    const envelope = decodeEnvelope(text);
    if (envelope) {
      try {
        await handleEnvelope({ envelope, sender, conversationId: ctx.conversation.id }, envelopeDeps);
      } catch (err: any) {
        console.error("Envelope error:", err.message);
      }
      return;
    }
    if (text.startsWith(ENVELOPE_PREFIX)) return;

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
    activeGroupId = group.id;
    console.log(`[member] created group ${group.id}`);
    if (hubConfigured) {
      await bindGroupToHub(config.hubBaseUrl!, config.hubRoomId!, config.hubToken!, group.id);
    }
  } else if (plan.action === "use") {
    activeGroupId = plan.groupId;
    console.log(`[member] using group ${plan.groupId} from ${plan.source}`);
    await ensurePeersInGroup(plan.groupId, config.xmtpPeerAddresses || []);
  } else {
    console.log("[member] no group configured; listening only");
  }

  console.log(`[member] address ${selfAddress}`);
  console.log(`[member] owner console http://127.0.0.1:${consolePort}/`);
  await agent.start();
}

if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  startMember().catch((err) => {
    console.error("Worker process error:", err.message);
    process.exit(1);
  });
}
