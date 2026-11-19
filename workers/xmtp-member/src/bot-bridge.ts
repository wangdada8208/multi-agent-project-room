#!/usr/bin/env node
/**
 * mapr-bot-bridge：云端机器人进加密房间的桥。
 *
 * Grok Bot、Muse 这类常驻云 Agent 没有可调用的 API——它们进出房间的方式和
 * 受邀的人类协作者一样：核销房间邀请令牌 → 房主客户端把它的 XMTP 地址拉进
 * 加密群 → 它作为群成员收发消息。本脚本就是跑在机器人那台云电脑上的成员端。
 *
 * 用法：
 *   node src/bot-bridge.ts --invite <邀请令牌> [--hub <Hub地址>]
 *                          [--name Grokbot] [--state-dir <目录>]
 *                          [--exec '<回复命令>'] [--env production|dev|local]
 *   node src/bot-bridge.ts --group <群id>    # 已是群成员时跳过核销
 *
 * 收发三种通道（可叠加）：
 *   1. mailbox 文件：群消息追加到 mailbox/inbound.jsonl；把一行文本写进
 *      mailbox/outbox/任意名.txt 即发到群里（发完移入 sent/）。云 Agent 用
 *      读写文件的方式聊天，最稳。
 *   2. stdin/stdout：打到 stdin 的每一行发到群里；群消息也打印到 stdout。
 *   3. --exec '<cmd>'：每条群消息以 stdin 喂给该命令（sh -c），stdout 当回复。
 *
 * 密钥只留在 state-dir（0700）：identity.json（0600）里是 XMTP 钱包私钥与
 * 本地库密钥，不进 Hub、不进日志。
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";
import { generatePrivateKey } from "viem/accounts";

const DEFAULT_HUB = "https://hub.wangdada8208.xyz";
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".mapr-bot");
const GROUP_WAIT_MS = 30 * 60 * 1000;
const EXEC_TIMEOUT_MS = 300_000;
const MAX_REPLY_BYTES = 64 * 1024;

export interface BridgeArgs {
  hub: string;
  invite?: string;
  group?: string;
  name: string;
  stateDir: string;
  exec?: string;
  env: "production" | "dev" | "local";
  pollMs: number;
}

function usage(exitCode: number): never {
  console.error(`用法: bot-bridge --invite <令牌> [--hub <地址>] [--name <名>] [--state-dir <目录>] [--exec '<命令>'] [--env production|dev|local]
       bot-bridge --group <群id>   （已在群里，跳过核销）`);
  process.exit(exitCode);
}

export function parseBridgeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): BridgeArgs {
  const args: BridgeArgs = {
    hub: (env.MAPR_HUB_ORIGIN || DEFAULT_HUB).replace(/\/+$/, ""),
    name: "bot",
    stateDir: DEFAULT_STATE_DIR,
    env: "production",
    pollMs: 5000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(2);
      return v;
    };
    switch (a) {
      case "--hub": args.hub = next().replace(/\/+$/, ""); break;
      case "--invite": args.invite = next().trim(); break;
      case "--group": args.group = next().trim(); break;
      case "--name": args.name = next().trim().slice(0, 64) || "bot"; break;
      case "--state-dir": args.stateDir = next(); break;
      case "--exec": args.exec = next(); break;
      case "--env": {
        const v = next();
        if (v !== "production" && v !== "dev" && v !== "local") usage(2);
        args.env = v;
        break;
      }
      case "--poll-ms": args.pollMs = Math.max(1000, parseInt(next(), 10) || 5000); break;
      case "-h": case "--help": usage(0);
      default: usage(2);
    }
  }
  if (!args.invite && !args.group) usage(2);
  if (args.env === "local") args.env = "dev";
  return args;
}

interface BridgeIdentity {
  walletKey: `0x${string}`;
  dbEncryptionKey: `0x${string}`;
}

/** 读或生成 XMTP 身份（钱包私钥 + 本地库密钥），文件 0600，只在 state-dir 里。 */
async function loadOrCreateIdentity(stateDir: string): Promise<BridgeIdentity> {
  const file = path.join(stateDir, "identity.json");
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as BridgeIdentity;
    if (typeof j?.walletKey === "string" && typeof j?.dbEncryptionKey === "string") return j;
  } catch { /* 首次运行 */ }
  const id: BridgeIdentity = {
    walletKey: generatePrivateKey(),
    dbEncryptionKey: generatePrivateKey(),
  };
  await writeFile(file, JSON.stringify(id), { encoding: "utf8", mode: 0o600 });
  return id;
}

export function formatInboundLine(sender: string, text: string, ts: string): string {
  return JSON.stringify({ ts, sender, text });
}

