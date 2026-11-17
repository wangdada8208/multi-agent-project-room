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
import { fetchHubGroupId, fetchHubSeatPeers, resolveGroupPlan } from "./groupPlan.ts";
import { handleEnvelope, type HandleEnvelopeDeps } from "./handleEnvelope.ts";
import { appendInboxOnce, readInbox } from "./inbox.ts";
import { appendLedger, buildLedgerEntry, readLedger, type LedgerEntry } from "./ledger.ts";
import {
  createLocalLoop,
  loadLoopState,
  saveLoopState,
  type LocalLoopState,
} from "./localLoop.ts";
import { createReplyEngine, engineConfigFromEnv, engineToComplete } from "./engines/index.ts";
import { onInboundText } from "./onInboundText.ts";
import { buildRequestEnvelope } from "./outgoingRequest.ts";
import type { OwnerNote } from "./ownerNote.ts";
import { createOwnerConsoleServer } from "./ownerConsole.ts";
import { ownerNotesBindAddress, readOwnerNotesFile } from "./ownerNotesHttp.ts";
import { loadPolicy } from "./policy.ts";
import { scoreboard } from "./scoreboard.ts";
import { GroupMemberCache, isAllowedSender, parseAllowedSenders } from "./senderPolicy.ts";
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
  // 白名单为空时，只有 XMTP_ALLOW_GROUP_MEMBERS=1 才能启动：席位走 via=local 建座时
  // Hub 返回空 allowed_senders，群成员放行本来就交给群成员缓存（决定 D3）。
  if (config.allowedSenders.length === 0 && process.env.XMTP_ALLOW_GROUP_MEMBERS !== "1") {
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

  const engineConfig = engineConfigFromEnv(process.env);
  const complete = engineConfig
    ? engineToComplete(createReplyEngine(engineConfig), engineConfig.timeoutMs)
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
    privateKey: config.xmtpWalletKey,
    connectors,
    role: config.role,
    queue,
    readLedger: () => readLedger(ledgerPath),
    readInbox: () => readInbox(inboxPath),
    readOwnerNotes: () => readOwnerNotesFile(ownerNotesPath),
    readScoreboard: async () => scoreboard(await readLedger(ledgerPath)),
    readTasks: () => taskStore.list(),
    appendLedger: writeLedger,
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

  const groupMembers = new GroupMemberCache();
  const allowGroupMembers = process.env.XMTP_ALLOW_GROUP_MEMBERS === "1";
  // 本房其他席位的 XMTP 地址（连环护栏区分人/Agent 发言）。Hub 连不上时为空——
  // 全部发送者按人类处理，护栏不起作用，行为与旧版一致。
  const seatPeerAddresses = new Set<string>();
  const loopGuardLimit = (() => {
    const n = Number.parseInt(process.env.XMTP_LOOP_GUARD_LIMIT || "", 10);
    return Number.isFinite(n) ? n : undefined;
  })();

  agent.on("text", async (ctx: any) => {
    const sender = ((await ctx.getSenderAddress()) || "").toLowerCase();
    if (sender && sender === selfAddress) return;
    const senderAllowed =
      isAllowedSender(sender, config.allowedSenders) ||
      (allowGroupMembers &&
        typeof ctx.isGroup === "function" &&
        ctx.isGroup() &&
        (await groupMembers.allows(sender, ctx.conversation)));
    if (!senderAllowed) {
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
        senderIsAgent: seatPeerAddresses.has(sender),
        guardLimit: loopGuardLimit,
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

  if (hubConfigured) {
    const refreshSeatPeers = async () => {
      try {
        const peers = await fetchHubSeatPeers({
          hubBaseUrl: config.hubBaseUrl!,
          hubRoomId: config.hubRoomId!,
          hubToken: config.hubToken!,
        });
        if (peers === null) return; // 旧版 Hub 没有此接口或暂时失败，保留上一份名单
        seatPeerAddresses.clear();
        for (const p of peers) {
          const addr = p.xmtp_address.toLowerCase();
          if (addr !== selfAddress) seatPeerAddresses.add(addr);
        }
      } catch {
        // 网络抖动不致命，下一轮再试。
      }
    };
    await refreshSeatPeers();
    const peerTimer = setInterval(refreshSeatPeers, 60_000);
    peerTimer.unref();
  }

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
