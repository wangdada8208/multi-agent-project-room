#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseUpArgs, runHelper, DEFAULT_HUB_ORIGIN } from "./helper/up.ts";
import { defaultPolicy, normalizePolicy, type Policy } from "./policy.ts";
import { isHardForbiddenScope } from "./rulesEngine.ts";
import { joinHubCall, parseInviteInput, signedProof } from "./inviteRegistration.ts";
import { runBridgeCommand } from "./bot-bridge.ts";
import { writeJsonSecure } from "./secureFile.ts";
import { authorizeMcpSend } from "./mcp.ts";
import { SEAT_ID_RE } from "./helper/seats.ts";
import { recordPairingKeys } from "./pairingCredentials.ts";

export interface CliIO {
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

export type CliOutputMode = "human" | "json";

const CLI_HELP = `Parlor mapr 命令行

用法:
  mapr <命令> [参数]

命令:
  up                 启动本机助手
  join               用邀请链接接入云端助手席位
  bridge             把本机助手桥接进房间
  mcp-approve-send   审批一次工具发送请求
  identity create    创建本机身份
  start              用 .env 启动成员进程
  request            发起一次授权请求
  consents           查看待批准请求
  approve / deny     批准或拒绝请求
  task               给房间里的助手派任务

可复制示例:
  mapr up --hub https://hub.wangdada8208.xyz --pair mpc_xxx
  mapr join "https://hub.wangdada8208.xyz/rooms/room-id?invite=token" --state-dir .
  mapr bridge --invite "https://hub.wangdada8208.xyz/rooms/room-id?invite=token" --exec "claude"
  mapr mcp-approve-send --seat seat-id --room room-id --text "允许发送这条消息"

机器模式:
  在命令中加 --json，或设置 MAPR_JSON=1。机器模式只输出结构化 JSON。
`;

type JoinFailureKind = "invite_required" | "invite_invalid" | "network" | "pending" | "denied" | "registration_failed";

const JOIN_FAILURE_COPY: Record<JoinFailureKind, { title: string; next: string }> = {
  invite_required: {
    title: "邀请链接缺失",
    next: "从 Parlor 房间重新复制完整邀请链接，然后运行：mapr join \"粘贴邀请链接\"",
  },
  invite_invalid: {
    title: "链接已过期或失效",
    next: "请房主重新生成邀请链接。拿到新链接后，重新运行同一条 mapr join 命令。",
  },
  network: {
    title: "网络连不上",
    next: "检查电脑是否联网，确认 Parlor 服务器地址正确，然后重新运行同一条命令。",
  },
  pending: {
    title: "等待房主审批",
    next: "房主还没有批准。请房主在 Parlor 里批准；批准后，这个命令会自动继续。",
  },
  denied: {
    title: "房主没有批准这次加入",
    next: "请联系房主确认。若仍要加入，请房主重新生成邀请链接后再试。",
  },
  registration_failed: {
    title: "注册没有完成",
    next: "请复制这条错误和刚才运行的命令，发给 Parlor 房间的主人排查。",
  },
};

function joinFailureText(kind: JoinFailureKind, detail = ""): string {
  const copy = JOIN_FAILURE_COPY[kind];
  const lines = [copy.title, `下一步：${copy.next}`];
  if (detail && kind === "registration_failed") lines.push(`细节：${detail}`);
  return lines.join("\n");
}

function writeJoinFailure(
  io: CliIO,
  mode: CliOutputMode,
  kind: JoinFailureKind,
  payload: Record<string, unknown>,
  detail = ""
): void {
  if (mode === "json") {
    io.stderr(JSON.stringify(payload));
  } else {
    io.stderr(joinFailureText(kind, detail));
  }
}

function classifyJoinHttpStatus(status: number): JoinFailureKind {
  if (status === 0) return "network";
  if (status === 404 || status === 410) return "invite_invalid";
  if (status === 409) return "denied";
  return "registration_failed";
}

function classifyJoinReason(reason: string): JoinFailureKind {
  if (reason === "invite_required") return "invite_required";
  if (reason === "invite_token_not_found" || reason === "invalid_invite_url") return "invite_invalid";
  const nonceFailure = reason.match(/^nonce_failed:(\d+)$/);
  if (nonceFailure) return classifyJoinHttpStatus(Number(nonceFailure[1]));
  return "registration_failed";
}

function splitJsonMode(args: string[], env: NodeJS.ProcessEnv = process.env): { args: string[]; mode: CliOutputMode } {
  const filtered: string[] = [];
  let jsonFlag = false;
  for (const arg of args) {
    if (arg === "--json") {
      jsonFlag = true;
    } else {
      filtered.push(arg);
    }
  }
  return { args: filtered, mode: jsonFlag || env.MAPR_JSON === "1" ? "json" : "human" };
}

function writeUsageFailure(command: string, mode: CliOutputMode, io: CliIO): number {
  if (mode === "json") {
    io.stderr(JSON.stringify({ ok: false, reason: "unknown_command", command }));
    return 1;
  }
  const prefix = command ? `不认识命令 "${command}"。` : "缺少命令。";
  io.stderr(`${prefix}\n\n${CLI_HELP}`);
  return 1;
}

function parseArgs(args: string[]): { command: string; subCommand?: string; flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let i = 0;
  const command = args[i++] || "";
  let subCommand: string | undefined;

  if (command === "identity" && args[i] === "create") {
    subCommand = args[i++];
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = key === "cap" && flags.cap ? `${flags.cap},${next}` : next;
        i += 2;
      } else {
        flags[key] = "true";
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { command, subCommand, flags, positional };
}

// ── mapr join：云端 Agent 持邀请链接自助注册（WP6） ──

async function readEnvVars(file: string): Promise<Map<string, string>> {
  const vars = new Map<string, string>();
  try {
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      vars.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
    }
  } catch {
    // 没有 .env 就当空表，后面补齐。
  }
  return vars;
}

const JOIN_ENV_ORDER = [
  "XMTP_WALLET_KEY",
  "XMTP_DB_ENCRYPTION_KEY",
  "XMTP_ENV",
  "XMTP_GROUP_ID",
  "XMTP_ALLOW_GROUP_MEMBERS",
  "HUB_BASE_URL",
  "HUB_ROOM_ID",
  "HUB_TOKEN",
  "MAPR_HUB_URL",
  "MAPR_SEAT_ID",
  "MAPR_AGENT_TOKEN",
];

/** .env 原子重写（0600）：含私钥与 agent_token，权限与原子性与 seat.json 同一标准。 */
async function writeEnvVars(file: string, vars: Map<string, string>): Promise<void> {
  const keys = [
    ...JOIN_ENV_ORDER.filter((k) => vars.has(k)),
    ...[...vars.keys()].filter((k) => !JOIN_ENV_ORDER.includes(k)),
  ];
  const content = keys.map((k) => `${k}=${vars.get(k)}`).join("\n") + "\n";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export interface JoinDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `mapr join <invite-url-or-token> [--hub <url>] [--name <name>] [--state-dir <dir>]
 *              [--wait <seconds>] [--poll <ms>]`
 *
 * 流程：本地 XMTP 钱包（有则复用）→ 服务器 nonce → EIP-191 签名 →
 * POST agent-register；需要主人审批时（pending）用同样的签名 GET 轮询，
 * 直到 consumed 或 --wait 到期。成功后落盘 .env（0600）与 .state/policy.json（0600）。
 * 任何输出/错误都不含私钥、签名、令牌或 Hub 响应正文。
 */
export async function joinWithInvite(
  invite: string,
  flags: Record<string, string>,
  io: CliIO,
  deps: JoinDeps = {},
  outputMode: CliOutputMode = "json"
): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const { token, origin } = parseInviteInput(invite);
  const hubOrigin = (
    flags.hub || origin || process.env.MAPR_HUB_URL || process.env.MAPR_HUB_ORIGIN || DEFAULT_HUB_ORIGIN
  )
    .trim()
    .replace(/\/+$/, "");
  const dir = (flags["state-dir"] || ".").trim();
  const displayName = (flags.name || "").trim() || undefined;
  const waitSec = Math.max(0, Number(flags.wait ?? "600") || 0);
  const pollMs = Math.max(50, Number(flags.poll ?? "5000") || 50);

  // 1. 本机 XMTP 身份：.env 已有 XMTP_WALLET_KEY 就复用，没有就生成；私钥绝不打印。
  const envFile = path.join(dir, ".env");
  const vars = await readEnvVars(envFile);
  const generatedKeys: string[] = [];
  let walletKey = vars.get("XMTP_WALLET_KEY") ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(walletKey)) {
    walletKey = generatePrivateKey();
    vars.set("XMTP_WALLET_KEY", walletKey);
    generatedKeys.push("XMTP_WALLET_KEY");
  }
  if (!vars.get("XMTP_DB_ENCRYPTION_KEY")) {
    vars.set("XMTP_DB_ENCRYPTION_KEY", "0x" + randomBytes(32).toString("hex"));
    generatedKeys.push("XMTP_DB_ENCRYPTION_KEY");
  }
  if (!vars.get("XMTP_ENV")) vars.set("XMTP_ENV", "dev");
  const account = privateKeyToAccount(walletKey as `0x${string}`);
  const address = account.address.toLowerCase();

