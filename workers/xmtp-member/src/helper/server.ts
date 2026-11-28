import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isLoopbackHostname } from "../localGuard.ts";
import { HubError, type HubClient } from "./hubClient.ts";
import type { SeatStore, SeatSupervisor } from "./seats.ts";
import type {
  CreateSeatRequest,
  HelperConfig,
  LocalAgent,
  SeatRecord,
  SeatStatus,
  SeatView,
} from "./types.ts";

export const HELPER_PORT = 8790;
export const HELPER_BIND = "127.0.0.1";

/**
 * 本机接口：
 *
 * | 方法与路径                  | 类别          | 说明 |
 * |-----------------------------|---------------|------|
 * | GET  /                      | page          | 本机页面（列出 Agent、选房间、一键加入） |
 * | GET  /api/hello             | public-read   | {app:"mapr-helper", version, paired, hub_origin, owner_display_name} |
 * | GET  /api/agents            | owner-read    | LocalAgent[] |
 * | GET  /api/rooms             | owner-read    | 代理 Hub 的 listRooms |
 * | GET  /api/seats             | owner-read    | SeatView[] |
 * | POST /api/pair              | owner-write   | {code} → 与 Hub 配对，写 helper.json |
 * | POST /api/agents/rescan     | owner-write   | 重新探测 |
 * | POST /api/agents/manual     | owner-write   | 添加云端 Agent（密钥写入 ~/.mapr/agents/<key>.secret） |
 * | POST /api/seats             | ticket-write 或 owner-write | 加入房间，见 handleCreateSeat |
 * | DELETE /api/seats/:id       | owner-write   | 退出房间 |
 */
export type RequestClass = "page" | "public-read" | "owner-read" | "owner-write" | "ticket-write";

export interface GuardInput {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  ownerHeader: string | undefined;
  hubOrigin: string | null;
  requestClass: RequestClass;
}

export type GuardResult = { ok: true; corsOrigin: string | null } | { ok: false; status: 403 };

