#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";
import { generatePrivateKey, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { startCloudSeatPolling, type CloudSeatPoller } from "./helper/cloudSeat.ts";
import { joinHubCall, parseInviteInput, signedProof } from "./inviteRegistration.ts";
import { writeJsonSecure } from "./secureFile.ts";
import { trustFrame } from "./trustFrame.ts";

const DEFAULT_HUB = "https://hub.wangdada8208.xyz";
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".mapr-bot");
const GROUP_WAIT_MS = 30 * 60 * 1000;
const EXEC_TIMEOUT_MS = 300_000;
const MAX_REPLY_BYTES = 64 * 1024;
const WAKE_TIMEOUT_MS = 8000;
const USAGE = "用法: mapr bridge [--invite <邀请链接或令牌> | --group <群 ID>] [--hub <地址>] [--name <名>] [--state-dir <目录>] [--env dev|production|local] [--wait <秒>] [--poll-ms <毫秒>] [--exec <命令>] [--wake-url <URL>] [--wake-key-env <环境变量名>]";

type XmtpEnv = "dev" | "production" | "local";

export interface BridgeArgs {
  hub: string;
  hubOverride?: boolean;
  invite?: string;
  inviteRoom?: string;
  group?: string;
  name: string;
  stateDir: string;
  exec?: string;
  env: XmtpEnv;
  pollMs: number;
  waitSec: number;
  wakeUrl?: string;
  wakeKeyEnv?: string;
}

class BridgeError extends Error {}
class BridgeUsageError extends BridgeError {}

function isXmtpEnv(value: unknown): value is XmtpEnv {
  return value === "dev" || value === "production" || value === "local";
}

function hubOrigin(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") &&
        url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash) {
      return url.origin;
    }
  } catch { /* URL 解析错误可能含原始输入。 */ }
  throw new BridgeUsageError("Hub 地址必须是 HTTP(S) 源站");
}

function wakeUrl(value: string): string {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!url.username && !url.password &&
        (url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
      return url.href;
    }
  } catch { /* URL 解析错误可能含原始输入。 */ }
  throw new BridgeUsageError("--wake-url 必须使用 HTTPS 或本机回环 HTTP，且 URL 中不可含账号或密码");
}

export function parseBridgeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): BridgeArgs {
  let hub = env.MAPR_HUB_URL || env.MAPR_HUB_ORIGIN;
  let explicitHub: string | undefined;
  const args: BridgeArgs = {
    hub: DEFAULT_HUB,
    name: "bot",
    stateDir: DEFAULT_STATE_DIR,
    env: isXmtpEnv(env.XMTP_ENV) ? env.XMTP_ENV : "dev",
    pollMs: 5000,
    waitSec: 600,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new BridgeUsageError("参数缺少值");
      return value;
    };
    switch (argv[i]) {
      case "--hub": explicitHub = next(); break;
      case "--invite": {
        try {
          const input = next();
          const parsed = parseInviteInput(input);
          args.invite = parsed.token;
          if (parsed.origin) {
            hub = parsed.origin;
            const match = new URL(input.trim()).pathname.match(/^\/rooms\/([^/]+)\/?$/);
            if (match?.[1]) args.inviteRoom = decodeURIComponent(match[1]);
          }
        } catch {
          throw new BridgeUsageError("无效的邀请链接或令牌");
        }
        break;
      }
      case "--group":
        args.group = next().trim();
        if (!args.group) throw new BridgeUsageError("群 ID 不能为空");
        break;
      case "--name": args.name = next().trim().slice(0, 64) || "bot"; break;
      case "--state-dir": args.stateDir = next(); break;
      case "--exec": args.exec = next(); break;
      case "--env": {
        const value = next();
        if (!isXmtpEnv(value)) throw new BridgeUsageError("--env 必须为 dev、production 或 local");
        args.env = value;
        break;
      }
      case "--poll-ms": {
        const value = Number(next());
        if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
          throw new BridgeUsageError("--poll-ms 必须为正整数");
        }
        args.pollMs = Math.max(50, value);
        break;
      }
      case "--wait": {
        const value = Number(next());
        if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483) {
          throw new BridgeUsageError("--wait 必须为非负整数秒");
        }
        args.waitSec = value;
        break;
      }
      case "--wake-url": args.wakeUrl = wakeUrl(next()); break;
      case "--wake-key-env": {
        const name = next();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new BridgeUsageError("--wake-key-env 必须为环境变量名");
        }
        args.wakeKeyEnv = name;
        break;
      }
      default: throw new BridgeUsageError("未知参数");
    }
  }
  if (args.wakeKeyEnv && !args.wakeUrl) throw new BridgeUsageError("--wake-key-env 需要 --wake-url");
  args.hubOverride = Boolean(explicitHub || hub);
  args.hub = hubOrigin((explicitHub || hub || DEFAULT_HUB).trim());
  return args;
}