/** 核销邀请令牌：提交本桥 XMTP 地址，拿回群 id。 */
async function redeemInvite(hub: string, token: string, address: string): Promise<string> {
  const res = await fetch(`${hub}/api/v1/invites/${encodeURIComponent(token)}/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xmtp_address: address }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    detail?: string;
    xmtp_group_id?: string | null;
    room_id?: string;
  };
  if (!res.ok) throw new Error(`核销邀请失败（${res.status}）：${body.detail ?? res.statusText}`);
  if (!body.xmtp_group_id) {
    // 群还没建：房间第一个席位建群后再来一次，或先用 --group 直接进群。
    throw new Error("邀请已核销，但房间还没有加密群；请稍后重试或改用 --group <群id>");
  }
  console.log(`[bot-bridge] invite redeemed, room ${body.room_id}, group ${body.xmtp_group_id}`);
  return body.xmtp_group_id;
}

/** 等房主客户端把本桥地址拉进群（核销后房主打开房间页时自动拉）。 */
async function waitForGroup(agent: Agent, groupId: string, pollMs: number, selfAddress: string): Promise<void> {
  const deadline = Date.now() + GROUP_WAIT_MS;
  let hintPrinted = false;
  for (;;) {
    await agent.client.conversations.syncAll().catch(() => undefined);
    const convo = await agent.client.conversations.getConversationById(groupId).catch(() => undefined);
    if (convo) return;
    if (!hintPrinted) {
      hintPrinted = true;
      console.log(`[bot-bridge] 我的 XMTP 地址: ${selfAddress}`);
      console.log("[bot-bridge] 等待房主把我拉进加密群（房主打开房间页时自动完成，通常几秒）…");
    }
    if (Date.now() > deadline) throw new Error("等进群超时（30 分钟）；请房主打开房间页或确认邀请");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** --exec 回复通道：群消息喂给命令的 stdin，stdout 当回复。用户显式传入，故用 sh -c。 */
function execReply(cmd: string, text: string, senderAddress: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], {
      env: { ...process.env, MAPR_MESSAGE: text, MAPR_SENDER_ADDRESS: senderAddress },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_MS,
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      if (out.length < MAX_REPLY_BYTES) out += c.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() || null : null));
    child.stdin?.end(text);
  });
}

export async function runBridge(args: BridgeArgs): Promise<void> {
  await mkdir(args.stateDir, { recursive: true, mode: 0o700 });
  const id = await loadOrCreateIdentity(args.stateDir);
  const mailboxDir = path.join(args.stateDir, "mailbox");
  const outboxDir = path.join(mailboxDir, "outbox");
  const sentDir = path.join(mailboxDir, "sent");
  await mkdir(outboxDir, { recursive: true, mode: 0o700 });
  await mkdir(sentDir, { recursive: true, mode: 0o700 });
  const inboundFile = path.join(mailboxDir, "inbound.jsonl");

  const agent = await Agent.create(createSigner(createUser(id.walletKey)), {
    env: args.env,
    dbPath: path.join(args.stateDir, "xmtp"),
    dbEncryptionKey: id.dbEncryptionKey,
  });
  const selfAddress = (agent.address || "").toLowerCase();
  console.log(`[bot-bridge] ${args.name} 上线，XMTP 地址 ${selfAddress}`);

  const groupId = args.group ?? (await redeemInvite(args.hub, args.invite!, selfAddress));
  await agent.start();
  await waitForGroup(agent, groupId, args.pollMs, selfAddress);
  console.log(`[bot-bridge] 已进群 ${groupId}，开始收发`);

  const sendText = async (text: string): Promise<void> => {
    const body = text.trim();
    if (!body) return;
    const ctx = await agent.getConversationContext(groupId);
    if (!ctx?.conversation) throw new Error("群会话不可用");
    await ctx.conversation.sendText(body);
  };

  agent.on("text", async (ctx: { conversation?: { id?: string }; getSenderAddress?: () => Promise<string | undefined>; message?: { content?: unknown } }) => {
    try {
      if (ctx.conversation?.id !== groupId) return;
      const sender = ((await ctx.getSenderAddress?.()) || "").toLowerCase();
      if (sender && sender === selfAddress) return;
      const content = ctx.message?.content;
      const text = typeof content === "string" ? content : (content as { text?: string })?.text ?? "";
      if (!text) return;
      const line = formatInboundLine(sender, text, new Date().toISOString());
      await appendFile(inboundFile, line + "\n", "utf8");
      console.log(`<<< ${sender || "unknown"}: ${text}`);
      if (args.exec) {
        const reply = await execReply(args.exec, text, sender);
        if (reply) await sendText(reply);
      }
    } catch (err) {
      console.error(`[bot-bridge] 处理消息失败: ${(err as Error).message}`);
    }
  });

  // mailbox outbox：文件名不限，文本内容即消息，发完移入 sent/。
  const flushOutbox = async () => {
    for (const f of await readdir(outboxDir).catch(() => [] as string[])) {
      if (!f.endsWith(".txt")) continue;
      const src = path.join(outboxDir, f);
      try {
        const text = await readFile(src, "utf8");
        if (text.trim()) await sendText(text);
        await rename(src, path.join(sentDir, `${Date.now()}-${f}`));
      } catch (err) {
        console.error(`[bot-bridge] 发送 ${f} 失败: ${(err as Error).message}`);
      }
    }
  };
  watch(outboxDir, () => void flushOutbox());
  setInterval(() => void flushOutbox(), 1500).unref();

  // stdin 一行一条消息（人操作终端或机器人写管道都能用）。
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    void sendText(line).catch((err) => console.error(`[bot-bridge] 发送失败: ${(err as Error).message}`));
  });

  console.log(`[bot-bridge] 发消息：往 ${outboxDir} 写一个 .txt 文件，或直接往 stdin 打一行`);
  console.log(`[bot-bridge] 收消息：${inboundFile} 或 stdout（<<< 前缀）`);

  process.on("SIGINT", () => void agent.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void agent.stop().then(() => process.exit(0)));
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]!).href === import.meta.url;
if (isMain) {
  const args = parseBridgeArgs(process.argv.slice(2));
  runBridge(args).catch((err) => {
    console.error(`[bot-bridge] ${(err as Error).message}`);
    process.exit(1);
  });
}