/** Host 头剥离端口与 IPv6 方括号，拿到主机名。 */
function hostHostname(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  return h.split(":")[0];
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackHostname(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

function isHubOrigin(origin: string, hubOrigin: string | null): boolean {
  if (!hubOrigin) return false;
  try {
    return new URL(origin).origin === new URL(hubOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * 每个请求先过这一关：
 * 1. Host 必须是 127.0.0.1 / localhost / [::1]（防止域名重绑定），否则 403。
 * 2. page、public-read：任何回环 Origin 或 hubOrigin；没有 Origin 也放行。
 * 3. owner-read：Origin 必须是回环地址或 hubOrigin；没有 Origin 放行（命令行工具）。
 * 4. owner-write：Origin 必须是回环地址（或没有 Origin），并且 X-MAPR-Owner: 1。
 *    网站（hubOrigin）不能直接调用 owner-write。
 * 5. ticket-write：Origin 是回环地址或 hubOrigin；请求体必须带 Hub 签发的一次性加入票据，
 *    票据由 Hub 校验（本机不信任网站传来的 room_id）。
 * corsOrigin 只在 Origin 被放行时回显，并对 OPTIONS 预检额外返回
 * Access-Control-Allow-Private-Network: true。
 */
export function guardHelperRequest(input: GuardInput): GuardResult {
  // 规则 1：Host 不是回环一律拒绝。这一步挡住「把受害者的域名解析到 127.0.0.1」的
  // DNS 重绑定攻击——恶意网站即使把请求发到了本机，Host 头也不是回环地址。
  const host = input.host ?? "";
  if (!host || !isLoopbackHostname(hostHostname(host))) {
    return { ok: false, status: 403 };
  }
  const origin = input.origin ?? null;
  const loopbackOrigin = origin !== null && isLoopbackOrigin(origin);
  const hubOk = origin !== null && isHubOrigin(origin, input.hubOrigin);

  switch (input.requestClass) {
    case "page":
    case "public-read":
    case "owner-read":
    case "ticket-write":
      // 规则 2/3/5：回环 Origin、hubOrigin、或没有 Origin（curl 等非浏览器调用方）。
      if (origin === null || loopbackOrigin || hubOk) {
        return { ok: true, corsOrigin: origin };
      }
      return { ok: false, status: 403 };
    case "owner-write":
      // 规则 4：写操作只允许回环页面或本机命令行，且必须显式带 X-MAPR-Owner: 1。
      // 网站来源（hubOrigin）在这里永远拿不到放行——它能做的写操作只有 ticket-write。
      if (origin !== null && !loopbackOrigin) return { ok: false, status: 403 };
      if (input.ownerHeader !== "1") return { ok: false, status: 403 };
      return { ok: true, corsOrigin: origin };
  }
}

/** 业务层错误：带 HTTP 状态码，reason 由实现方保证不含秘密。 */
export class HelperHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function httpError(status: number, reason: string): never {
  throw new HelperHttpError(status, reason);
}

export interface AgentTestResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface HelperServerDeps {
  version: string;
  config: () => HelperConfig | null;
  pair: (code: string) => Promise<HelperConfig>;
  hub: () => HubClient | null;
  agents: () => Promise<LocalAgent[]>;
  rescan: () => Promise<LocalAgent[]>;
  store: SeatStore;
  supervisor: SeatSupervisor;
  /**
   * 添加手动云端/本地接口 Agent：校验入参、把元数据写进 helper.json、把密钥写进
   * ~/.mapr/agents/<key>.secret（0600），返回登记后的 LocalAgent。
   * 由 up.ts 提供（它持有配置文件路径）；未提供时端点返回 501。
   */
  addManualAgent?: (input: unknown) => Promise<LocalAgent>;
  /**
   * 删除手动添加的 Agent：存在活跃席位时返回 409，否则移除 helper.json 元数据与 .secret 文件。
   */
  removeManualAgent?: (key: string) => Promise<void>;
  /**
   * 探测单个 Agent 的连通性或本机登录就绪状态，绝不回显密钥。
   */
  testAgent?: (key: string) => Promise<AgentTestResult>;
  /**
   * 彻底移除一个席位：停进程、删 seat.json 与沙箱目录。
   * 由 up.ts 提供（它知道 rootDir）；缺省时退化为 stop + store.remove。
   */
  removeSeat?: (seatId: string) => Promise<void>;
}

function viewOfRecord(rec: SeatRecord, status: SeatStatus, lastError: string | null): SeatView {
  return {
    seatId: rec.seatId,
    agentKey: rec.agentKey,
    roomId: rec.roomId,
    roomName: rec.roomName,
    xmtpAddress: rec.xmtpAddress,
    consolePort: rec.consolePort,
    status,
    lastError,
    pausedAt: rec.pausedAt ?? null,
  };
}

async function seatViewOf(deps: HelperServerDeps, seatId: string): Promise<SeatView> {
  const found = (await deps.supervisor.views()).find((v) => v.seatId === seatId);
  if (found) return found;
  const rec = await deps.store.get(seatId);
  if (!rec) throw new HelperHttpError(404, "seat_not_found");
  return viewOfRecord(rec, "stopped", null);
}

/**
 * POST /api/seats 的完整流程（重复运行也不会出问题：同一 agentKey + roomId 已有席位时直接返回它）：
 * 1. 生成新的 XMTP 私钥与本地库密钥，推出地址。
 * 2. 调 hub.createSeat（ticket 或 local 两种来源），拿到 SeatGrant。
 * 3. 分配端口，写 seat.json，启动成员进程。
 * 4. 返回 SeatView。之后由房主的浏览器（或同一房间里本机的其他席位）把新地址加入加密群。
 * 第 2 步失败时不写任何文件；第 3 步失败时保留 seat.json 并把状态记为 crashed，如实返回错误。
 *
 * 幂等细节：via=local 时 roomId 已知，先查本地，有席位直接返回（顺手清掉 Hub 侧已移除的）。
 * via=ticket 时 roomId 只有 Hub 知道，必须先核销票据；Hub 按 (helper, agent_key, room)
 * 上行更新成我们刚发的新地址，所以本地旧席位记录要用新密钥覆盖并重启成员进程，
 * 否则运行中的进程还拿着 Hub 已不认识的旧地址。
 */
export async function handleCreateSeat(deps: HelperServerDeps, body: unknown): Promise<unknown> {
  const b = (body ?? {}) as Record<string, unknown>;
  const via = b.via;
  if (via !== "ticket" && via !== "local") httpError(400, "invalid_via");
  const agentKey = typeof b.agent_key === "string" ? b.agent_key.trim() : "";
  if (!agentKey) httpError(400, "agent_key_required");
  const hub = deps.hub();
  if (!hub) httpError(409, "not_paired");
  const agent = (await deps.agents()).find((a) => a.key === agentKey);
  if (!agent) httpError(404, "agent_not_found");
  const roomId = via === "local" && typeof b.room_id === "string" ? b.room_id.trim() : "";

  if (via === "local") {
    if (!roomId) httpError(400, "room_id_required");
    const existing = (await deps.store.list()).find((s) => s.agentKey === agentKey && s.roomId === roomId);
    if (existing) {
      let gone = false;
      try {
        const st = await hub.getSeat(existing.seatId);
        if (st.group_status === "removed") {
          gone = true;
        } else if (!existing.xmtpGroupId && st.xmtp_group_id) {
          // 房主晚于入座才建群：把新群号写回记录，下次重启成员进程时生效。
          existing.xmtpGroupId = st.xmtp_group_id;
          await deps.store.save(existing);
        }
      } catch (err) {
        gone = err instanceof HubError && err.status === 404;
      }
      if (gone) {
        await deps.supervisor.stop(existing.seatId);
        await deps.store.remove(existing.seatId);
      } else {
        await deps.supervisor.start(existing.seatId);
        return await seatViewOf(deps, existing.seatId);
      }
    }
  }

  const ticket = via === "ticket" && typeof b.ticket === "string" ? b.ticket.trim() : "";
  if (via === "ticket" && !ticket) httpError(400, "ticket_required");

  const walletKey = generatePrivateKey();
  const xmtpAddress = privateKeyToAccount(walletKey).address.toLowerCase();
  const xmtpDbEncryptionKey = "0x" + randomBytes(32).toString("hex");

  const reqBody: CreateSeatRequest =
    via === "ticket"
      ? {
          via: "ticket",
          ticket,
          agent_key: agentKey,
          kind: agent.kind,
          display_name: agent.displayName,
          xmtp_address: xmtpAddress,
        }
      : {
          via: "local",
          room_id: roomId,
          agent_key: agentKey,
          kind: agent.kind,
          display_name: agent.displayName,
          xmtp_address: xmtpAddress,
        };
  // Hub 失败直接向上抛：此时本地还没有任何落盘。
  const grant = await hub.createSeat(reqBody);

  // 同一 (agentKey, roomId) 下 seatId 不同的记录是陈旧副本（换 helper 重配对留下的），
  // Hub 行已被这次调用覆盖，本地副本留着只会误导，清掉。
  for (const s of await deps.store.list()) {
    if (s.seatId !== grant.seat_id && s.agentKey === agentKey && s.roomId === grant.room_id) {
      await deps.supervisor.stop(s.seatId);
      await deps.store.remove(s.seatId);
    }
  }
  const prev = await deps.store.get(grant.seat_id);
  // seatId 相同 = Hub 同一行的重新加入：Hub 已把地址换成新的，旧进程拿旧地址会失联，
  // 必须停掉后用新密钥重启。
  if (prev) await deps.supervisor.stop(grant.seat_id);

  const record: SeatRecord = {
    seatId: grant.seat_id,
    agentKey,
    roomId: grant.room_id,
    roomName: grant.room_name,
    agentUsername: grant.agent_username,
    xmtpWalletKey: walletKey,
    xmtpDbEncryptionKey,
    xmtpAddress,
    xmtpGroupId: grant.xmtp_group_id,
    allowedSenders: grant.allowed_senders ?? [],
    ...(via === "ticket" && grant.allowed_senders?.length === 1
      ? { ownerXmtpAddress: grant.allowed_senders[0] } : {}),
    ...(prev?.responseMode ? { responseMode: prev.responseMode } : {}),
    agentToken: grant.agent_token,
    consolePort: prev?.consolePort ?? (await deps.store.nextFreePort()),
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  await deps.store.save(record);

  try {
    await deps.supervisor.start(grant.seat_id);
  } catch (err) {
    // 进程起不来不能假报成功：seat.json 保留（下次 start 可重试），状态如实记 crashed。
    return viewOfRecord(record, "crashed", `member process failed to start: ${messageOf(err)}`);
  }
  return await seatViewOf(deps, grant.seat_id);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MAX_BODY = 16 * 1024;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HelperHttpError(413, "body_too_large"));
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
        reject(new HelperHttpError(400, "bad_json"));
      }
    });
    req.on("error", reject);
  });
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HelperHttpError(400, "bad_uri_segment");
  }
}

/** 路由 → 请求类别；"seat-write" 要看过 body.via 才能定 ticket-write 还是 owner-write。 */
function classify(method: string, pathname: string): RequestClass | "seat-write" | null {
  if (method === "GET" && pathname === "/") return "page";
  if (method === "GET" && pathname === "/api/hello") return "public-read";
  if (method === "GET" && (pathname === "/api/agents" || pathname === "/api/rooms" || pathname === "/api/seats")) {
    return "owner-read";
  }
  if (
    method === "POST" &&
    (pathname === "/api/pair" || pathname === "/api/agents/rescan" || pathname === "/api/agents/manual")
  ) {
    return "owner-write";
  }
  if (method === "POST" && /^\/api\/agents\/[^/]+\/test$/.test(pathname)) return "owner-write";
  if (method === "DELETE" && /^\/api\/agents\/manual\/[^/]+$/.test(pathname)) return "owner-write";
  if (method === "POST" && pathname === "/api/seats") return "seat-write";
  if (method === "DELETE" && /^\/api\/seats\/[^/]+$/.test(pathname)) return "owner-write";
  // WP5：本机暂停/恢复席位进程（owner-write：只允许回环页面或命令行 + X-MAPR-Owner）。
  if (method === "POST" && /^\/api\/seats\/[^/]+\/(pause|resume)$/.test(pathname)) return "owner-write";
  return null;
}