interface BridgeIdentity {
  walletKey: `0x${string}`;
  dbEncryptionKey: `0x${string}`;
}

interface BridgeSeat {
  hub_origin: string;
  room_id: string;
  seat_id: string;
  agent_user_id: string | null;
  agent_token: string;
  xmtp_address: string;
}

function isPrivateKey(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

async function readState(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return jsonObject(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new BridgeError("无法读取本机桥接状态");
  }
}

async function loadOrCreateIdentity(stateDir: string): Promise<BridgeIdentity> {
  const file = path.join(stateDir, "identity.json");
  const existing = await readState(file);
  if (existing) {
    const { walletKey, dbEncryptionKey } = existing;
    if (isPrivateKey(walletKey) && isPrivateKey(dbEncryptionKey)) return { walletKey, dbEncryptionKey };
    throw new BridgeError("本机 XMTP 身份无效");
  }
  const id = { walletKey: generatePrivateKey(), dbEncryptionKey: generatePrivateKey() };
  try {
    await writeFile(file, JSON.stringify(id), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return loadOrCreateIdentity(stateDir);
    }
    throw new BridgeError("无法保存本机 XMTP 身份");
  }
  return id;
}

function parseSeat(data: Record<string, unknown>, origin: string, address: string): BridgeSeat | undefined {
  const { room_id, seat_id, agent_token, agent_user_id } = data;
  if (typeof room_id !== "string" || !room_id || typeof seat_id !== "string" || !seat_id ||
      typeof agent_token !== "string" || !agent_token) return;
  return {
    hub_origin: origin,
    room_id,
    seat_id,
    agent_user_id: typeof agent_user_id === "string" ? agent_user_id : null,
    agent_token,
    xmtp_address: address,
  };
}

export function formatInboundLine(sender: string, text: string, ts: string): string {
  return JSON.stringify({ ts, sender, text });
}

async function registerInvite(
  args: BridgeArgs,
  token: string,
  account: LocalAccount,
  address: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  io: BridgeIO
): Promise<{ seat: BridgeSeat; groupId?: string }> {
  const regPath = `/api/v1/invites/${encodeURIComponent(token)}/agent-register`;
  const proof = async (requestSignal: AbortSignal) => {
    try {
      return await signedProof(fetchImpl, args.hub, token, account, requestSignal);
    } catch (error) {
      const status = error instanceof Error ? /^nonce_failed:(\d+)$/.exec(error.message)?.[1] : undefined;
      throw new BridgeError(status ? `申请邀请签名 nonce 失败（HTTP ${status}）` : "无法生成邀请签名");
    }
  };
  const initialProof = await proof(signal);
  let result = await joinHubCall(fetchImpl, args.hub, regPath, {
    method: "POST",
    body: { xmtp_address: address, ...initialProof, display_name: args.name },
  }, signal);

  if (result.status === 200 && result.body?.status === "pending") {
    io.stdout("[bot-bridge] 已提交注册，等待房主审批");
    const timeout = args.waitSec ? AbortSignal.timeout(args.waitSec * 1000) : undefined;
    const approvalSignal = timeout ? AbortSignal.any([signal, timeout]) : signal;
    try {
      while (result.status === 200 && result.body?.status === "pending") {
        await sleep(args.pollMs, undefined, { signal: approvalSignal });
        const current = await proof(approvalSignal);
        result = await joinHubCall(fetchImpl, args.hub, regPath, {
          method: "GET",
          headers: {
            "X-MAPR-Address": address,
            "X-MAPR-Nonce": current.nonce,
            "X-MAPR-Signature": current.signature,
          },
        }, approvalSignal);
        approvalSignal.throwIfAborted();
      }
    } catch (error) {
      if (timeout?.aborted) throw new BridgeError("等待房主审批超时");
      throw error;
    }
  }

  if (result.status !== 200) {
    const reason = result.status === 409 ? "邀请被拒绝、撤销或用尽"
      : result.status === 410 ? "邀请已过期或撤销"
      : result.status === 422 ? "邀请凭证或签名格式无效"
      : "注册邀请失败";
    throw new BridgeError(result.status ? `${reason}（HTTP ${result.status}）` : "无法连接 Hub 完成邀请注册");
  }
  const body = result.body ?? {};
  if (body.status !== "consumed" && body.status !== "approved") throw new BridgeError("Hub 未完成席位注册");
  const seat = parseSeat(body, args.hub, address);
  if (!seat) throw new BridgeError("Hub 返回的席位凭证不完整");
  const groupId = typeof body.xmtp_group_id === "string" ? body.xmtp_group_id || undefined : undefined;
  return { seat, groupId };
}

interface BridgeTextEvent {
  conversation?: { id?: string };
  getSenderAddress?: () => Promise<string | undefined>;
  message?: { content?: unknown; sentAt?: Date };
}

interface BridgeAgent {
  start(): Promise<void>;
  stop(): Promise<void>;
  syncGroup(groupId: string): Promise<boolean>;
  onText(handler: (event: BridgeTextEvent) => Promise<void>): void;
  sendText(groupId: string, text: string, signal: AbortSignal): Promise<void>;
}

async function createBridgeAgent(id: BridgeIdentity, args: BridgeArgs): Promise<BridgeAgent> {
  const agent = await Agent.create(createSigner(createUser(id.walletKey)), {
    env: args.env,
    dbPath: path.join(args.stateDir, "xmtp"),
    dbEncryptionKey: id.dbEncryptionKey,
  });
  return {
    start: () => agent.start(),
    stop: () => agent.stop(),
    async syncGroup(groupId) {
      await agent.client.conversations.syncAll();
      return Boolean(await agent.client.conversations.getConversationById(groupId));
    },
    onText: (handler) => { agent.on("text", handler); },
    async sendText(groupId, text, signal) {
      const ctx = await agent.getConversationContext(groupId);
      if (!ctx?.conversation) throw new BridgeError("群会话不可用");
      signal.throwIfAborted();
      await ctx.conversation.sendText(text);
    },
  };
}

/** --exec 由本机操作者配置；群消息只通过 stdin 和环境变量传给子进程。 */
function execReply(cmd: string, text: string, senderAddress: string, signal: AbortSignal, wakeKeyEnv?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const env = { ...process.env, MAPR_MESSAGE: text, MAPR_SENDER_ADDRESS: senderAddress };
    const child = spawn("sh", ["-c", cmd], {
      env: Object.fromEntries(Object.entries(env).filter(([name]) => name !== wakeKeyEnv)),
      stdio: ["pipe", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_MS,
      signal,
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < MAX_REPLY_BYTES) out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() || null : null));
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}

interface BridgeIO {
  stdout(message: string): void;
  stderr(message: string): void;
}

const consoleIO: BridgeIO = { stdout: (msg) => console.log(msg), stderr: (msg) => console.error(msg) };

interface BridgeDeps {
  fetchImpl?: typeof fetch;
  createAgent?: typeof createBridgeAgent;
  seatPollMs?: number;
  wakeTimeoutMs?: number;
  input?: NodeJS.ReadableStream;
}

export async function runBridge(args: BridgeArgs, io: BridgeIO = consoleIO, deps: BridgeDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const key = args.wakeKeyEnv ? process.env[args.wakeKeyEnv] : undefined;
  if (args.wakeKeyEnv && !key) throw new BridgeUsageError("唤醒密钥环境变量未设置或为空");

  const shutdown = new AbortController();
  const signal = shutdown.signal;
  const stop = () => shutdown.abort();
  const stopped = new Promise<undefined>((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  let activity: AbortController | undefined;
  let paused: boolean | undefined;
  let poller: CloudSeatPoller | undefined;
  let agent: BridgeAgent | undefined;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stdin: readline.Interface | undefined;
  let checkpoint = Promise.resolve();

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await mkdir(args.stateDir, { recursive: true, mode: 0o700 });
    const seatFile = path.join(args.stateDir, "seat.json");
    const saved = await readState(seatFile);
    if (!saved && !args.invite && !args.group) throw new BridgeUsageError("需要 --invite、--group 或已保存的席位");
    if (saved && !await readState(path.join(args.stateDir, "identity.json"))) {
      throw new BridgeError("已保存席位缺少本机 XMTP 身份");
    }
    const id = await loadOrCreateIdentity(args.stateDir);
    const account = privateKeyToAccount(id.walletKey);
    const address = account.address.toLowerCase();
    let seat: BridgeSeat | undefined;
    let groupId = args.group;
    if (saved) {
      const origin = typeof saved.hub_origin === "string" ? hubOrigin(saved.hub_origin) : args.hub;
      seat = parseSeat(saved, origin, address);
      if (!seat) throw new BridgeError("已保存席位凭证不完整");
      if ((args.hubOverride && args.hub !== origin) ||
          (args.inviteRoom && args.inviteRoom !== seat.room_id) ||
          (typeof saved.xmtp_address === "string" && saved.xmtp_address.toLowerCase() !== address)) {
        throw new BridgeError("已保存席位与当前 Hub、房间或 XMTP 身份不匹配，请指定其他 --state-dir");
      }
      // 已登记席位始终使用 Hub 绑定的群，防止状态目录被用于另一个群。
      groupId = undefined;
    } else if (!groupId && args.invite) {
      const registered = await registerInvite(args, args.invite, account, address, fetchImpl, signal, io);
      seat = registered.seat;
      groupId = registered.groupId;
      await writeJsonSecure(seatFile, seat);
      io.stdout("[bot-bridge] 云端席位注册成功");
    }
    signal.throwIfAborted();

    if (seat) {
      const currentSeat = seat;
      poller = startCloudSeatPolling({
        hubOrigin: currentSeat.hub_origin,
        seatId: currentSeat.seat_id,
        agentToken: currentSeat.agent_token,
        fetchImpl,
        intervalMs: deps.seatPollMs,
        renewToken: true,
        onToken: (token) => {
          if (token === currentSeat.agent_token) return;
          currentSeat.agent_token = token;
          checkpoint = writeJsonSecure(seatFile, currentSeat).catch(() => {
            io.stderr("[bot-bridge] 无法保存续约后的席位凭证");
          });
        },
        onPaused: (next) => {
          if (next) {
            io.stdout("[bot-bridge] 房主已暂停席位");
            activity?.abort();
            activity = undefined;
          } else {
            if (paused) io.stdout("[bot-bridge] 房主已恢复席位");
            activity = new AbortController();
          }
          paused = next;
        },
        onRemoved: () => {
          io.stdout("[bot-bridge] 席位已被移除，退群自停");
          stop();
        },
      });
      await poller.checkNow();
      signal.throwIfAborted();
      if (!groupId) io.stdout("[bot-bridge] 等待房主绑定加密群");
      const deadline = Date.now() + GROUP_WAIT_MS;
      while (!groupId) {
        const result = await joinHubCall(fetchImpl, currentSeat.hub_origin,
          `/api/v1/rooms/${encodeURIComponent(currentSeat.room_id)}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${currentSeat.agent_token}` },
          }, signal);
        if (result.status === 200) {
          const candidate = jsonObject(result.body?.room).xmtp_group_id;
          if (typeof candidate === "string" && candidate) groupId = candidate;
        }
        if (groupId) break;
        if (Date.now() >= deadline) throw new BridgeError("等待房主绑定加密群超时（30 分钟）");
        await sleep(args.pollMs, undefined, { signal });
        await poller.checkNow();
        signal.throwIfAborted();
      }
    } else {
      activity = new AbortController();
    }
    if (!groupId) throw new BridgeError("缺少加密群 ID");
    if (args.group && args.group !== groupId) throw new BridgeError("--group 与已保存席位的加密群不匹配");
    const roomGroup = groupId;

    const mailboxDir = path.join(args.stateDir, "mailbox");
    const outboxDir = path.join(mailboxDir, "outbox");
    const sentDir = path.join(mailboxDir, "sent");
    const inboundFile = path.join(mailboxDir, "inbound.jsonl");
    await mkdir(outboxDir, { recursive: true, mode: 0o700 });
    await mkdir(sentDir, { recursive: true, mode: 0o700 });
    signal.throwIfAborted();

    io.stdout(`[bot-bridge] 加密群已就绪，连接 XMTP（地址 ${address}）`);
    const client = await Promise.race([
      (deps.createAgent ?? createBridgeAgent)(id, args).then(async (created) => {
        if (signal.aborted) {
          await created.stop().catch(() => {});
          return;
        }
        agent = created;
        return created;
      }),
      stopped,
    ]);
    if (!client) return;
    const groupDeadline = Date.now() + GROUP_WAIT_MS;
    let hinted = false;
    while (!await Promise.race([client.syncGroup(roomGroup).catch(() => false), stopped])) {
      signal.throwIfAborted();
      if (!hinted) {
        io.stdout("[bot-bridge] 等待房主把我拉进加密群");
        hinted = true;
      }
      if (Date.now() >= groupDeadline) throw new BridgeError("等待加入加密群超时（30 分钟）");
      await sleep(args.pollMs, undefined, { signal });
    }
    signal.throwIfAborted();

    const send = async (text: string, active: AbortSignal): Promise<void> => {
      const body = text.trim();
      if (body && !active.aborted && !signal.aborted) await client.sendText(roomGroup, body, active);
    };

    client.onText(async (ctx) => {
      const active = activity?.signal;
      if (!active || signal.aborted || ctx.conversation?.id !== roomGroup) return;
      try {
        const sender = (await ctx.getSenderAddress?.())?.toLowerCase();
        if (!sender || sender === address || active.aborted || signal.aborted) return;
        const content = ctx.message?.content;
        const text = typeof content === "string" ? content : jsonObject(content).text;
        if (typeof text !== "string" || !text.trim()) return;
        const ts = (ctx.message?.sentAt ?? new Date()).toISOString();
        const frame = trustFrame(text, { sender, role: "unknown", roomId: seat?.room_id || roomGroup, sentAt: ts });
        await appendFile(inboundFile, formatInboundLine(sender, frame, ts) + "\n", { mode: 0o600 });
        if (active.aborted || signal.aborted) return;
        io.stdout(`<<< ${sender}: ${frame}`);
        if (args.wakeUrl) {
          const headers = new Headers({ "Content-Type": "application/json" });
          try {
            if (key) {
              headers.set("Authorization", `Bearer ${key}`);
              headers.set("X-Automation-Key", key);
            }
            const response = await fetchImpl(args.wakeUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({
                event: "mapr.message", name: args.name, room_group_id: roomGroup,
                sender, text: frame, ts, inbound_file: inboundFile, outbox_dir: outboxDir,
              }),
              redirect: "error",
              signal: AbortSignal.any([active, signal, AbortSignal.timeout(deps.wakeTimeoutMs ?? WAKE_TIMEOUT_MS)]),
            });
            await response.body?.cancel();
            if (!response.ok) io.stderr(`[bot-bridge] 唤醒请求失败（HTTP ${response.status}）`);
          } catch {
            if (!active.aborted && !signal.aborted) io.stderr("[bot-bridge] 唤醒请求失败或超时");
          }
        }
        if (args.exec && !active.aborted && !signal.aborted) {
          const reply = await execReply(args.exec, frame, sender, AbortSignal.any([active, signal]), args.wakeKeyEnv);
          if (reply) await send(reply, active);
        }
      } catch {
        if (!active.aborted && !signal.aborted) io.stderr("[bot-bridge] 处理群消息失败");
      }
    });
    await Promise.race([client.start(), stopped]);
    signal.throwIfAborted();
    io.stdout(`[bot-bridge] 已进群 ${roomGroup}，开始收发`);

    let flushing = false;
    const flushOutbox = async () => {
      const active = activity?.signal;
      if (flushing || !active || signal.aborted) return;
      flushing = true;
      try {
        for (const file of await readdir(outboxDir)) {
          if (active.aborted || signal.aborted) break;
          if (!file.endsWith(".txt")) continue;
          const src = path.join(outboxDir, file);
          try {
            const text = await readFile(src, "utf8");
            if (active.aborted || signal.aborted) break;
            await send(text, active);
            await rename(src, path.join(sentDir, `${Date.now()}-${file}`));
          } catch {
            if (!active.aborted && !signal.aborted) io.stderr("[bot-bridge] 发送发件箱消息失败");
          }
        }
      } catch {
        if (!signal.aborted) io.stderr("[bot-bridge] 读取发件箱失败");
      } finally {
        flushing = false;
      }
    };
    watcher = watch(outboxDir, () => void flushOutbox());
    watcher.on("error", () => io.stderr("[bot-bridge] 发件箱文件监视失败"));
    timer = setInterval(() => void flushOutbox(), 1500);
    void flushOutbox();
    stdin = readline.createInterface({ input: deps.input ?? process.stdin });
    stdin.on("line", (line) => {
      const active = activity?.signal;
      if (active) void send(line, active).catch(() => {
        if (!active.aborted && !signal.aborted) io.stderr("[bot-bridge] 发送失败");
      });
    });
    io.stdout(`[bot-bridge] 发消息：往 ${outboxDir} 写入 .txt 文件，或直接往 stdin 打一行`);
    io.stdout(`[bot-bridge] 收消息：${inboundFile} 或 stdout（<<< 前缀）`);
    await stopped;
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    stop();
    activity?.abort();
    poller?.stop();
    watcher?.close();
    clearInterval(timer);
    stdin?.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await agent?.stop().catch(() => io.stderr("[bot-bridge] 停止 XMTP 客户端失败"));
    await checkpoint;
  }
}

export async function runBridgeCommand(argv: string[], io: BridgeIO = consoleIO): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    io.stdout(USAGE);
    return 0;
  }
  try {
    await runBridge(parseBridgeArgs(argv), io);
    return 0;
  } catch (error) {
    io.stderr(`[bot-bridge] ${error instanceof BridgeError ? error.message : "桥接运行失败"}`);
    if (error instanceof BridgeUsageError) {
      io.stderr(USAGE);
      return 2;
    }
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runBridgeCommand(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