  // 2. 服务器一次性 nonce + EIP-191 签名注册；每次轮询都领新 nonce。
  const regPath = `/api/v1/invites/${encodeURIComponent(token)}/agent-register`;
  let res = await (async () => {
    const proof = await signedProof(fetchImpl, hubOrigin, token, account);
    return joinHubCall(fetchImpl, hubOrigin, regPath, {
      method: "POST",
      body: {
        xmtp_address: address,
        nonce: proof.nonce,
        signature: proof.signature,
        ...(displayName ? { display_name: displayName } : {}),
      },
    });
  })();

  // pending = 主人审批中：同样的签名 GET 轮询，直到出结果或 --wait 到期。
  if (outputMode === "human" && res.status === 200 && res.body?.status === "pending") {
    io.stderr(joinFailureText("pending"));
  }
  const deadline = Date.now() + waitSec * 1000;
  while (res.status === 200 && res.body?.status === "pending" && Date.now() < deadline) {
    await sleep(pollMs);
    const proof = await signedProof(fetchImpl, hubOrigin, token, account);
    res = await joinHubCall(fetchImpl, hubOrigin, regPath, {
      method: "GET",
      headers: {
        "X-MAPR-Address": address,
        "X-MAPR-Nonce": proof.nonce,
        "X-MAPR-Signature": proof.signature,
      },
    });
  }

