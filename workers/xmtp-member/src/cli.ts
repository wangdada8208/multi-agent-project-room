#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { parseUpArgs, runHelper, DEFAULT_HUB_ORIGIN } from "./helper/up.ts";
import { defaultPolicy, normalizePolicy, type Policy } from "./policy.ts";
import { isHardForbiddenScope } from "./rulesEngine.ts";
import { writeJsonSecure } from "./secureFile.ts";

export interface CliIO {
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
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
        flags[key] = next;
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

const JOIN_REQUEST_TIMEOUT_MS = 15_000;

interface HubCallResult {
  status: number;
  body: Record<string, unknown> | null;
}

/** Hub JSON 调用，网络错误收敛为 status 0。 */
async function joinHubCall(
  fetchImpl: typeof fetch,
  base: string,
  apiPath: string,
  request: { method: "GET"; headers: HeadersInit } | { method: "POST"; body: unknown }
): Promise<HubCallResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}${apiPath}`, {
      method: request.method,
      headers: request.method === "POST" ? { "Content-Type": "application/json" } : request.headers,
      body: request.method === "POST" ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(JOIN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { status: 0, body: null };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const data = await res.json();
    if (data && typeof data === "object" && !Array.isArray(data)) parsed = data as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/** 邀请输入：完整 URL（/rooms/<id>?invite=<token> 或 /invite(s)/<token> 风格路径）或裸 token；URL 顺带给出 Hub 源站。 */
function parseInviteInput(raw: string): { token: string; origin: string | null } {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    const url = new URL(s);
    const token = (url.searchParams.get("invite") ?? url.searchParams.get("token") ?? "").trim();
    if (token) return { token, origin: url.origin };
    const m = url.pathname.match(/\/(invites?|join)\/([^/?#]+)/i);
    if (m?.[2]) return { token: decodeURIComponent(m[2]), origin: url.origin };
    throw new Error("invite_token_not_found");
  }
  if (!s) throw new Error("invite_required");
  return { token: s, origin: null };
}

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

/** 领一个服务器一次性 nonce，按后端返回的 message 原文做 EIP-191 签名。 */
async function signedProof(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  account: LocalAccount
): Promise<{ nonce: string; signature: string }> {
  const res = await joinHubCall(fetchImpl, base, "/api/v1/invites/nonce", {
    method: "POST",
    body: {
      action: "invite-agent-register",
      resource: token,
      address: account.address.toLowerCase(),
    },
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`nonce_failed:${res.status}`);
  const nonce = res.body?.nonce;
  const message = res.body?.message;
  if (typeof nonce !== "string" || !nonce || typeof message !== "string" || !message) {
    throw new Error("bad_nonce_response");
  }
  const signature = await account.signMessage({ message });
  return { nonce, signature };
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
  deps: JoinDeps = {}
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
  let walletKey = vars.get("XMTP_WALLET_KEY") ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(walletKey)) {
    walletKey = generatePrivateKey();
    vars.set("XMTP_WALLET_KEY", walletKey);
  }
  if (!vars.get("XMTP_DB_ENCRYPTION_KEY")) {
    vars.set("XMTP_DB_ENCRYPTION_KEY", "0x" + randomBytes(32).toString("hex"));
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
    io.stderr(JSON.stringify({ ok: false, reason: "register_failed", status: res.status }));
    return 1;
  }
  const body = res.body ?? {};
  const status = typeof body.status === "string" ? body.status : "";
  if (status === "pending") {
    io.stdout(JSON.stringify({ ok: true, status: "pending", redemption_id: body.redemption_id ?? null, address }));
    return 0;
  }
  if (status !== "consumed" && status !== "approved") {
    io.stderr(JSON.stringify({ ok: false, reason: "registration_not_completed", status: status || "unknown" }));
    return 1;
  }
  const agentToken = typeof body.agent_token === "string" ? body.agent_token : "";
  const seatId = typeof body.seat_id === "string" ? body.seat_id : "";
  const roomId = typeof body.room_id === "string" ? body.room_id : "";
  if (!agentToken || !seatId) {
    io.stderr(JSON.stringify({ ok: false, reason: "incomplete_registration" }));
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
  const { command, subCommand, flags, positional } = parseArgs(args);
  const port = flags.port || process.env.OWNER_NOTES_PORT || "8787";

  try {
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
        io.stderr(JSON.stringify({ ok: false, reason: "invite_required" }));
        return 1;
      }
      return await joinWithInvite(invite, flags, io);
    }

    if (command === "up") {
      // 本机助手是长驻进程：runHelper 直到收到 SIGINT/SIGTERM 才返回。
      const options = parseUpArgs(flags, process.env, os.homedir());
      io.stdout(JSON.stringify({ ok: true, helper: "starting", hub: options.hubOrigin, dir: options.rootDir }));
      return await runHelper(options);
    }

    io.stderr(JSON.stringify({ ok: false, reason: "unknown_command", command }));
    return 1;
  } catch (err: any) {
    io.stderr(JSON.stringify({ ok: false, reason: err.message || "error" }));
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