export const HELPER_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Multi-Agent 本机助手</title>
<style>
:root {
  --bg-canvas: #f5f5f7;
  --bg-card: #ffffff;
  --bg-subtle: #fbfbfd;
  --text-primary: #1d1d1f;
  --text-secondary: #6e6e73;
  --text-muted: #86868b;
  --accent: #0071e3;
  --accent-hover: #0077ed;
  --accent-soft: rgba(0, 113, 227, 0.09);
  --border: rgba(0, 0, 0, 0.08);
  --border-strong: rgba(0, 0, 0, 0.14);
  --shadow: 0 2px 12px rgba(0, 0, 0, 0.04);
  --ok-bg: #eaf8ee;
  --ok-text: #166534;
  --ok-border: rgba(22, 101, 52, 0.18);
  --warn-bg: #fff8e6;
  --warn-text: #854d0e;
  --err-bg: #fef2f2;
  --err-text: #b91c1c;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(255, 255, 255, 0.84);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 1px solid var(--border);
}
.topbar-inner {
  max-width: 980px;
  margin: 0 auto;
  padding: 14px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--accent);
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.brand-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}
.brand-ver {
  font-size: 12px;
  color: var(--text-muted);
  margin-left: 4px;
}
.status-cluster {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.pill-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--border);
  background: #ffffff;
  color: var(--text-primary);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.dot-ok { background: #1d9a4c; }
.dot-warn { background: #d97706; }
.dot-err { background: #dc2626; }
.dot-muted { background: #9ca3af; }
.container {
  max-width: 980px;
  margin: 24px auto 48px;
  padding: 0 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 22px 24px;
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.card-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}
.banner-ok {
  background: var(--ok-bg);
  border: 1px solid var(--ok-border);
  border-radius: 14px;
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.banner-ok-text {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ok-text);
  font-weight: 500;
}
.banner-notice {
  border-radius: 14px;
  padding: 13px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13.5px;
  font-weight: 500;
}
.banner-notice-info {
  background: #eef5ff;
  border: 1px solid rgba(0, 102, 204, 0.2);
  color: #0066cc;
}
.banner-notice-err {
  background: var(--err-bg);
  border: 1px solid rgba(185, 28, 28, 0.24);
  color: var(--err-text);
}
.subtle-link {
  font-size: 12.5px;
  color: var(--accent);
  text-decoration: none;
  margin-top: 4px;
  display: inline-block;
}
.subtle-link:hover {
  text-decoration: underline;
}
.btn {
  appearance: none;
  border: 1px solid var(--border-strong);
  background: #ffffff;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 7px 14px;
  border-radius: 980px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  background: var(--bg-subtle);
  border-color: rgba(0, 0, 0, 0.24);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.btn-danger {
  color: var(--err-text);
  border-color: rgba(185, 28, 28, 0.22);
}
.btn-danger:hover:not(:disabled) {
  background: var(--err-bg);
  border-color: rgba(185, 28, 28, 0.36);
}
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.badge-tier {
  background: #f2f2f7;
  color: var(--text-secondary);
}
.badge-tier-local {
  background: #eaf7ee;
  color: #1d7a3c;
}
.badge-tier-cloud {
  background: #eef5ff;
  color: #0066cc;
}
.badge-tier-custom {
  background: #fff6e5;
  color: #a35c00;
}
.badge-ok {
  background: var(--ok-bg);
  color: var(--ok-text);
}
.badge-warn {
  background: var(--warn-bg);
  color: var(--warn-text);
}
.badge-err {
  background: var(--err-bg);
  color: var(--err-text);
}
.badge-info {
  background: var(--accent-soft);
  color: var(--accent);
}
input, select {
  font-family: inherit;
  font-size: 13px;
  color: var(--text-primary);
  background: #ffffff;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 8px 11px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
input:focus, select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.15);
}
.agent-item {
  border-top: 1px solid var(--border);
  padding: 14px 0;
}
.agent-item:first-child {
  border-top: none;
  padding-top: 4px;
}
.agent-item:last-child {
  padding-bottom: 2px;
}
.agent-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.agent-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.agent-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.agent-ver {
  font-size: 12px;
  color: var(--text-secondary);
}
.agent-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.probe-result {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  color: var(--text-secondary);
}
.probe-ok {
  background: var(--ok-bg);
  border-color: var(--ok-border);
  color: var(--ok-text);
}
.probe-err {
  background: var(--err-bg);
  border-color: rgba(185, 28, 28, 0.2);
  color: var(--err-text);
}
.preset-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
}
.preset-pill {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 13px;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.preset-pill:hover {
  border-color: var(--border-strong);
  background: #ffffff;
}
.preset-pill.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}
.form-footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.snippet-box {
  margin: 12px 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-subtle);
  padding: 10px 14px;
}
.snippet-box summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  user-select: none;
}
.snippet-pre {
  margin: 10px 0 4px;
  padding: 12px;
  border-radius: 8px;
  background: #f5f5f7;
  border: 1px solid var(--border);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  overflow-x: auto;
  color: var(--text-primary);
}
.seat-row {
  border-top: 1px solid var(--border);
  padding: 13px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.seat-row:first-child {
  border-top: none;
  padding-top: 4px;
}
.seat-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.seat-primary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-weight: 500;
}
.seat-addr {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--text-muted);
}
.seat-err {
  font-size: 12px;
  color: var(--err-text);
  margin-top: 3px;
}
.empty-state {
  padding: 18px 0 6px;
  color: var(--text-secondary);
  font-size: 13.5px;
}
.inline-msg {
  font-size: 13px;
  color: var(--text-secondary);
}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <span class="brand-icon" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="12" rx="2"></rect>
          <line x1="8" y1="20" x2="16" y2="20"></line>
          <line x1="12" y1="16" x2="12" y2="20"></line>
        </svg>
      </span>
      <span class="brand-title">Multi-Agent 本机助手</span>
      <span class="brand-ver" id="version"></span>
    </div>
    <div class="status-cluster">
      <span class="pill-status" id="status-pill">
        <span class="dot dot-muted" id="status-dot"></span>
        <span id="status-text">正在连接本机服务…</span>
      </span>
      <a class="btn" id="hub-link" href="#" target="_blank" rel="noopener noreferrer" style="display:none">打开线上控制台</a>
    </div>
  </div>
</header>