  if (res.status !== 200) {
    // 失败只回 HTTP 状态码：Hub 422 会照抄请求字段，响应正文不回显。
    writeJoinFailure(
      io,
      outputMode,
      classifyJoinHttpStatus(res.status),
      { ok: false, reason: "register_failed", status: res.status },
      `HTTP ${res.status}`
    );
    return 1;
  }
  const body = res.body ?? {};
  const status = typeof body.status === "string" ? body.status : "";
  if (status === "pending") {
    io.stdout(JSON.stringify({ ok: true, status: "pending", redemption_id: body.redemption_id ?? null, address }));
    return 0;
  }
  if (status !== "consumed" && status !== "approved") {
    writeJoinFailure(
      io,
      outputMode,
      "registration_failed",
      { ok: false, reason: "registration_not_completed", status: status || "unknown" },
      `status=${status || "unknown"}`
    );
    return 1;
  }
  const agentToken = typeof body.agent_token === "string" ? body.agent_token : "";
  const seatId = typeof body.seat_id === "string" ? body.seat_id : "";
  const roomId = typeof body.room_id === "string" ? body.room_id : "";
  if (!agentToken || !seatId) {
    writeJoinFailure(io, outputMode, "registration_failed", { ok: false, reason: "incomplete_registration" });
    return 1;
  }

