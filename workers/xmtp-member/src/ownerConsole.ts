import { validConnectRedirect } from "./connectSdk.ts";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  AccountStore,
  CRED_FILE_RE,
  removeCredentialFile,
  resolveCredentialPath,
} from "./accounts.ts";
import { activityEventId, ledgerEntryStatus, queryLocalActivity, verifyLedgerCheckpoint, type ActivityStatus } from "./activity.ts";
import type { Connector } from "./connectors/types.ts";
import { findConnector } from "./connectors/registry.ts";
import type { ConsentQueue, PendingConsent } from "./consentQueue.ts";
import { buildGrant, signGrant } from "./grant.ts";
import type { InboxEntry } from "./inbox.ts";
import { buildLedgerEntry, readLedger, verifyLedger, type LedgerAnchor, type LedgerEntry, type LedgerKind } from "./ledger.ts";
import { checkLocalRequest, OWNER_HEADER } from "./localGuard.ts";
import { CONNECT_AUTHORIZE_HTML, OWNER_CONSOLE_HTML } from "./ownerConsoleHtml.ts";
import type { OwnerNote } from "./ownerNote.ts";
import { allowOwnerNotesOrigin, handleOwnerNotes } from "./ownerNotesHttp.ts";
import type { Policy } from "./policy.ts";
import { scoreboard, type ScoreboardItem } from "./scoreboard.ts";
import { writeJsonSecure } from "./secureFile.ts";
import type { TaskRecord } from "./taskStore.ts";
import { TriggerStore, validateAndCheckTrigger, type TriggerState } from "./triggers.ts";

export interface OwnerConsoleDeps {
  selfAddress: string;
  privateKey?: string;
  role?: string;
  queue: ConsentQueue;
  connectors?: Connector[];
  /** WP7：账户登记（accounts.json）。缺省时账户/触发器端点一律 501。 */
  accounts?: AccountStore;
  /** WP7：触发器登记（triggers.json）。 */
  triggers?: TriggerStore;
  /** 凭据目录——POST /api/accounts 写凭据文件的落点；accounts 配置了就必须给。 */
  credDir?: string;
  /** 账本文件路径——GET /api/activity 的文件级完整性校验。 */
  ledgerFile?: string;
  /** Local helper seat ID, used to match this ledger's uploaded metadata. */
  activitySeatId?: string;
  /**
   * M5：本地签名账本锚点文件（.state/ledger-checkpoint.json）。
   * 配置后 /api/activity 把「已验签的最近一次链头」传给 verifyLedger——
   * 相对该锚点的截断/改写才会被主动检出；不给则只做链内一致性校验。
   */
  ledgerCheckpointFile?: string;
  /** 触发器配置校验时的本机裁决上下文（account 存在性 + decide()）。 */
  policy?: Policy;
  /** 触发器启停/增删后的引擎刷新回调（index.ts 接线）。 */
  onTriggersChanged?: () => void;
  readLedger: () => Promise<LedgerEntry[]>;
  readInbox: () => Promise<InboxEntry[]>;
  readOwnerNotes: () => Promise<OwnerNote[]>;
  appendLedger?: (entry: LedgerEntry) => Promise<void>;
  readScoreboard?: () => Promise<ScoreboardItem[]> | ScoreboardItem[];
  readTasks?: () => Promise<TaskRecord[]> | TaskRecord[];
  approve: (requestId: string) => Promise<{ ok: boolean; reason?: string }>;
  deny: (requestId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 重发已持久化的回执（awaiting_receipt）——只发 outbox，绝不重新执行。 */
  resend?: (requestId: string) => Promise<{ ok: boolean; reason?: string }>;
  sendRequest: (body: any) => Promise<{ ok: boolean; reason?: string; request_id?: string }>;
  /** 发起出站 action_request——实现方必须先登记出站请求再发送（R0 绑定不变量）。 */
  sendActionRequest?: (body: any) => Promise<{ ok: boolean; reason?: string; request_id?: string }>;
  sendTask?: (body: any) => Promise<{ ok: boolean; reason?: string; request_id?: string }>;
}

const MAX_BODY = 16 * 1024;

/**
 * /api/state 的列表视图脱敏：params 可能含邮件正文，GET 不需 owner 头——
 * 只给「键清单 + 截断预览」；完整参数走 /api/consents/{id}（强制 owner 头）。
 * 正文类字段（body/content/text…）与收件人/抄送/密送/主题只给长度或条数，
 * 连截断都不出——避免短正文、收件地址与主题词全漏给任何本机 GET。
 */
const SECRET_PARAM_KEYS = new Set([
  "body", "html", "content", "text", "message", "data", "attachments",
  "to", "cc", "bcc", "subject",
]);

function previewParam(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (depth >= 1) return `[${value.length} 项]`;
    const head = value.slice(0, 3).map((v) => previewParam(v, depth + 1));
    return `[${value.length} 项] ${head.join(", ")}${value.length > 3 ? " …" : ""}`;
  }
  return `[${typeof value}]`;
}