<main class="container">
  <div id="notice-banner" class="banner-notice banner-notice-info" role="status" style="display:none">
    <span id="notice-text"></span>
  </div>

  <div id="handoff-banner" class="banner-ok" style="display:none">
    <div class="banner-ok-text">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <span id="handoff-text">已将席位加入房间</span>
    </div>
    <a id="handoff-link" class="btn btn-primary" href="#">返回线上房间继续协作</a>
  </div>

  <section id="pair-section" class="card" style="display:none">
    <div class="card-head">
      <div>
        <h2 class="card-title">配对这台电脑</h2>
        <p class="card-sub">从线上「接入 Agent」页面复制一次性配对码粘贴到下方。配对码 10 分钟内单次有效。</p>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <input id="pair-code" size="38" placeholder="粘贴配对码（如 mpc_…）">
      <button id="pair-btn" class="btn btn-primary" type="button">完成配对</button>
      <span id="pair-msg" class="inline-msg"></span>
    </div>
  </section>

  <div id="main" style="display:none;flex-direction:column;gap:18px">
    <section class="card">
      <div class="card-head">
        <div>
          <h2 class="card-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="4 17 10 11 4 5"></polyline>
              <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>
            本机可用 Agent
          </h2>
          <p class="card-sub">自动扫描本机已安装的命令行工具与下方登记的云端或本地网关，选择房间即可一键入座。</p>
        </div>
        <button id="rescan-btn" class="btn" type="button">重新扫描本机</button>
      </div>
      <div id="agents" class="empty-state">正在读取可用 Agent…</div>
    </section>

    <section class="card" id="preset-card">
      <div class="card-head">
        <div>
          <h2 class="card-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="16"></line>
              <line x1="8" y1="12" x2="16" y2="12"></line>
            </svg>
            一键接入更多主流 Agent
          </h2>
          <p class="card-sub">点选预设自动填充接口地址与推荐模型。所有密钥只保存在你自己的电脑里（仅当前系统账号可读），绝不上传平台服务器。</p>
        </div>
      </div>

      <div id="preset-pills" class="preset-pills" role="tablist" aria-label="主流 Agent 预设模板库"></div>

      <div class="form-grid">
        <div class="field">
          <label for="m-kind">协议类型</label>
          <select id="m-kind">
            <option value="openai-compatible">OpenAI 兼容接口（HTTPS 或本机回环）</option>
            <option value="webhook">HMAC-SHA256 Webhook 桥接</option>
          </select>
        </div>
        <div class="field">
          <label for="m-name">席位显示名称</label>
          <input id="m-name" placeholder="例如 Grok / Muse">
        </div>
      </div>

      <div id="m-openai" class="form-grid">
        <div class="field">
          <label for="m-base">接口地址（Base URL）</label>
          <input id="m-base" placeholder="https://api.x.ai/v1 或 http://127.0.0.1:11434/v1">
        </div>
        <div class="field">
          <label for="m-model">模型名称</label>
          <input id="m-model" placeholder="grok-3-mini">
        </div>
        <div class="field">
          <label for="m-apikey">API Key</label>
          <input id="m-apikey" type="password" autocomplete="off" placeholder="只保存在你自己的电脑里，绝不上传平台服务器">
        </div>
      </div>

      <div id="m-webhook" style="display:none">
        <div class="form-grid">
          <div class="field">
            <label for="m-url">Webhook 接收地址</label>
            <input id="m-url" placeholder="http://127.0.0.1:9001/grokbot 或 https://…">
          </div>
          <div class="field">
            <label for="m-secret">HMAC 签名密钥（Secret）</label>
            <input id="m-secret" type="password" autocomplete="off" placeholder="用于校验 X-MAPR-Signature 请求头">
          </div>
        </div>
        <details id="webhook-guide" class="snippet-box">
          <summary>查看 Node.js HMAC-SHA256 本地桥接模板（18 行即拷即用，适配 Grokbot / Muse / 自定义脚本）</summary>
          <pre id="webhook-code" class="snippet-pre">import http from "node:http";
import crypto from "node:crypto";
const SECRET = process.env.WEBHOOK_SECRET || "replace-with-your-secret";
http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const expected = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
    const sig = String(req.headers["x-mapr-signature"] || "");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return void res.writeHead(401).end(JSON.stringify({ error: "bad_signature" }));
    }
    const { prompt } = JSON.parse(raw || "{}");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "OK: " + String(prompt || "").slice(0, 200) }));
  });
}).listen(9001, "127.0.0.1", () => console.log("Bridge ready on http://127.0.0.1:9001"));</pre>
          <button id="copy-snippet-btn" class="btn" type="button">复制桥接代码</button>
        </details>
      </div>

      <div class="form-footer">
        <div class="field" style="min-width:260px;flex:1;max-width:420px">
          <label for="m-room">保存后直接加入房间（可选）</label>
          <select id="m-room">
            <option value="">仅保存到本机（稍后选择房间）</option>
          </select>
          <a id="no-rooms-link" class="subtle-link" href="#" target="_blank" rel="noopener noreferrer" style="display:none">还没有协作房间？前往网页端新建房间 →</a>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span id="m-msg" class="inline-msg"></span>
          <button id="m-add" class="btn btn-primary" type="button">保存 Agent</button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2 class="card-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            </svg>
            当前运行中的房间席位
          </h2>
          <p class="card-sub">每个席位拥有独立 XMTP 密钥与隔离沙箱；加入后请确保线上房间页面已打开以完成加密群成员同步。</p>
        </div>
      </div>
      <div id="seats" class="empty-state">暂无运行中的席位。</div>
    </section>
  </div>
</main>

<script>
const H = { "Content-Type": "application/json", "X-MAPR-Owner": "1" };
const $ = (id) => document.getElementById(id);