  // 3. 落盘 .env（0600）：成员进程要的 XMTP_* + HUB_*，加云端席位自查用的 MAPR_*。
  vars.set("HUB_BASE_URL", hubOrigin);
  vars.set("HUB_ROOM_ID", roomId);
  vars.set("HUB_TOKEN", agentToken);
  vars.set("MAPR_HUB_URL", hubOrigin);
  vars.set("MAPR_SEAT_ID", seatId);
  vars.set("MAPR_AGENT_TOKEN", agentToken);
  if (typeof body.xmtp_group_id === "string" && body.xmtp_group_id) {
    vars.set("XMTP_GROUP_ID", body.xmtp_group_id);
  }
  // 云端席位没有 helper 下发 allowed_senders；群成员名单就是信任边界。
  vars.set("XMTP_ALLOW_GROUP_MEMBERS", "1");
  await writeEnvVars(envFile, vars);
  await recordPairingKeys(path.join(dir, ".state"), seatId, vars, generatedKeys);

  // 4. .state/policy.json（0600）：approved_scopes 滤掉硬禁区后写成本机 actor 建议（一律 ask）。
  const approved = (Array.isArray(body.approved_scopes) ? body.approved_scopes : [])
    .filter((s): s is string => typeof s === "string")
    .filter((s) => !isHardForbiddenScope(s));
  const policyFile = path.join(dir, ".state", "policy.json");
  let policy: Policy;
  try {
    policy = normalizePolicy(JSON.parse(await readFile(policyFile, "utf8")));
  } catch {
    policy = defaultPolicy();
  }
  const rules = policy.rules ?? { house: {}, actors: {} };
  const actorRules = (rules.actors[address] ??= {});
  for (const scope of approved) {
    if (!(scope in actorRules)) actorRules[scope] = "ask"; // 建议只填空；本机已有裁决永远优先。
  }
  policy.rules = rules;
  await writeJsonSecure(policyFile, policy);

  io.stdout(JSON.stringify({ ok: true, status: "consumed", seat_id: seatId, room_id: roomId, address }));
  return 0;
}