function previewParamFor(key: string, value: unknown): string {
  if (SECRET_PARAM_KEYS.has(key.toLowerCase())) {
    if (typeof value === "string") return `[${value.length} 字符]`;
    if (Array.isArray(value)) return `[${value.length} 项]`;
    return `[${typeof value}]`;
  }
  return previewParam(value);
}

export function redactConsent(item: PendingConsent): Omit<PendingConsent, "params" | "outbox"> & {
  params_meta?: { keys: string[]; preview: Record<string, string> };
} {
  const { params, outbox, ...rest } = item;
  if (!params || typeof params !== "object") return rest;
  const preview: Record<string, string> = {};
  for (const key of Object.keys(params)) preview[key] = previewParamFor(key, params[key]);
  return { ...rest, params_meta: { keys: Object.keys(params), preview } };
}

/**
 * L1：未认证的 /api/state 不吐原始披露载荷——主题、body_excerpt、附件名、
 * 忙碌时段明细都只在 owner 头的 /api/inbox 给。这里只留元数据与计数。
 */
export function redactInboxEntry(entry: InboxEntry): InboxEntry {
  const p: any = entry.payload ?? {};
  let payload: any;
  if (p.kind === "action_result") {
    payload = {
      kind: "action_result",
      status: typeof p.status === "string" ? p.status : undefined,
      has_receipt: typeof p.receipt === "string" && p.receipt.length > 0,
    };
  } else if (p.scope === "email.receipt") {
    payload = {
      scope: "email.receipt",
      sent_at: typeof p.sent_at === "string" ? p.sent_at : undefined,
      has_attachment: p.attachment_name != null,
    };
  } else {
    payload = {
      scope: typeof p.scope === "string" ? p.scope : "unknown",
      date_from: typeof p.date_from === "string" ? p.date_from : undefined,
      date_to: typeof p.date_to === "string" ? p.date_to : undefined,
      busy_count: Array.isArray(p.busy) ? p.busy.length : undefined,
    };
  }
  return { ...entry, payload };
}

/**
 * 账本 reason 可能被外部输入污染（invalid_params:unknown_key:<攻击者键名>）。
 * 未认证的 /api/state 与 /api/activity：攻击者键名整体剥掉、再按安全字符集
 * 过滤——宁可截掉也不回显任意键名。
 */
export function sanitizeReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  // JSON 键名可含空格/HTML——未知键名从 unknown_key: 起整条剥掉，不猜边界。
  const cleaned = reason.replace(/unknown_key:[\s\S]*$/g, "unknown_key");
  return cleaned.replace(/[^A-Za-z0-9_.:=,/?\- ]/g, "").slice(0, 160);
}

function sanitizeLedgerEntry(entry: LedgerEntry): LedgerEntry {
  return { ...entry, reason: sanitizeReason(entry.reason) };
}