const PRESETS = [
  { id: "grok", label: "Grok (xAI API)", kind: "openai-compatible", name: "Grok", baseUrl: "https://api.x.ai/v1", model: "grok-3-mini", apiKey: "" },
  { id: "grokbot-webhook", label: "Grokbot (Webhook)", kind: "webhook", name: "Grokbot", url: "http://127.0.0.1:9001/grokbot" },
  { id: "muse", label: "Muse (兼容网关)", kind: "openai-compatible", name: "Muse", baseUrl: "http://127.0.0.1:8080/v1", model: "muse-default", apiKey: "" },
  { id: "muse-webhook", label: "Muse (Webhook)", kind: "webhook", name: "Muse", url: "http://127.0.0.1:9002/muse" },
  { id: "openai", label: "Codex / OpenAI API", kind: "openai-compatible", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: "" },
  { id: "claude-api", label: "Claude (兼容网关)", kind: "openai-compatible", name: "Claude API", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-20250514", apiKey: "" },
  { id: "gemini-api", label: "Gemini API", kind: "openai-compatible", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-pro", apiKey: "" },
  { id: "deepseek", label: "DeepSeek", kind: "openai-compatible", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "" },
  { id: "ollama", label: "Ollama 本机模型", kind: "openai-compatible", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b", apiKey: "ollama" },
  { id: "webhook", label: "自定义 Webhook", kind: "webhook", name: "", url: "http://127.0.0.1:9000/webhook" }
];

let paired = false;
let hubOrigin = "";
let rooms = [];
let agentsCache = [];
let activePresetId = "grok";
let pendingRoomId = "";
let pendingTicket = null;
let pendingPresetId = "";

function safeHttpOrigin(raw) {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") ? u.origin : "";
  } catch {
    return "";
  }
}

function showNoticeBanner(kind, text) {
  const el = $("notice-banner");
  const txt = $("notice-text");
  if (!el || !txt) return;
  el.className = "banner-notice " + (kind === "err" ? "banner-notice-err" : "banner-notice-info");
  txt.textContent = text;
  el.style.display = "flex";
}

function hideNoticeBanner() {
  const el = $("notice-banner");
  if (el) el.style.display = "none";
}

async function j(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.reason || ("HTTP " + res.status));
  return data;
}

function isLoopbackUrl(raw) {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    const h = (u.hostname || "").toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

function trustTierInfo(a) {
  if (a.kind === "claude-code" || a.kind === "codex" || a.kind === "gemini-cli") {
    return { text: "本机", cls: "badge-tier badge-tier-local" };
  }
  if (
    a.kind === "openai-compatible" &&
    (isLoopbackUrl(a.baseUrl) || String(a.displayName || "").toLowerCase().includes("ollama") || String(a.model || "").toLowerCase().includes("ollama"))
  ) {
    return { text: "本机", cls: "badge-tier badge-tier-local" };
  }
  if (a.kind === "webhook") {
    return { text: "自定义接口", cls: "badge-tier badge-tier-custom" };
  }
  return { text: "云端接口", cls: "badge-tier badge-tier-cloud" };
}

function readinessInfo(a) {
  if (a.source === "manual") return { cls: "badge-info", text: "已配置密钥" };
  if (a.loginState === "likely-ready") return { cls: "badge-ok", text: "已就绪" };
  if (a.loginState === "needs-login") return { cls: "badge-warn", text: "需终端登录" };
  if (a.kind === "codex") return { cls: "badge-warn", text: "缺少沙箱组件" };
  return { cls: "badge-warn", text: "状态待确认" };
}

function seatStatusInfo(s) {
  const map = {
    running: { dot: "dot-ok", text: "运行中" },
    starting: { dot: "dot-warn", text: "启动中" },
    crashed: { dot: "dot-err", text: "异常退出" },
    stopped: { dot: "dot-muted", text: "已停止" },
    revoked: { dot: "dot-err", text: "已吊销" }
  };
  return map[s] || { dot: "dot-warn", text: String(s) };
}

function showHandoffBanner(seat) {
  if (!seat || !seat.roomId) return;
  const banner = $("handoff-banner");
  const textEl = $("handoff-text");
  const linkEl = $("handoff-link");
  const roomLabel = seat.roomName ? ("已将席位加入房间「" + seat.roomName + "」") : "已将席位加入房间";
  textEl.textContent = roomLabel;
  const safeOrigin = safeHttpOrigin(hubOrigin);
  if (safeOrigin) {
    linkEl.href = safeOrigin + "/rooms/" + encodeURIComponent(seat.roomId);
    linkEl.style.display = "";
  } else {
    linkEl.style.display = "none";
  }
  banner.style.display = "flex";
}

function syncKindFields(kind) {
  $("m-openai").style.display = kind === "openai-compatible" ? "grid" : "none";
  $("m-webhook").style.display = kind === "webhook" ? "block" : "none";
}

function syncAddButtonLabel() {
  const targetRoom = $("m-room").value;
  $("m-add").textContent = targetRoom ? "保存并一键加入房间" : "保存 Agent";
}

function applyPreset(presetId, focusSecret) {
  const p = PRESETS.find((item) => item.id === presetId) || PRESETS[0];
  activePresetId = p.id;
  for (const btn of $("preset-pills").querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.preset === p.id);
  }
  $("m-kind").value = p.kind;
  syncKindFields(p.kind);
  $("m-name").value = p.name || "";
  if (p.kind === "openai-compatible") {
    $("m-base").value = p.baseUrl || "";
    $("m-model").value = p.model || "";
    $("m-apikey").value = p.apiKey || "";
    if (focusSecret) $("m-apikey").focus();
  } else {
    $("m-url").value = p.url || "";
    $("m-secret").value = "";
    if (focusSecret) $("m-secret").focus();
  }
  $("m-msg").textContent = "";
  return p;
}

function applyPresetFromHash(presetId) {
  const preset = applyPreset(presetId, paired);
  if (pendingRoomId) renderFormRoomOptions();
  showNoticeBanner("info", "已选中「" + preset.label + "」预设 — 填入密钥并点击保存即可接入");
  if (paired) {
    const presetCard = $("preset-card");
    if (presetCard && presetCard.scrollIntoView) {
      presetCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const secretField = preset.kind === "webhook" ? $("m-secret") : $("m-apikey");
    if (secretField) secretField.focus();
  }
}

function renderPresetPills() {
  const wrap = $("preset-pills");
  wrap.replaceChildren();
  for (const p of PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-pill" + (p.id === activePresetId ? " active" : "");
    btn.dataset.preset = p.id;
    btn.textContent = p.label;
    btn.onclick = () => applyPreset(p.id, true);
    wrap.append(btn);
  }
}

function renderFormRoomOptions() {
  const sel = $("m-room");
  const prev = pendingRoomId || sel.value;
  sel.replaceChildren();
  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "仅保存到本机（稍后选择房间）";
  sel.append(emptyOpt);
  for (const r of rooms) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name + (r.role === "viewer" ? "（只读，不可加入）" : "");
    opt.disabled = r.role === "viewer";
    sel.append(opt);
  }
  if (prev && Array.from(sel.options).some((o) => o.value === prev && !o.disabled)) {
    sel.value = prev;
  }
  const noRoomsLink = $("no-rooms-link");
  const safeOrigin = safeHttpOrigin(hubOrigin);
  if (noRoomsLink) {
    if (paired && rooms.length === 0 && safeOrigin) {
      noRoomsLink.href = safeOrigin + "/home";
      noRoomsLink.style.display = "inline-block";
    } else {
      noRoomsLink.style.display = "none";
    }
  }
  syncAddButtonLabel();
}

async function refreshStatus() {
  const hello = await j("GET", "/api/hello");
  paired = !!hello.paired;
  hubOrigin = safeHttpOrigin(hello.hub_origin || "");
  $("version").textContent = hello.version ? ("v" + hello.version) : "";
  const dot = $("status-dot");
  const txt = $("status-text");
  const hubLink = $("hub-link");
  const safeOrigin = safeHttpOrigin(hubOrigin);
  if (paired) {
    dot.className = "dot dot-ok";
    txt.textContent = "已配对 · " + (hello.owner_display_name || "当前账号");
    if (safeOrigin) {
      hubLink.href = safeOrigin + "/agents";
      hubLink.style.display = "inline-flex";
    } else {
      hubLink.style.display = "none";
    }
  } else {
    dot.className = "dot dot-warn";
    txt.textContent = "未配对";
    hubLink.style.display = "none";
    const noRoomsLink = $("no-rooms-link");
    if (noRoomsLink) noRoomsLink.style.display = "none";
  }
  $("pair-section").style.display = paired ? "none" : "block";
  $("main").style.display = paired ? "flex" : "none";
}

async function refreshRooms() {
  if (!paired) return;
  try {
    rooms = await j("GET", "/api/rooms");
  } catch (e) {
    rooms = [];
  }
  renderFormRoomOptions();
}

async function refreshAgents() {
  agentsCache = await j("GET", "/api/agents");
  const el = $("agents");
  el.replaceChildren();
  if (agentsCache.length === 0) {
    el.className = "empty-state";
    el.textContent = "暂未探测到本机 CLI Agent，可在下方选择预设一键添加云端或本地网关。";
    return;
  }
  el.className = "";
  const joinableRooms = rooms.filter((r) => r.role !== "viewer");
  for (const a of agentsCache) {
    const item = document.createElement("div");
    item.className = "agent-item";

    const main = document.createElement("div");
    main.className = "agent-main";

    const meta = document.createElement("div");
    meta.className = "agent-meta";

    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = a.displayName;
    meta.append(name);

    const tInfo = trustTierInfo(a);
    const tier = document.createElement("span");
    tier.className = "badge " + tInfo.cls;
    tier.textContent = tInfo.text;
    meta.append(tier);

    const rInfo = readinessInfo(a);
    const readyBadge = document.createElement("span");
    readyBadge.className = "badge " + rInfo.cls;
    readyBadge.textContent = rInfo.text;
    meta.append(readyBadge);

    const ver = document.createElement("span");
    ver.className = "agent-ver";
    ver.textContent = (a.kind || "") + (a.version ? (" · " + a.version) : "");
    meta.append(ver);

    main.append(meta);

    const actions = document.createElement("div");
    actions.className = "agent-actions";

    const probeBox = document.createElement("div");
    probeBox.style.display = "none";

    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "btn";
    testBtn.textContent = "测试连接";
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = "检测中…";
      probeBox.className = "probe-result";
      probeBox.style.display = "block";
      probeBox.textContent = "正在验证连通性与运行环境…";
      try {
        const res = await j("POST", "/api/agents/" + encodeURIComponent(a.key) + "/test", {});
        probeBox.className = "probe-result " + (res.ok ? "probe-ok" : "probe-err");
        probeBox.textContent = (res.ok ? "连接就绪" : "检测未通过") + " · " + res.latencyMs + " ms · " + (res.detail || "");
      } catch (e) {
        probeBox.className = "probe-result probe-err";
        probeBox.textContent = "检测失败：" + e.message;
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "测试连接";
      }
    };
    actions.append(testBtn);

    const sel = document.createElement("select");
    if (rooms.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "暂无可加入的房间";
      sel.append(opt);
      sel.disabled = true;
    } else {
      for (const r of rooms) {
        const opt = document.createElement("option");
        opt.value = r.id;
        opt.textContent = r.name + (r.role === "viewer" ? "（只读）" : "");
        opt.disabled = r.role === "viewer";
        sel.append(opt);
      }
      if (pendingRoomId && joinableRooms.some((r) => r.id === pendingRoomId)) {
        sel.value = pendingRoomId;
      }
    }
    actions.append(sel);

    const joinBtn = document.createElement("button");
    joinBtn.type = "button";
    joinBtn.className = "btn btn-primary";
    joinBtn.textContent = "一键加入房间";
    joinBtn.disabled = joinableRooms.length === 0;
    joinBtn.onclick = async () => {
      if (!sel.value) return;
      joinBtn.disabled = true;
      try {
        const seat = await j("POST", "/api/seats", { via: "local", room_id: sel.value, agent_key: a.key });
        await refreshSeats();
        showHandoffBanner(seat);
      } catch (e) {
        probeBox.className = "probe-result probe-err";
        probeBox.style.display = "block";
        probeBox.textContent = "加入房间失败：" + e.message;
      } finally {
        joinBtn.disabled = joinableRooms.length === 0;
      }
    };
    actions.append(joinBtn);

    if (a.source === "manual" || String(a.key || "").startsWith("manual:")) {
      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "btn btn-danger";
      rmBtn.textContent = "移除";
      rmBtn.onclick = async () => {
        if (!confirm("确认从本机移除「" + a.displayName + "」及其保存的密钥文件？")) return;
        rmBtn.disabled = true;
        try {
          await j("DELETE", "/api/agents/manual/" + encodeURIComponent(a.key));
          await refreshAgents();
        } catch (e) {
          probeBox.className = "probe-result probe-err";
          probeBox.style.display = "block";
          probeBox.textContent = e.message === "agent_has_active_seats"
            ? "该 Agent 仍有运行中的房间席位，请先在下方将席位移出房间后再移除。"
            : ("移除失败：" + e.message);
          rmBtn.disabled = false;
        }
      };
      actions.append(rmBtn);
    }

    main.append(actions);
    item.append(main);
    item.append(probeBox);
    el.append(item);
  }
}

