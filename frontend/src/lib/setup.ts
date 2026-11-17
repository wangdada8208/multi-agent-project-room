import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { xmtpEnvFromVite } from "./xmtpEnv";

export interface WorkerCredentials {
  /** 成员进程的 XMTP 钱包私钥，只写入用户本机的 .env */
  walletKey: string;
  /** XMTP 本地库加密密钥 */
  dbKey: string;
  /** 由 walletKey 推导出的以太坊地址，加入加密群时用作成员标识 */
  workerAddress: string;
}

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 在浏览器里生成成员进程所需的密钥，地址可提前推导出来用于建群邀请。 */
export function generateWorkerCredentials(): WorkerCredentials {
  const walletKey = generatePrivateKey();
  return {
    walletKey,
    dbKey: randomHex32(),
    workerAddress: privateKeyToAccount(walletKey as `0x${string}`).address,
  };
}

const CREDS_KEY_PREFIX = "mapr-setup-creds:";

/**
 * 同一房间复用同一份密钥：刷新或重跑向导时，.env 与已邀请进群的地址保持一致。
 * 只存 sessionStorage（当前标签页），不落盘到 localStorage。
 */
export function getOrCreateWorkerCredentials(roomId: string): WorkerCredentials {
  const key = CREDS_KEY_PREFIX + roomId;
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as WorkerCredentials;
      if (parsed.walletKey && parsed.dbKey && parsed.workerAddress) return parsed;
    }
  } catch { /* 解析失败则重新生成 */ }
  const fresh = generateWorkerCredentials();
  try {
    sessionStorage.setItem(key, JSON.stringify(fresh));
  } catch { /* 存储失败不阻塞流程 */ }
  return fresh;
}

export interface MemberEnvInput {
  agentName: string;
  myAddress: string;
  roomId: string;
  groupId: string;
  hubBaseUrl: string;
  hubToken: string;
  credentials: WorkerCredentials;
}

/** 生成可直接放进 workers/xmtp-member/.env 的内容。 */
export function buildMemberEnv(input: MemberEnvInput): string {
  const xmtpEnv = xmtpEnvFromVite(import.meta.env.VITE_XMTP_ENV as string | undefined);
  return [
    "# Multi-Agent Project Room — 成员进程配置（网页一键生成）",
    `XMTP_SELF_NAME=${input.agentName}`,
    `XMTP_ENV=${xmtpEnv}`,
    `XMTP_WALLET_KEY=${input.credentials.walletKey}`,
    `XMTP_DB_ENCRYPTION_KEY=${input.credentials.dbKey}`,
    `XMTP_ALLOWED_SENDERS=${input.myAddress}`,
    `XMTP_GROUP_ID=${input.groupId}`,
    `HUB_BASE_URL=${input.hubBaseUrl}`,
    `HUB_ROOM_ID=${input.roomId}`,
    `HUB_TOKEN=${input.hubToken}`,
    "OWNER_NOTES_PORT=8787",
    "# 在下面填入你的模型服务密钥（必填，用于让 Agent 实际回复）",
    "MEMBER_MODEL_API_KEY=",
    "# MEMBER_MODEL_URL=",
    "",
  ].join("\n");
}

/** 成员进程的运行命令（假设用户已拿到本仓库代码）。 */
export function buildMemberCommands(): string[] {
  return [
    "cd multi-agent-project-room/workers/xmtp-member",
    "npm install",
    "# 把下载的 .env 文件放进这个目录",
    "npm start",
  ];
}

/** 轮询本机成员进程是否已启动（owner-notes HTTP 服务）。 */
export async function memberProcessAlive(port = 8787): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/owner-notes`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}
