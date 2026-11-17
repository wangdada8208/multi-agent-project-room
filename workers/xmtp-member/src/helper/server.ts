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
   * 添加手动云端 Agent：校验入参、把元数据写进 helper.json、把密钥写进
   * ~/.mapr/agents/<key>.secret（0600），返回登记后的 LocalAgent。
   * 由 up.ts 提供（它持有配置文件路径）；未提供时端点返回 501。
   */
  addManualAgent?: (input: unknown) => Promise<LocalAgent>;
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
  if (method === "POST" && pathname === "/api/seats") return "seat-write";
  if (method === "DELETE" && /^\/api\/seats\/[^/]+$/.test(pathname)) return "owner-write";
  return null;
}

const HELPER_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>MAPR 本机助手</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 920px; margin: 24px auto; padding: 0 16px; color: #1f2933; }
section { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
h2 { margin-top: 0; font-size: 17px; }
button { margin-right: 8px; padding: 4px 12px; cursor: pointer; }
code { font-size: 12px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: top; }
th { background: #f9f9f9; }
input, select { padding: 5px 6px; margin: 2px 4px 2px 0; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 6px; font-size: 12px; white-space: nowrap; }
.ok { background: #dcfce7; color: #166534; }
.warn { background: #fef9c3; color: #854d0e; }
.err { background: #fee2e2; color: #991b1b; }
.muted { color: #6b7280; }
.agent-row { border-top: 1px solid #eee; padding: 10px 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.agent-name { font-weight: 600; min-width: 140px; }
.err-text { color: #991b1b; font-size: 13px; }
</style>
</head>
<body>
<h1>MAPR 本机助手</h1>
<p>状态：<span id="status">加载中…</span> Hub：<code id="hub">-</code> <span class="muted" id="version"></span></p>

<section id="pair-section" style="display:none">
<h2>配对这台电脑</h2>
<p>打开网站的「我的 Agent」页面拿到配对码，粘贴到这里。配对码 10 分钟内有效、只能用一次。</p>
<p><input id="pair-code" size="42" placeholder="mpc_…"><button id="pair-btn">配对</button><span id="pair-msg"></span></p>
</section>

<div id="main" style="display:none">
<section>
<h2>这台电脑上的 Agent <button id="rescan-btn">重新探测</button></h2>
<div id="agents">加载中…</div>
</section>

<section>
<h2>添加云端 Agent</h2>
<p class="muted">适合有兼容接口的云端 Agent（如 xAI Grok）。密钥只存在这台电脑上（<code>~/.mapr/agents/</code>），不会发给网站。</p>
<p>
<select id="m-kind">
<option value="openai-compatible">OpenAI 兼容接口</option>
<option value="webhook">Webhook</option>
</select>
<input id="m-name" placeholder="显示名（如 Grok）" size="14">
</p>
<p id="m-openai">
<input id="m-base" placeholder="接口地址，如 https://api.x.ai/v1" size="30">
<input id="m-model" placeholder="模型名" size="14">
<input id="m-key" placeholder="API Key" size="26" type="password">
</p>
<p id="m-webhook" style="display:none">
<input id="m-url" placeholder="https://… 接口地址" size="34">
<input id="m-secret" placeholder="签名密钥" size="20" type="password">
</p>
<p><button id="m-add">添加</button><span id="m-msg"></span></p>
</section>

<section>
<h2>席位（Agent × 房间）</h2>
<p class="muted">加入后还需要房主在房间页把新地址拉进加密群；页面会自动刷新状态。</p>
<div id="seats">加载中…</div>
</section>
</div>

<script>
const H = { "Content-Type": "application/json", "X-MAPR-Owner": "1" };
const $ = (id) => document.getElementById(id);
let paired = false;
let rooms = [];

async function j(method, url, body) {
  const res = await fetch(url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.reason || ("HTTP " + res.status));
  return data;
}

function loginBadge(a) {
  if (a.loginState === "likely-ready") return '<span class="badge ok">可用</span>';
  if (a.loginState === "needs-login") return '<span class="badge warn">需要先在本机登录</span>';
  if (a.kind === "codex") return '<span class="badge warn">缺少沙箱组件（bwrap），加入后可能无法启动</span>';
  return '<span class="badge warn">状态未知</span>';
}

function statusBadge(s) {
  const map = { running: "ok", starting: "warn", crashed: "err", stopped: "warn", revoked: "err" };
  const label = { running: "运行中", starting: "启动中", crashed: "已崩溃", stopped: "已停止", revoked: "已吊销" };
  return '<span class="badge ' + (map[s] || "warn") + '">' + (label[s] || s) + "</span>";
}

async function refreshStatus() {
  const hello = await j("GET", "/api/hello");
  paired = !!hello.paired;
  document.getElementById("version").textContent = "v" + hello.version;
  document.getElementById("hub").textContent = hello.hub_origin || "-";
  document.getElementById("status").innerHTML = paired
    ? '<span class="badge ok">已配对</span> ' + (hello.owner_display_name || "")
    : '<span class="badge warn">未配对</span>';
  document.getElementById("pair-section").style.display = paired ? "none" : "";
  document.getElementById("main").style.display = paired ? "" : "none";
}

async function refreshRooms() {
  if (!paired) return;
  try {
    rooms = await j("GET", "/api/rooms");
  } catch (e) {
    rooms = [];
  }
}

async function refreshAgents() {
  const list = await j("GET", "/api/agents");
  const el = document.getElementById("agents");
  el.replaceChildren();
  if (list.length === 0) {
    el.textContent = "没有探测到可用的 Agent。";
    return;
  }
  for (const a of list) {
    const row = document.createElement("div");
    row.className = "agent-row";
    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = a.displayName + (a.source === "manual" ? "（手动添加）" : "");
    row.append(name);
    const info = document.createElement("span");
    info.className = "muted";
    info.textContent = (a.kind || "") + (a.version ? " · " + a.version : "");
    row.append(info);
    const badge = document.createElement("span");
    badge.innerHTML = loginBadge(a);
    row.append(badge);
    const sel = document.createElement("select");
    for (const r of rooms) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name + (r.role === "viewer" ? "（只读，不能加入）" : "");
      opt.disabled = r.role === "viewer";
      sel.append(opt);
    }
    row.append(sel);
    const btn = document.createElement("button");
    btn.textContent = "加入房间";
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await j("POST", "/api/seats", { via: "local", room_id: sel.value, agent_key: a.key });
        refreshSeats();
      } catch (e) {
        alert("加入失败：" + e.message);
      } finally {
        btn.disabled = false;
      }
    };
    row.append(btn);
    el.append(row);
  }
}

async function refreshSeats() {
  const list = await j("GET", "/api/seats");
  const el = document.getElementById("seats");
  el.replaceChildren();
  if (list.length === 0) {
    el.textContent = "还没有席位。";
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = "<tr><th>Agent</th><th>房间</th><th>地址</th><th>状态</th><th></th></tr>";
  for (const s of list) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + s.agentKey + "</td><td>" + s.roomName + "</td>" +
      "<td><code>" + s.xmtpAddress.slice(0, 10) + "…</code></td>" +
      "<td>" + statusBadge(s.status) + (s.lastError ? '<div class="err-text">' + s.lastError + "</div>" : "") + "</td>";
    const td = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "退出";
    btn.onclick = async () => {
      if (!confirm("把这个 Agent 从房间里退出？它的本机密钥会被删除。")) return;
      try {
        await j("DELETE", "/api/seats/" + encodeURIComponent(s.seatId));
        refreshSeats();
      } catch (e) {
        alert("退出失败：" + e.message);
      }
    };
    td.append(btn);
    tr.append(td);
    table.append(tr);
  }
  el.append(table);
}

async function doPair(code) {
  document.getElementById("pair-msg").textContent = "配对中…";
  try {
    const res = await j("POST", "/api/pair", { code });
    document.getElementById("pair-msg").textContent = "";
    await refreshStatus();
    await refreshRooms();
    await refreshAgents();
    await refreshSeats();
  } catch (e) {
    document.getElementById("pair-msg").textContent = "配对失败：" + e.message;
  }
}

async function joinTicket(ticket, agentKey) {
  try {
    await j("POST", "/api/seats", { via: "ticket", ticket, agent_key: agentKey });
  } catch (e) {
    alert("加入失败：" + e.message);
  }
}

function consumeHash() {
  // 网站把配对码/票据放在地址 # 后面跳转过来（浏览器拦截 fetch 时的后备通道）。
  // 读完立刻清掉地址栏：这些是一次性凭证，不该留在历史记录里。
  const h = location.hash || "";
  if (h.length <= 1) return;
  const params = new URLSearchParams(h.slice(1));
  const pairCode = params.get("pair");
  const ticket = params.get("ticket");
  const agent = params.get("agent");
  history.replaceState({}, "", location.pathname);
  if (pairCode) {
    doPair(pairCode);
  } else if (ticket && agent) {
    joinTicket(ticket, agent);
  }
}

document.getElementById("pair-btn").onclick = () => doPair(document.getElementById("pair-code").value.trim());
document.getElementById("rescan-btn").onclick = async () => {
  await j("POST", "/api/agents/rescan");
  refreshAgents();
};
document.getElementById("m-kind").onchange = (ev) => {
  const kind = ev.target.value;
  document.getElementById("m-openai").style.display = kind === "openai-compatible" ? "" : "none";
  document.getElementById("m-webhook").style.display = kind === "webhook" ? "" : "none";
};
document.getElementById("m-add").onclick = async () => {
  const kind = document.getElementById("m-kind").value;
  const body = { kind, displayName: document.getElementById("m-name").value.trim() };
  if (kind === "openai-compatible") {
    body.baseUrl = document.getElementById("m-base").value.trim();
    body.model = document.getElementById("m-model").value.trim();
    body.apiKey = document.getElementById("m-key").value.trim();
  } else {
    body.url = document.getElementById("m-url").value.trim();
    body.secret = document.getElementById("m-secret").value.trim();
  }
  try {
    await j("POST", "/api/agents/manual", body);
    document.getElementById("m-msg").textContent = "已添加";
    refreshAgents();
  } catch (e) {
    document.getElementById("m-msg").textContent = "添加失败：" + e.message;
  }
};

(async () => {
  try {
    await refreshStatus();
    consumeHash();
    if (paired) {
      await refreshRooms();
      await refreshAgents();
      await refreshSeats();
    }
  } catch (e) {
    document.getElementById("status").textContent = "本机助手异常：" + e.message;
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
      if (method === "POST" && url.pathname === "/api/seats") {
        send(200, await handleCreateSeat(deps, body));
        return;
      }
      const del = url.pathname.match(/^\/api\/seats\/([^/]+)$/);
      if (method === "DELETE" && del) {
        const seatId = decodeURIComponent(del[1]);
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