async function refreshSeats() {
  const list = await j("GET", "/api/seats");
  const el = $("seats");
  el.replaceChildren();
  if (list.length === 0) {
    el.className = "empty-state";
    el.textContent = "暂无运行中的席位。";
    return;
  }
  el.className = "";
  const safeOrigin = safeHttpOrigin(hubOrigin);
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "seat-row";

    const info = document.createElement("div");
    info.className = "seat-info";

    const primary = document.createElement("div");
    primary.className = "seat-primary";

    const st = seatStatusInfo(s.status);
    const dot = document.createElement("span");
    dot.className = "dot " + st.dot;
    primary.append(dot);

    const matchedAgent = agentsCache.find((a) => a.key === s.agentKey);
    const agentTitle = document.createElement("span");
    agentTitle.textContent = (matchedAgent ? matchedAgent.displayName : s.agentKey) + " · " + s.roomName;
    primary.append(agentTitle);

    const stText = document.createElement("span");
    stText.className = "badge badge-tier";
    stText.textContent = st.text;
    primary.append(stText);

    const addr = document.createElement("span");
    addr.className = "seat-addr";
    addr.textContent = s.xmtpAddress ? (s.xmtpAddress.slice(0, 10) + "…" + s.xmtpAddress.slice(-4)) : "";
    primary.append(addr);

    info.append(primary);

    if (s.lastError) {
      const errDiv = document.createElement("div");
      errDiv.className = "seat-err";
      errDiv.textContent = s.lastError;
      info.append(errDiv);
    }

    const actions = document.createElement("div");
    actions.className = "agent-actions";

    if (safeOrigin && s.roomId) {
      const openLink = document.createElement("a");
      openLink.className = "btn";
      openLink.href = safeOrigin + "/rooms/" + encodeURIComponent(s.roomId);
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      openLink.textContent = "打开房间";
      actions.append(openLink);
    }

    const outBtn = document.createElement("button");
    outBtn.type = "button";
    outBtn.className = "btn btn-danger";
    outBtn.textContent = "移出房间";
    outBtn.onclick = async () => {
      if (!confirm("确认将该席位移出房间并销毁其本机隔离密钥？")) return;
      outBtn.disabled = true;
      try {
        await j("DELETE", "/api/seats/" + encodeURIComponent(s.seatId));
        await refreshSeats();
      } catch (e) {
        showNoticeBanner("err", "移出房间失败：" + e.message);
        outBtn.disabled = false;
      }
    };
    actions.append(outBtn);

    row.append(info);
    row.append(actions);
    el.append(row);
  }
}