export async function runCli(args: string[], io: CliIO = { stdout: (m) => console.log(m), stderr: (m) => console.error(m) }): Promise<number> {
  const { args: cliArgs, mode } = splitJsonMode(args);
  if (cliArgs[0] === "bridge") return runBridgeCommand(cliArgs.slice(1), io);
  if (cliArgs[0] === "--help" || cliArgs[0] === "-h" || cliArgs[0] === "help") {
    io.stdout(CLI_HELP);
    return 0;
  }
  const { command, subCommand, flags, positional } = parseArgs(cliArgs);
  const port = flags.port || process.env.OWNER_NOTES_PORT || "8787";

  try {
    if (!command) return writeUsageFailure("", mode, io);

    if (command === "identity" && subCommand === "create") {
      const dir = flags.dir || ".";
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      const dbKey = "0x" + randomBytes(32).toString("hex");

      const envContent = [
        `XMTP_WALLET_KEY=${key}`,
        `XMTP_DB_ENCRYPTION_KEY=${dbKey}`,
        `XMTP_ENV=dev`,
        "",
      ].join("\n");

      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, ".env"), envContent, { encoding: "utf8", mode: 0o600, flag: "wx" });

      io.stdout(JSON.stringify({ address: account.address.toLowerCase() }));
      return 0;
    }

    if (command === "start") {
      const envFile = flags.env || ".env";
      const indexPath = path.resolve(import.meta.dirname, "index.ts");
      const child = spawn(process.execPath, ["--env-file=" + envFile, "--experimental-strip-types", indexPath], {
        stdio: "inherit",
      });
      return new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 0));
      });
    }

    if (command === "request") {
      const to = flags.to || "";
      const scope = flags.scope || "calendar.free_busy";
      const date_from = flags.from || "";
      const date_to = flags["to-date"] || "";
      const purpose = flags.purpose || "";

      const res = await fetch(`http://127.0.0.1:${port}/api/requests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MAPR-Owner": "1",
        },
        body: JSON.stringify({ to, scope, date_from, date_to, purpose }),
      });
      const data = await res.json();
      io.stdout(JSON.stringify(data));
      return res.ok ? 0 : 1;
    }

    if (command === "consents") {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: {
          "X-MAPR-Owner": "1",
        },
      });
      const data = (await res.json()) as any;
      io.stdout(JSON.stringify(data.consents || []));
      return res.ok ? 0 : 1;
    }

    if (command === "approve") {
      const id = positional[0] || flags.id || "";
      const res = await fetch(`http://127.0.0.1:${port}/api/consents/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: {
          "X-MAPR-Owner": "1",
        },
      });
      const data = await res.json();
      io.stdout(JSON.stringify(data));
      return res.ok ? 0 : 1;
    }

    if (command === "deny") {
      const id = positional[0] || flags.id || "";
      const res = await fetch(`http://127.0.0.1:${port}/api/consents/${encodeURIComponent(id)}/deny`, {
        method: "POST",
        headers: {
          "X-MAPR-Owner": "1",
        },
      });
      const data = await res.json();
      io.stdout(JSON.stringify(data));
      return res.ok ? 0 : 1;
    }

    if (command === "task") {
      const to = flags.to || "";
      const goal = flags.goal || "";
      const acceptanceRaw = flags.acceptance || "";
      const acceptance = acceptanceRaw.split(",").map((s) => s.trim()).filter(Boolean);

      const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MAPR-Owner": "1",
        },
        body: JSON.stringify({ to, goal, acceptance }),
      });
      const data = await res.json();
      io.stdout(JSON.stringify(data));
      return res.ok ? 0 : 1;
    }

    if (command === "join") {
      const invite = positional[0] || "";
      if (!invite) {
        writeJoinFailure(io, mode, "invite_required", { ok: false, reason: "invite_required" });
        return 1;
      }
      return await joinWithInvite(invite, flags, io, {}, mode);
    }

    if (command === "up") {
      // 本机助手是长驻进程：runHelper 直到收到 SIGINT/SIGTERM 才返回。
      const options = parseUpArgs(flags, process.env, os.homedir());
      io.stdout(JSON.stringify({ ok: true, helper: "starting", hub: options.hubOrigin, dir: options.rootDir }));
      return await runHelper(options);
    }

    if (command === "mcp-approve-send") {
      const root = flags.dir || process.env.MAPR_DIR || path.join(os.homedir(), ".mapr");
      const seat = flags.seat || "";
      if (!SEAT_ID_RE.test(seat) || !flags.room || !flags.text) {
        io.stderr("Usage: mapr mcp-approve-send --seat ID --room ID --text TEXT");
        return 1;
      }
      const dir = path.join(root, "seats", seat, "state");
      const approval = await authorizeMcpSend(dir, flags.room, flags.text).catch(() => {
        throw new Error("invalid_send_approval");
      });
      io.stdout(JSON.stringify({ approval }));
      return 0;
    }

    return writeUsageFailure(command, mode, io);
  } catch (err: any) {
    const reason = err?.message || "error";
    if (command === "join" && mode === "human") {
      io.stderr(joinFailureText(classifyJoinReason(reason), reason));
    } else {
      io.stderr(JSON.stringify({ ok: false, reason }));
    }
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
