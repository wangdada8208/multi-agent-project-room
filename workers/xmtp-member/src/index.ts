import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Agent } from "@xmtp/agent-sdk";
import { checkpointFromVerification, signLedgerCheckpoint } from "./activity.ts";
import { AccountStore, resolveCredentialPath } from "./accounts.ts";
import { buildBindingPayload } from "./binding.ts";
import { loadCalendar } from "./calendar.ts";
import {
  approveConsent,
  consentTtl,
  denyConsent,
  expireDue,
  persistCrashRecoveryReceipts,
  resendPendingReceipts,
  resendReceipt,
  type ConsentActionDeps,
} from "./consentActions.ts";
import { ConsentQueue } from "./consentQueue.ts";
import {
  buildActionRequestEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  ENVELOPE_PREFIX,
  isAddress,
  type TaskEnvelope,
} from "./envelope.ts";
import { hashPayload } from "./grant.ts";
import { missingMembers } from "./groupMembers.ts";
import { fetchHubGroupId, fetchHubSeatPeers, resolveGroupPlan } from "./groupPlan.ts";
import { handleEnvelope, type HandleEnvelopeDeps } from "./handleEnvelope.ts";
import { appendInboxOnce, readInbox } from "./inbox.ts";
import { appendLedger, buildLedgerEntry, readLedger, verifyLedger, type LedgerEntry } from "./ledger.ts";
import {
  createLocalLoop,
  loadLoopState,
  saveLoopState,
  type LocalLoopState,
} from "./localLoop.ts";
import { createReplyEngine, engineConfigFromEnv, engineToComplete } from "./engines/index.ts";
import { onInboundText } from "./onInboundText.ts";
import { buildRequestEnvelope } from "./outgoingRequest.ts";
import { OutgoingRequests } from "./outgoingRequests.ts";
import type { OwnerNote } from "./ownerNote.ts";
import { createOwnerConsoleServer } from "./ownerConsole.ts";
import { ownerNotesBindAddress, readOwnerNotesFile } from "./ownerNotesHttp.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import {
  applyMemberRevoked,
  RevocationDedup,
  RevocationReconciler,
  RevocationRetries,
  RevocationStore,
} from "./revocations.ts";
import { loadHubRoomSettings, mergeHubHouseRules, type HubRoomSettings } from "./rulesEngine.ts";
import { scoreboard } from "./scoreboard.ts";
import { writeJsonSecure } from "./secureFile.ts";
import { GroupMemberCache, isSenderAuthorized, parseAllowedSenders } from "./senderPolicy.ts";
import { TaskStore } from "./taskStore.ts";
import { TriggerEngine, TriggerStore } from "./triggers.ts";
import { startCloudSeatPolling } from "./helper/cloudSeat.ts";
import { ROOM_SETTINGS_FILENAME } from "./helper/up.ts";
import type { Connector } from "./connectors/types.ts";
import { LocalCalendarConnector } from "./connectors/localCalendar.ts";
import { GoogleCalendarConnector } from "./connectors/googleCalendar.ts";
import { GmailReceiptConnector } from "./connectors/gmailReceipt.ts";
import { GmailSendConnector } from "./connectors/gmailSend.ts";
import { validateActionParams } from "./connectors/actionSchemas.ts";

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

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MemberConfig {
  const rawParticipants = (env.XMTP_PARTICIPANTS || "").trim();
  const participants = splitList(rawParticipants);
  const mentionOnly = env.XMTP_MENTION_ONLY === "1" && !rawParticipants;
  const approvedDays = splitList(env.XMTP_APPROVED_DAYS);
  const sensitiveKeywords = splitList(env.XMTP_SENSITIVE_KEYWORDS);

  const defaultStatePath = existsSync("workers/xmtp-member")
    ? path.resolve("workers/xmtp-member/.state/loop.json")
    : path.resolve(".state/loop.json");

  return {
    selfName: env.XMTP_SELF_NAME || "Codex",
    participants: participants.length > 0 ? participants : mentionOnly ? [] : ["Codex", "Claude"],
    xmtpWalletKey: env.XMTP_WALLET_KEY,
    xmtpDbEncryptionKey: env.XMTP_DB_ENCRYPTION_KEY,
    xmtpEnv: env.XMTP_ENV || "dev",
    xmtpPeerAddresses: splitList(env.XMTP_PEER_ADDRESSES).map((s) => s.toLowerCase()),
    xmtpGroupId: env.XMTP_GROUP_ID || undefined,
    allowedSenders: parseAllowedSenders(env.XMTP_ALLOWED_SENDERS),
    hubBaseUrl: env.HUB_BASE_URL || env.MAPR_HUB_URL || undefined,
    hubToken: env.HUB_TOKEN || env.MAPR_AGENT_TOKEN || undefined,
    hubRoomId: env.HUB_ROOM_ID,
    loopStatePath: env.XMTP_LOOP_STATE_PATH || defaultStatePath,
    memberModelApiKey: env.MEMBER_MODEL_API_KEY,
    memberModelUrl: env.MEMBER_MODEL_URL,
    approvedDays: approvedDays.length > 0 ? approvedDays : undefined,
    sensitiveKeywords: sensitiveKeywords.length > 0 ? sensitiveKeywords : undefined,
    ownerNotesPort: env.OWNER_NOTES_PORT,
    calendarFile: env.MAPR_CALENDAR_FILE || undefined,
    role: env.XMTP_ROLE || "member",
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
  const walletKey = config.xmtpWalletKey; // 收窄成 string，闭包内可用
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
  const outgoingPath = path.join(stateDir, "outgoing-requests.json");
  const revokedPath = path.join(stateDir, "revoked.json");
  const revocationRetriesPath = path.join(stateDir, "revocation-retries.json");
  const calendarPath = config.calendarFile || path.join(stateDir, "calendar.json");
  const accountsPath = path.join(stateDir, "accounts.json");
  const triggersPath = path.join(stateDir, "triggers.json");
  const checkpointPath = path.join(stateDir, "ledger-checkpoint.json");
  const hubRoomSettingsPath = path.join(stateDir, ROOM_SETTINGS_FILENAME);

  const policy = config.role === "observer"
    ? { allow: {}, max_range_days: 0 }
    : await loadPolicy(policyPath);
  let hubRoomSettings: HubRoomSettings | null = await loadHubRoomSettings(hubRoomSettingsPath);
  const runtimePolicy: Policy = {
    allow: policy.allow,
    max_range_days: policy.max_range_days,
    rules: mergeHubHouseRules(policy, hubRoomSettings),
  };
  let currentHubToken = config.hubToken || "";
  let cloudSeatPaused = false;
  let lastUploadedCheckpointSeq = -1;
  const queue = new ConsentQueue(consentsPath);
  await queue.load();
  // 崩溃恢复对账：停在 executing 的条目结果不明 ⇒ uncertain，绝不自动重放。
  const recovered = await queue.recoverAfterLoad();
  for (const item of recovered) {
    await appendLedger(
      ledgerPath,
      buildLedgerEntry({
        now: new Date(),
        kind: "recovered_uncertain",
        requestId: item.request_id,
        peer: item.requester,
        scope: item.scope,
        reason: "crash_recovery_uncertain",
      })
    ).catch(() => {});
  }
  const outgoing = new OutgoingRequests(outgoingPath);
  await outgoing.load();
  const revokedStore = new RevocationStore(revokedPath);
  await revokedStore.load();
  const revokedRetries = new RevocationRetries({ file: revocationRetriesPath });
  await revokedRetries.load();
  const taskStore = new TaskStore(tasksPath);
  await taskStore.load();
  const accountStore = new AccountStore(accountsPath);
  await accountStore.load();
  const triggerStore = new TriggerStore(triggersPath);
  await triggerStore.load();

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
    connectors.push(new GmailSendConnector({ credentialPath: gmailCred }));
  }
  // WP7 多账户：accounts.json 里每个登记账户额外挂一个 accountId 绑定的连接器。
  // cred_path 非法（目录穿越等）时该账户不挂连接器——路由自然落空成 no_connector。
  for (const account of accountStore.list()) {
    let credPath: string;
    try {
      credPath = resolveCredentialPath(credDir, account.cred_path);
    } catch {
      continue;
    }
    if (account.service === "gmail") {
      connectors.push(new GmailReceiptConnector({ credentialPath: credPath, accountId: account.id }));
      connectors.push(new GmailSendConnector({ credentialPath: credPath, accountId: account.id }));
    } else if (account.service === "google_calendar") {
      connectors.push(new GoogleCalendarConnector({ credentialPath: credPath, accountId: account.id }));
    }
  }

  let loopState: LocalLoopState;
  if (existsSync(statePath)) {
    loopState = await loadLoopState(statePath);
    if (process.env.XMTP_MENTION_ONLY === "1" && !(process.env.XMTP_PARTICIPANTS || "").trim()) {
      loopState = { ...loopState, participants: [] };
    }
  } else {
    loopState = createLocalLoop({
      participants: config.participants ?? ["Codex", "Claude"],
      selfName: config.selfName || "Codex",
    });
  }

  const engineConfig = engineConfigFromEnv(process.env);
  const complete = engineConfig
    ? engineToComplete(createReplyEngine(engineConfig), engineConfig.timeoutMs)
    : undefined;

  const writeLedger = (entry: LedgerEntry) => appendLedger(ledgerPath, entry);
  const groupMembers = new GroupMemberCache();
  const revokedDedup = new RevocationDedup();
  let activeGroupId: string | null = null;

  async function runRevocationProbe(
    input: { address: string; conversationId: string; sender: string; requestId: string },
    fromRetry = false
  ) {
    const result = await applyMemberRevoked(input, {
      activeGroupId: () => activeGroupId,
      getConversation: async (id) => (await agent.getConversationContext(id)) ?? null,
      syncAll: async () => {
        await agent.client.conversations.syncAll();
      },
      policy,
      allowedSenders: config.allowedSenders,
      revoked: revokedStore,
      dedup: revokedDedup,
      queue,
      fromRetry,
      now: () => new Date(),
    });
    for (const requestId of result.deniedRequestIds) {
      await writeLedger(
        buildLedgerEntry({
          now: new Date(),
          kind: "consent_denied",
          requestId,
          peer: input.address,
          sender: input.sender,
          reason: "member_revoked",
        })
      );
    }
    return result;
  }

  const reportRevocationError = (error: unknown) => {
    console.error("Revocation reconcile error:", error instanceof Error ? error.message : "unknown error");
  };
  const revocationReconciler = new RevocationReconciler({
    retries: revokedRetries,
    probe: (input) => runRevocationProbe(input, true),
    onApplied: async (pending) => {
      await writeLedger(
        buildLedgerEntry({
          now: new Date(),
          kind: "member_revoked_received",
          requestId: pending.requestId,
          peer: pending.address,
          sender: pending.sender,
          reason: "retry_reconcile",
        })
      );
    },
    onStalled: async (pending) => {
      await writeLedger(
        buildLedgerEntry({
          now: new Date(),
          kind: "member_revoked_received",
          requestId: pending.requestId,
          peer: pending.address,
          sender: pending.sender,
          reason: "stalled",
        })
      );
    },
    onError: reportRevocationError,
  });

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
    storeActionResult: (env, from) =>
      appendInboxOnce(inboxPath, {
        received_at: new Date().toISOString(),
        from,
        request_id: env.request_id,
        grant_id: env.grant.grant_id,
        payload: { kind: "action_result", status: env.status, receipt: env.receipt, summary: env.summary },
      }),
    canExecuteAction: (action) =>
      connectors.some((c) => c.scopes.includes(action) && typeof c.execute === "function"),
    autoApprove: (id) => approveConsent(id, actionDeps),
    onMemberRevoked: async (address, conversationId, sender, requestId) => {
      groupMembers.invalidate(conversationId);
      const result = await runRevocationProbe({ address, conversationId, sender, requestId });
      if ((result.outcome === "unconfirmed" && !result.subjectPresent) || result.outcome === "rate_limited") {
        // 核实不通过/被限速 ⇒ 有界重试对账；伪造最坏只多几次 members()，绝不误清授权。
        await revokedRetries.schedule({ address, conversationId, sender, requestId }, Date.now());
      }
      return result.outcome;
    },
    outgoing,
    hubRoomSettings: () => hubRoomSettings,
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
    isRequesterRevoked: (requester, conversationId) => revokedStore.has(requester, conversationId),
    now: () => new Date(),
  };

  // M1：给崩溃恢复的 uncertain 条目补签真实回执——状态留终态，只补发不重放；
  // 发送交给 resendPendingReceipts（启动后 + 周期对账）。
  await persistCrashRecoveryReceipts(recovered, actionDeps)
    .catch((err) => console.error("Recovery receipt error:", err.message));

  // M5：把已验链头签成锚点落盘，/api/activity 拿它检出相对锚点的截断与改写。
  // 链校验不过或为空时不刷新——宁可留旧锚点让问题暴露，也不用可疑状态盖掉它。
  const writeLedgerCheckpoint = async (): Promise<void> => {
    const result = await verifyLedger(ledgerPath);
    if (!result.ok || !result.head) return;
    const roomId = config.hubRoomId || activeGroupId || "local";
    const checkpoint = await signLedgerCheckpoint(
      checkpointFromVerification(result, {
        room_id: roomId,
        stream_id: selfAddress,
      }),
      walletKey
    );
    await writeJsonSecure(checkpointPath, checkpoint);
    const cloudSeatId = (process.env.MAPR_SEAT_ID || "").trim();
    const hubOrigin = (config.hubBaseUrl || "").trim().replace(/\/+$/, "");
    if (cloudSeatId && hubOrigin && config.hubRoomId && currentHubToken && checkpoint.head_seq > lastUploadedCheckpointSeq) {
      try {
        const res = await fetch(
          `${hubOrigin}/api/v1/rooms/${encodeURIComponent(config.hubRoomId)}/activity/checkpoints`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${currentHubToken}`,
            },
            body: JSON.stringify({ checkpoints: [checkpoint] }),
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (res.ok) lastUploadedCheckpointSeq = checkpoint.head_seq;
      } catch {
        // 检查点上传失败不致命，下轮定时刷新会自动重传。
      }
    }
  };
  await writeLedgerCheckpoint().catch((err) => console.error("Checkpoint error:", err.message));

  // WP7：触发器引擎——与 approveConsent 完全同一条批准执行路径；start 是幂等的，
  // 只有存在启用中的触发器才会真正起巡检定时器。
  const triggerEngine = new TriggerEngine({
    store: triggerStore,
    accounts: accountStore,
    credDir,
    selfAddress,
    policy: runtimePolicy,
    queue,
    appendLedger: writeLedger,
    approve: (id) => approveConsent(id, actionDeps),
    appendInbox: (entry) => appendInboxOnce(inboxPath, entry),
  });

  const consoleServer = createOwnerConsoleServer({
    selfAddress,
    privateKey: config.xmtpWalletKey,
    connectors,
    role: config.role,
    queue,
    accounts: accountStore,
    triggers: triggerStore,
    credDir,
    ledgerFile: ledgerPath,
    ledgerCheckpointFile: checkpointPath,
    policy: runtimePolicy,
    onTriggersChanged: () => triggerEngine.refresh(),
    readLedger: () => readLedger(ledgerPath),
    readInbox: () => readInbox(inboxPath),
    readOwnerNotes: () => readOwnerNotesFile(ownerNotesPath),
    readScoreboard: async () => scoreboard(await readLedger(ledgerPath)),
    readTasks: () => taskStore.list(),
    appendLedger: writeLedger,
    approve: (id) => approveConsent(id, actionDeps),
    deny: (id) => denyConsent(id, "owner_denied", actionDeps),
    resend: (id) => resendReceipt(id, actionDeps),
    sendRequest: async (body) => {
      if (!activeGroupId) return { ok: false, reason: "no_group" };
      const built = buildRequestEnvelope(body, selfAddress);
      if (!built.ok) return { ok: false, reason: built.reason };
      const sentAt = new Date();
      // 先落盘再发送：快速回执和发送结果不明的崩溃窗口都不能绕过请求绑定。
      const registered = await outgoing.register({
        request_id: built.envelope.request_id,
        to: built.envelope.to,
        kind: "data",
        scope: built.envelope.scope,
        created_at: sentAt.toISOString(),
        expires_at: new Date(sentAt.getTime() + consentTtl("data")).toISOString(),
      });
      if (!registered) return { ok: false, reason: "request_not_registered" };
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
    sendActionRequest: async (body) => {
      if (!activeGroupId) return { ok: false, reason: "no_group" };
      const built = buildActionRequestEnvelope(body ?? {}, selfAddress);
      if (!built.ok) return { ok: false, reason: built.reason };
      // 本地先过 schema：对端收到畸形 params 只会拒，不如发出前就 fail fast。
      const paramCheck = validateActionParams(built.envelope.action, built.envelope.params);
      if (!paramCheck.ok) return { ok: false, reason: `invalid_params:${paramCheck.reason}` };
      const sentAt = new Date();
      // R0 不变量：先在出站登记里落盘（含 params_hash），再把请示发出去——
      // 之后的 action_result 才能按「请求-回执绑定」被验签收纳。
      const registered = await outgoing.register({
        request_id: built.envelope.request_id,
        to: built.envelope.to,
        kind: "action",
        scope: built.envelope.action,
        params_hash: hashPayload(built.envelope.params),
        created_at: sentAt.toISOString(),
        expires_at: new Date(sentAt.getTime() + consentTtl("action")).toISOString(),
      });
      if (!registered) return { ok: false, reason: "request_not_registered" };
      await sendToConversation(activeGroupId, encodeEnvelope(built.envelope));
      await writeLedger(
        buildLedgerEntry({
          now: new Date(),
          kind: "request_sent",
          requestId: built.envelope.request_id,
          peer: built.envelope.to,
          scope: built.envelope.action,
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
      const sentAt = new Date();
      const registered = await outgoing.register({
        request_id: taskEnv.request_id,
        to: taskEnv.to,
        kind: "task",
        scope: "task.run",
        created_at: sentAt.toISOString(),
        expires_at: new Date(sentAt.getTime() + consentTtl("action")).toISOString(),
      });
      if (!registered) return { ok: false, reason: "request_not_registered" };
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

  let revocationReady = false;
  const expiryTimer = setInterval(() => {
    expireDue(actionDeps).catch((err) => console.error("Expiry error:", err.message));
    resendPendingReceipts(actionDeps).catch((err) => console.error("Receipt resend error:", err.message));
    writeLedgerCheckpoint().catch((err) => console.error("Checkpoint error:", err.message));
    loadHubRoomSettings(hubRoomSettingsPath)
      .then((next) => {
        hubRoomSettings = next;
        runtimePolicy.rules = mergeHubHouseRules(policy, next);
      })
      .catch(() => {});
    if (revocationReady) revocationReconciler.reconcile().catch(reportRevocationError);
  }, 30_000);
  expiryTimer.unref();

  const allowGroupMembers = process.env.XMTP_ALLOW_GROUP_MEMBERS === "1";
  // 本房其他席位的 XMTP 地址（连环护栏区分人/Agent 发言）。Hub 连不上时为空——
  // 全部发送者按人类处理，护栏不起作用，行为与旧版一致。
  const seatPeerAddresses = new Set<string>();
  let seatPeerNames: string[] = [];
  const loopGuardLimit = (() => {
    const n = Number.parseInt(process.env.XMTP_LOOP_GUARD_LIMIT || "", 10);
    return Number.isFinite(n) ? n : undefined;
  })();

  agent.on("text", async (ctx: any) => {
    if (cloudSeatPaused) return;
    const sender = ((await ctx.getSenderAddress()) || "").toLowerCase();
    if (sender && sender === selfAddress) return;
    const senderAllowed = await isSenderAuthorized(
      {
        sender,
        isGroup: typeof ctx.isGroup === "function" ? ctx.isGroup() : null,
        conversation: ctx.conversation,
      },
      {
        allowedSenders: config.allowedSenders,
        allowGroupMembers,
        groupMembers,
        revoked: revokedStore,
      }
    );
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
        peerNames: seatPeerNames,
        guardLimit: loopGuardLimit,
        complete,
        approvedDays: config.approvedDays,
        sensitiveKeywords: config.sensitiveKeywords,
        teamConfigMarkdown: hubRoomSettings?.teamConfigMarkdown,
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
        seatPeerNames = peers.map((p) => p.agent_display_name.trim()).filter(Boolean);
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
  // 上线后立刻补一轮回执重发——崩溃恢复补签的 uncertain 回执在这时真正送出。
  resendPendingReceipts(actionDeps).catch((err) => console.error("Receipt resend error:", err.message));
  revocationReady = true;
  if (revokedRetries.size() > 0) revocationReconciler.start();
  // 有启用的触发器才开始巡检；控制台启停/增删会经 onTriggersChanged 刷新。
  triggerEngine.refresh();
  const cloudSeatId = (process.env.MAPR_SEAT_ID || "").trim();
  const cloudHubOrigin = (config.hubBaseUrl || "").trim().replace(/\/+$/, "");
  let stopCloudSeat: (() => void) | null = null;
  if (cloudSeatId && cloudHubOrigin && currentHubToken) {
    const poller = startCloudSeatPolling({
      hubOrigin: cloudHubOrigin,
      seatId: cloudSeatId,
      agentToken: currentHubToken,
      renewToken: true,
      onToken: (nextToken) => {
        currentHubToken = nextToken;
      },
      onPaused: (paused) => {
        cloudSeatPaused = paused;
      },
      onRemoved: () => {
        console.warn("[member] cloud seat removed; exiting fail-closed");
        triggerEngine.stop();
        consoleServer.close();
        process.exit(0);
      },
    });
    stopCloudSeat = () => poller.stop();
  }
  const stopTimers = () => {
    triggerEngine.stop();
    stopCloudSeat?.();
  };
  process.on("SIGINT", stopTimers);
  process.on("SIGTERM", stopTimers);
}

if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  startMember().catch((err) => {
    console.error("Worker process error:", err.message);
    process.exit(1);
  });
}