async function doPair(code) {
  if (!code) return;
  $("pair-msg").textContent = "正在配对…";
  try {
    await j("POST", "/api/pair", { code });
    $("pair-msg").textContent = "";
    hideNoticeBanner();
    await refreshStatus();
    await refreshRooms();
    await refreshAgents();
    await refreshSeats();
    if (pendingTicket) {
      const ticketToJoin = pendingTicket;
      pendingTicket = null;
      await joinTicket(ticketToJoin.ticket, ticketToJoin.agent);
    }
    if (pendingPresetId) {
      const presetToApply = pendingPresetId;
      pendingPresetId = "";
      applyPresetFromHash(presetToApply);
    }
  } catch (e) {
    $("pair-msg").textContent = "配对失败：" + e.message;
  }
}

async function joinTicket(ticket, agentKey) {
  try {
    const seat = await j("POST", "/api/seats", { via: "ticket", ticket, agent_key: agentKey });
    await refreshSeats();
    showHandoffBanner(seat);
  } catch (e) {
    showNoticeBanner("err", "加入房间失败：" + e.message);
  }
}

function readAndScrubHash() {
  const h = location.hash || "";
  if (h.length <= 1) return null;
  const params = new URLSearchParams(h.slice(1));
  history.replaceState({}, "", location.pathname + location.search);
  return {
    pairCode: params.get("pair") || "",
    ticket: params.get("ticket") || "",
    agent: params.get("agent") || "",
    preset: params.get("preset") || "",
    room: params.get("room") || ""
  };
}

renderPresetPills();
applyPreset("grok", false);

$("pair-btn").onclick = () => doPair($("pair-code").value.trim());
$("rescan-btn").onclick = async () => {
  $("rescan-btn").disabled = true;
  try {
    await j("POST", "/api/agents/rescan");
    await refreshAgents();
  } finally {
    $("rescan-btn").disabled = false;
  }
};
$("m-kind").onchange = (ev) => syncKindFields(ev.target.value);
$("m-room").onchange = () => {
  pendingRoomId = $("m-room").value;
  syncAddButtonLabel();
};
$("copy-snippet-btn").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("webhook-code").textContent || "");
    $("copy-snippet-btn").textContent = "已复制代码";
    setTimeout(() => { $("copy-snippet-btn").textContent = "复制桥接代码"; }, 1800);
  } catch (e) {}
};
$("m-add").onclick = async () => {
  const kind = $("m-kind").value;
  const targetRoomId = $("m-room").value;
  const body = { kind, displayName: $("m-name").value.trim() };
  if (kind === "openai-compatible") {
    body.baseUrl = $("m-base").value.trim();
    body.model = $("m-model").value.trim();
    body.apiKey = $("m-apikey").value.trim();
  } else {
    body.url = $("m-url").value.trim();
    body.secret = $("m-secret").value.trim();
  }
  $("m-add").disabled = true;
  $("m-msg").textContent = "正在保存…";
  try {
    const created = await j("POST", "/api/agents/manual", body);
    await refreshAgents();
    if (targetRoomId) {
      $("m-msg").textContent = "已保存，正在加入房间…";
      const seat = await j("POST", "/api/seats", { via: "local", room_id: targetRoomId, agent_key: created.key });
      await refreshSeats();
      showHandoffBanner(seat);
      $("m-msg").textContent = "已保存并加入房间";
    } else {
      $("m-msg").textContent = "已保存到本机可用列表";
    }
    if (kind === "openai-compatible" && body.apiKey !== "ollama") $("m-apikey").value = "";
    if (kind === "webhook") $("m-secret").value = "";
  } catch (e) {
    $("m-msg").textContent = "操作失败：" + e.message;
  } finally {
    $("m-add").disabled = false;
  }
};