/**
 * M5：读本地签名锚点——签名必须属于本机 selfAddress 才可信；
 * 文件缺失/损坏/伪造一律回 null，/api/activity 降级为无锚校验，不拿可疑锚点当真。
 */
export async function readVerifiedLedgerAnchor(
  file: string,
  expectedSigner: string
): Promise<LedgerAnchor | null> {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(await readFile(file, "utf8"));
    const check = await verifyLedgerCheckpoint(raw, expectedSigner);
    if (!check.ok) return null;
    return { head_seq: raw.head_seq, head_hash: raw.head_hash };
  } catch {
    return null;
  }
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function createOwnerConsoleServer(deps: OwnerConsoleDeps): http.Server {
  return http.createServer(async (req, res) => {
    const host = req.headers.host || "";
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = (req.method || "GET").toUpperCase();

    if (url.pathname === "/owner-notes") {
      const allowed = allowOwnerNotesOrigin(origin);
      if (allowed) {
        res.setHeader("Access-Control-Allow-Origin", allowed);
        res.setHeader("Vary", "Origin");
      }
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const result = await handleOwnerNotes({ host, notes: await deps.readOwnerNotes() });
      sendJson(res, result.status, result.body);
      return;
    }

    const ownerHeader = req.headers[OWNER_HEADER];
    if (
      !checkLocalRequest({
        method,
        host,
        origin,
        ownerHeader: Array.isArray(ownerHeader) ? ownerHeader[0] : ownerHeader,
      })
    ) {
      sendJson(res, 403, { ok: false, reason: "forbidden" });
      return;
    }

    try {
      if (method === "GET" && url.pathname === "/") {
        const script = OWNER_CONSOLE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
        const scriptHash = createHash("sha256").update(script).digest("base64");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'self'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
        });
        res.end(OWNER_CONSOLE_HTML);
        return;
      }
      if (method === "GET" && url.pathname === "/connect/authorize") {
        const script = CONNECT_AUTHORIZE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
        const scriptHash = createHash("sha256").update(script).digest("base64");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'self'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
        });
        res.end(CONNECT_AUTHORIZE_HTML);
        return;
      }
      const owner = Array.isArray(ownerHeader) ? ownerHeader[0] : ownerHeader;
      if (method === "GET" && url.pathname === "/api/state") {
        const ledger = await deps.readLedger();
        sendJson(res, 200, {
          self: deps.selfAddress,
          role: deps.role || "member",
          consents: deps.queue.list().map(redactConsent),
          // L1：未认证 GET 只给脱敏元数据；完整载荷走 owner 头的 /api/inbox。
          inbox: (await deps.readInbox()).map(redactInboxEntry),
          ledger: ledger.map(sanitizeLedgerEntry),
          scoreboard: deps.readScoreboard ? await deps.readScoreboard() : scoreboard(ledger),
          tasks: deps.readTasks ? await deps.readTasks() : [],
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/inbox") {
        // 完整收件箱（披露载荷/回执明细）只对 owner 头放行。
        if (owner !== "1") {
          sendJson(res, 403, { ok: false, reason: "forbidden" });
          return;
        }
        sendJson(res, 200, { ok: true, inbox: await deps.readInbox() });
        return;
      }
      const consentDetail = url.pathname.match(/^\/api\/consents\/([^/]+)$/);
      if (method === "GET" && consentDetail) {
        // 完整动作参数（收件人/主题/正文）只对 owner 头放行——GET 默认不强制该头，这里单独校验。
        if (owner !== "1") {
          sendJson(res, 403, { ok: false, reason: "forbidden" });
          return;
        }
        const item = deps.queue.get(decodeURIComponent(consentDetail[1]));
        if (!item) {
          sendJson(res, 404, { ok: false, reason: "not_found" });
          return;
        }
        sendJson(res, 200, { ok: true, consent: item });
        return;
      }
      const consentMatch = url.pathname.match(/^\/api\/consents\/([^/]+)\/(approve|deny|resend)$/);
      if (method === "POST" && consentMatch) {
        const id = decodeURIComponent(consentMatch[1]);
        const action = consentMatch[2];
        if (action === "resend") {
          if (!deps.resend) {
            sendJson(res, 501, { ok: false, reason: "not_implemented" });
            return;
          }
          const result = await deps.resend(id);
          sendJson(res, result.ok ? 200 : 409, result);
          return;
        }
        const result = action === "approve" ? await deps.approve(id) : await deps.deny(id);
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }
      if (method === "POST" && url.pathname === "/api/connect/approve") {
        if (deps.role === "observer") {
          sendJson(res, 403, { ok: false, reason: "observer_readonly" });
          return;
        }
        const body = await readJson(req);
        if (!validConnectRedirect(body.redirect_uri)) {
          sendJson(res, 400, { ok: false, reason: "invalid_redirect" });
          return;
        }
        const appId = String(body.app_id || "unknown-app");
        const scope = String(body.scope || "");
        const connector = findConnector(deps.connectors || [], scope);
        if (!connector || !deps.privateKey) {
          sendJson(res, 400, { ok: false, reason: "no_connector" });
          return;
        }
        const payload = await connector.fetch(scope, body.constraints);
        const grant = buildGrant({
          owner: deps.selfAddress,
          audience: appId,
          requestId: randomUUID(),
          scope,
          constraints: body.constraints || { date_from: "", date_to: "" },
          payload,
          now: new Date(),
        });
        const signature = await signGrant(grant, deps.privateKey);
        if (deps.appendLedger) {
          await deps.appendLedger(
            buildLedgerEntry({
              now: new Date(),
              kind: "consent_approved",
              peer: appId,
              scope,
              payloadHash: grant.payload_hash,
            })
          );
        }
        const redirect_uri = body.redirect_uri;
        const redirect_url = redirect_uri
          ? `${redirect_uri}#grant=${encodeURIComponent(JSON.stringify(grant))}&signature=${encodeURIComponent(signature)}&data=${encodeURIComponent(JSON.stringify(payload))}`
          : undefined;
        sendJson(res, 200, { ok: true, grant, signature, payload, redirect_url });
        return;
      }
      if (method === "POST" && url.pathname === "/api/connect/deny") {
        const body = await readJson(req);
        if (!validConnectRedirect(body.redirect_uri)) {
          sendJson(res, 400, { ok: false, reason: "invalid_redirect" });
          return;
        }
        const appId = String(body.app_id || "unknown-app");
        const scope = String(body.scope || "");
        if (deps.appendLedger) {
          await deps.appendLedger(
            buildLedgerEntry({
              now: new Date(),
              kind: "consent_denied",
              peer: appId,
              scope,
              reason: "user_denied",
            })
          );
        }
        const redirect_uri = body.redirect_uri;
        const redirect_url = redirect_uri ? `${redirect_uri}#error=user_denied` : undefined;
        sendJson(res, 200, { ok: false, reason: "user_denied", redirect_url });
        return;
      }
      if (method === "POST" && url.pathname === "/api/requests") {
        if (deps.role === "observer") {
          sendJson(res, 403, { ok: false, reason: "observer_readonly" });
          return;
        }
        const result = await deps.sendRequest(await readJson(req));
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      if (method === "POST" && url.pathname === "/api/action-requests") {
        if (deps.role === "observer") {
          sendJson(res, 403, { ok: false, reason: "observer_readonly" });
          return;
        }
        if (!deps.sendActionRequest) {
          sendJson(res, 501, { ok: false, reason: "not_implemented" });
          return;
        }
        const result = await deps.sendActionRequest(await readJson(req));
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      if (method === "POST" && url.pathname === "/api/tasks") {
        if (deps.role === "observer") {
          sendJson(res, 403, { ok: false, reason: "observer_readonly" });
          return;
        }
        if (!deps.sendTask) {
          sendJson(res, 501, { ok: false, reason: "not_implemented" });
          return;
        }
        const result = await deps.sendTask(await readJson(req));
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      // ── WP7：账户管理（全部 owner 头保护；GET 也强制，元数据不白送）────────
      if (url.pathname === "/api/accounts" || url.pathname.startsWith("/api/accounts/")) {
        if (!deps.accounts || !deps.credDir) {
          sendJson(res, 501, { ok: false, reason: "not_implemented" });
          return;
        }
        if (owner !== "1") {
          sendJson(res, 403, { ok: false, reason: "forbidden" });
          return;
        }
        if (method === "GET" && url.pathname === "/api/accounts") {
          // 只回元数据四字段——accounts.json 本身就不含 secret，响应同样零秘密。
          sendJson(res, 200, { ok: true, accounts: deps.accounts.list() });
          return;
        }
        if (deps.role === "observer") {
          sendJson(res, 403, { ok: false, reason: "observer_readonly" });
          return;
        }
        if (method === "POST" && url.pathname === "/api/accounts") {
          const body = await readJson(req);
          const credPath =
            typeof body?.cred_path === "string" && body.cred_path
              ? body.cred_path
              : `${typeof body?.id === "string" ? body.id : "account"}.json`;
          const entry = {
            id: body?.id,
            service: body?.service,
            label: body?.label,
            cred_path: credPath,
          };
          if (!body?.credentials || typeof body.credentials !== "object" || Array.isArray(body.credentials)) {
            sendJson(res, 400, { ok: false, reason: "credentials_required" });
            return;
          }
          if (!CRED_FILE_RE.test(credPath)) {
            sendJson(res, 400, { ok: false, reason: "invalid_cred_path" });
            return;
          }
          const added = await deps.accounts.add(entry as any);
          if (added !== "added") {
            sendJson(res, added === "duplicate" ? 409 : 400, { ok: false, reason: added });
            return;
          }
          // 先登记再落凭据：写失败就回滚账户行，不留「指向不存在凭据」的悬挂记录。
          try {
            await writeJsonSecure(
              resolveCredentialPath(deps.credDir, credPath),
              body.credentials
            );
          } catch (err) {
            await deps.accounts.remove(entry.id).catch(() => {});
            sendJson(res, 500, { ok: false, reason: "cred_write_failed" });
            return;
          }
          sendJson(res, 200, { ok: true, account: deps.accounts.get(entry.id) });
          return;
        }
        const delMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
        if (method === "DELETE" && delMatch) {
          const id = decodeURIComponent(delMatch[1]);
          const existing = deps.accounts.get(id);
          if (!existing) {
            sendJson(res, 404, { ok: false, reason: "not_found" });
            return;
          }
          await deps.accounts.remove(id);
          // L7：cred_path 可能被多个账户行共享——还有人引用就保留凭据文件。
          if (!deps.accounts.credPathInUse(existing.cred_path)) {
            await removeCredentialFile(deps.credDir, existing.cred_path);
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 404, { ok: false, reason: "not_found" });
        return;
      }
      // ── WP7：触发器管理 ────────────────────────────────────────────────
      if (url.pathname === "/api/triggers" || url.pathname.startsWith("/api/triggers/")) {
        if (!deps.triggers) {
          sendJson(res, 501, { ok: false, reason: "not_implemented" });
          return;
        }
        if (owner !== "1") {
          sendJson(res, 403, { ok: false, reason: "forbidden" });
          return;
        }
        if (method === "GET" && url.pathname === "/api/triggers") {
          sendJson(res, 200, {
            ok: true,
            triggers: deps.triggers.list().map((t: TriggerState) => ({
              ...t,
              seen_ids: undefined,
              seen_count: t.seen_ids.length,
            })),
          });
          return;
        }
        if (deps.role === "observer") {
          sendJson(res, 403, { ok: false, reason: "observer_readonly" });
          return;
        }
        if (method === "POST" && url.pathname === "/api/triggers") {
          const body = await readJson(req);
          const check = validateAndCheckTrigger(body, {
            accounts: deps.accounts,
            policy: deps.policy,
            selfAddress: deps.selfAddress,
          });
          if (!check.ok) {
            sendJson(res, 400, { ok: false, reason: check.reason });
            return;
          }
          const added = await deps.triggers.add(check.config);
          if (added !== "added") {
            sendJson(res, 409, { ok: false, reason: added });
            return;
          }
          deps.onTriggersChanged?.();
          sendJson(res, 200, { ok: true, trigger: deps.triggers.get(check.config.id) });
          return;
        }
        const toggleMatch = url.pathname.match(/^\/api\/triggers\/([^/]+)\/toggle$/);
        if (method === "POST" && toggleMatch) {
          const id = decodeURIComponent(toggleMatch[1]);
          const existing = deps.triggers.get(id);
          if (!existing) {
            sendJson(res, 404, { ok: false, reason: "not_found" });
            return;
          }
          const body = await readJson(req).catch(() => ({}));
          const next = typeof body?.enabled === "boolean" ? body.enabled : !existing.enabled;
          await deps.triggers.setEnabled(id, next);
          deps.onTriggersChanged?.();
          sendJson(res, 200, { ok: true, enabled: next });
          return;
        }
        sendJson(res, 404, { ok: false, reason: "not_found" });
        return;
      }
      // ── WP7：本机活动流（localGuard 已罩回环；查询账本并给出链完整性）──────
      if (method === "GET" && url.pathname === "/api/activity") {
        if (!deps.ledgerFile) {
          sendJson(res, 501, { ok: false, reason: "not_implemented" });
          return;
        }
        const rawLimit = url.searchParams.get("limit");
        let limit: number | undefined;
        if (rawLimit !== null) {
          limit = Number.parseInt(rawLimit, 10);
          if (!Number.isInteger(limit) || limit < 0 || limit > 5000) {
            sendJson(res, 400, { ok: false, reason: "invalid_limit" });
            return;
          }
        }
        const splitParam = (name: string): string[] | undefined => {
          const v = url.searchParams.get(name);
          if (v === null) return undefined;
          return v.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 32);
        };
        const since = url.searchParams.get("since") ?? undefined;
        const until = url.searchParams.get("until") ?? undefined;
        for (const [name, v] of [["since", since], ["until", until]] as const) {
          if (v !== undefined && !Number.isFinite(Date.parse(v))) {
            sendJson(res, 400, { ok: false, reason: `invalid_${name}` });
            return;
          }
        }
        const entries = await readLedger(deps.ledgerFile);
        // M5：本地签名锚点——验签通过才参与校验；相对锚点的截断/改写主动检出。
        const anchor = deps.ledgerCheckpointFile
          ? await readVerifiedLedgerAnchor(deps.ledgerCheckpointFile, deps.selfAddress)
          : null;
        const verification = await verifyLedger(
          deps.ledgerFile,
          anchor ? { anchoredCheckpoint: anchor } : undefined
        );
        const result = queryLocalActivity(entries, {
          actor: url.searchParams.get("actor") ?? undefined,
          kind: splitParam("kind") as LedgerKind[] | undefined,
          status: splitParam("status") as ActivityStatus[] | undefined,
          since,
          until,
          limit,
        }, { verification });
        sendJson(res, 200, {
          ok: true,
          total: result.total,
          // L1：reason 可能带攻击者控制的键名——未认证响应一律按安全字符集脱敏。
          entries: result.entries.map((entry) => ({
            ...sanitizeLedgerEntry(entry),
            activity_status: ledgerEntryStatus(entry),
            activity_event_id: deps.activitySeatId && typeof entry.seq === "number"
              && Number.isInteger(entry.seq) && entry.seq > 0 && entry.entry_hash
              ? activityEventId(deps.activitySeatId, entry.seq, entry.entry_hash)
              : undefined,
          })),
          integrity: result.integrity,
        });
        return;
      }
      sendJson(res, 404, { ok: false, reason: "not_found" });
    } catch (err: any) {
      sendJson(res, 500, { ok: false, reason: err.message || "server_error" });
    }
  });
}