(async () => {
  const hashIntent = readAndScrubHash();
  if (hashIntent && hashIntent.room) {
    pendingRoomId = hashIntent.room;
  }
  if (hashIntent && hashIntent.preset) {
    pendingPresetId = hashIntent.preset;
  }
  if (hashIntent && hashIntent.ticket && hashIntent.agent) {
    pendingTicket = { ticket: hashIntent.ticket, agent: hashIntent.agent };
  }
  try {
    await refreshStatus();
    if (!paired && hashIntent && hashIntent.pairCode) {
      await doPair(hashIntent.pairCode);
    } else if (paired) {
      await refreshRooms();
      await refreshAgents();
      await refreshSeats();
    }
    if (paired) {
      if (pendingTicket) {
        const ticketToJoin = pendingTicket;
        pendingTicket = null;
        await joinTicket(ticketToJoin.ticket, ticketToJoin.agent);
      }
      if (pendingPresetId) {
        const presetToApply = pendingPresetId;
        pendingPresetId = "";
        applyPresetFromHash(presetToApply);
      }
    } else {
      if (pendingPresetId) {
        applyPreset(pendingPresetId, false);
      }
      if (pendingTicket) {
        showNoticeBanner("info", "请先完成配对，配对后将自动把所选智能体带入房间");
      } else if (pendingPresetId) {
        const matched = PRESETS.find((item) => item.id === pendingPresetId) || PRESETS[0];
        showNoticeBanner("info", "已选中「" + matched.label + "」预设 — 填入密钥并点击保存即可接入");
      }
    }
  } catch (e) {
    $("status-dot").className = "dot dot-err";
    $("status-text").textContent = "本机助手异常：" + e.message;
  }
  setInterval(async () => {
    try {
      if (paired) await refreshSeats();
    } catch (e) {}
  }, 5000);
})();
</script>
</body>
</html>
`;

function classifySeatWrite(body: unknown): RequestClass {
  const via = (body as Record<string, unknown> | null)?.via;
  return via === "local" ? "owner-write" : "ticket-write";
}

export function createHelperServer(deps: HelperServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    const host = first(req.headers.host);
    const origin = first(req.headers.origin);
    const ownerHeader = first(req.headers["x-mapr-owner"]);
    const method = (req.method || "GET").toUpperCase();
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const hubOrigin = deps.config()?.hubOrigin ?? null;

    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    const sendErr = (err: unknown): void => {
      const status =
        err instanceof HelperHttpError
          ? err.status
          : err instanceof HubError
            ? err.status >= 400 && err.status < 600
              ? err.status
              : 502
            : 500;
      send(status, { ok: false, reason: messageOf(err) });
    };

    let requestClass = classify(method, url.pathname);
    if (method === "OPTIONS") {
      // 预检一律按最宽松的 public-read 校验；真正的请求还会再独立过一次 guard。
      requestClass = "public-read";
    }
    if (requestClass === null) {
      send(404, { ok: false, reason: "not_found" });
      return;
    }

    // POST /api/seats 的类别取决于 body.via，必须先读体再定。
    let body: unknown;
    if (requestClass === "seat-write") {
      try {
        body = await readBody(req);
      } catch (err) {
        sendErr(err);
        return;
      }
      requestClass = classifySeatWrite(body);
    }

    const g = guardHelperRequest({ method, host, origin, ownerHeader, hubOrigin, requestClass });
    if (!g.ok) {
      // 页面请求给一个能看懂原因的提示页（比如用局域网 IP 或 *.local 打开）。
      if (requestClass === "page") {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><meta charset=utf-8><title>403</title>" +
            '<body style="font-family:system-ui;padding:2em;max-width:34em;margin:auto">' +
            "<h2>本机控制台拒绝了这次访问</h2>" +
            "<p>它只接受通过本机回环地址打开的请求（防止别的网站冒用你的身份）。</p>" +
            '<p>请改用 <a href="http://127.0.0.1:8790/">http://127.0.0.1:8790/</a> 打开。' +
            "如果你是用局域网 IP、<code>*.local</code> 主机名或从另一台设备访问，就会出现这个页面。</p>" +
            "</body>"
        );
        return;
      }
      send(403, { ok: false, reason: "forbidden" });
      return;
    }
    if (g.corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", g.corsOrigin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-MAPR-Owner");
    // Chrome 的 Private Network Access 预检要求这个头，否则公网站点永远够不到 127.0.0.1。
    res.setHeader("Access-Control-Allow-Private-Network", "true");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (method === "GET" && url.pathname === "/") {
        const script = HELPER_PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
        const scriptHash = createHash("sha256").update(script).digest("base64");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'self'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
        });
        res.end(HELPER_PAGE_HTML);
        return;
      }
      if (method === "GET" && url.pathname === "/api/hello") {
        const cfg = deps.config();
        send(200, {
          app: "mapr-helper",
          version: deps.version,
          paired: Boolean(cfg?.helperToken),
          hub_origin: cfg?.hubOrigin ?? null,
          owner_display_name: cfg?.helperToken ? cfg.ownerDisplayName : null,
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/agents") {
        send(200, await deps.agents());
        return;
      }
      if (method === "GET" && url.pathname === "/api/rooms") {
        const hub = deps.hub();
        if (!hub) throw new HelperHttpError(401, "not_paired");
        send(200, await hub.listRooms());
        return;
      }
      if (method === "GET" && url.pathname === "/api/seats") {
        send(200, await deps.supervisor.views());
        return;
      }
      if (method === "POST" && url.pathname === "/api/pair") {
        const b = (await readBody(req)) as Record<string, unknown>;
        const code = typeof b?.code === "string" ? b.code.trim() : "";
        if (!code) throw new HelperHttpError(400, "code_required");
        const cfg = await deps.pair(code);
        send(200, { ok: true, owner_display_name: cfg.ownerDisplayName, hub_origin: cfg.hubOrigin });
        return;
      }
      if (method === "POST" && url.pathname === "/api/agents/rescan") {
        send(200, await deps.rescan());
        return;
      }
      if (method === "POST" && url.pathname === "/api/agents/manual") {
        if (!deps.addManualAgent) throw new HelperHttpError(501, "not_implemented");
        send(201, await deps.addManualAgent(await readBody(req)));
        return;
      }
      const testMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/test$/);
      if (method === "POST" && testMatch) {
        if (!deps.testAgent) throw new HelperHttpError(501, "not_implemented");
        const agentKey = decodeSegment(testMatch[1]);
        send(200, await deps.testAgent(agentKey));
        return;
      }
      const delManual = url.pathname.match(/^\/api\/agents\/manual\/([^/]+)$/);
      if (method === "DELETE" && delManual) {
        if (!deps.removeManualAgent) throw new HelperHttpError(501, "not_implemented");
        const agentKey = decodeSegment(delManual[1]);
        await deps.removeManualAgent(agentKey);
        send(200, { ok: true });
        return;
      }
      if (method === "POST" && url.pathname === "/api/seats") {
        send(200, await handleCreateSeat(deps, body));
        return;
      }
      // WP5 本机暂停/恢复：只停/起成员进程并写 pausedAt 标记，席位数据与私钥一律保留。
      // Hub 侧的 pause/resume 端点只收人类登录令牌（helper 令牌无权调用），
      // Hub 发起的暂停经心跳 seats_to_pause 下发到 up.ts 对账，两条路径在此汇合。
      const pauseMatch = url.pathname.match(/^\/api\/seats\/([^/]+)\/pause$/);
      if (method === "POST" && pauseMatch) {
        const seatId = decodeSegment(pauseMatch[1]);
        const rec = await deps.store.get(seatId);
        if (!rec) throw new HelperHttpError(404, "seat_not_found");
        if (!rec.pausedAt) {
          rec.pausedAt = new Date().toISOString();
          rec.pausedSource = "local";
          await deps.store.save(rec);
        }
        await deps.supervisor.stop(seatId);
        send(200, await seatViewOf(deps, seatId));
        return;
      }
      const resumeMatch = url.pathname.match(/^\/api\/seats\/([^/]+)\/resume$/);
      if (method === "POST" && resumeMatch) {
        const seatId = decodeSegment(resumeMatch[1]);
        const rec = await deps.store.get(seatId);
        if (!rec) throw new HelperHttpError(404, "seat_not_found");
        if (rec.pausedAt || rec.pausedSource) {
          rec.pausedAt = null;
          rec.pausedSource = null;
          await deps.store.save(rec);
        }
        try {
          await deps.supervisor.start(seatId);
        } catch {
          // 起不来不假报成功：seatViewOf 会如实返回 crashed/stopped 视图。
        }
        send(200, await seatViewOf(deps, seatId));
        return;
      }
      const del = url.pathname.match(/^\/api\/seats\/([^/]+)$/);
      if (method === "DELETE" && del) {
        const seatId = decodeSegment(del[1]);
        const rec = await deps.store.get(seatId);
        if (!rec) throw new HelperHttpError(404, "seat_not_found");
        await deps.supervisor.stop(seatId);
        const hub = deps.hub();
        if (hub) {
          try {
            await hub.deleteSeat(seatId);
          } catch (err) {
            if (!(err instanceof HubError && err.status === 404)) {
              // Hub 侧没删掉就保留本地记录，主人可以重试；直接删会留下 Hub 侧孤儿席位。
              throw new HelperHttpError(502, "hub_delete_failed");
            }
          }
        }
        if (deps.removeSeat) {
          await deps.removeSeat(seatId);
        } else {
          await deps.store.remove(seatId);
        }
        send(200, { ok: true });
        return;
      }
      send(404, { ok: false, reason: "not_found" });
    } catch (err) {
      sendErr(err);
    }
  });
}
