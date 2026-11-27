import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, constants as fsConstants, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { activityEventId, buildSafeActivityEvent, isSignedLedgerCheckpoint, ledgerEntryStatus } from "../activity.ts";
import { isAllowedOpenAiBaseUrl, openAiCompatibleEngine, webhookEngine } from "../engines/httpEngines.ts";
import type { EngineConfig } from "../engines/types.ts";
import type { HubSafeActivityEvent } from "../hubContracts.generated.ts";
import { readLedger } from "../ledger.ts";
import { writeJsonSecure } from "../secureFile.ts";
import { createHubClient, type HubClient } from "./hubClient.ts";
import { defaultDetectDeps, detectLocalAgents, type DetectDeps } from "./knownAgents.ts";
import {
  createSeatStore,
  createSeatSupervisor,
  SEAT_ID_RE,
  type SeatStore,
  type SeatSupervisor,
} from "./seats.ts";
import {
  createHelperServer,
  HelperHttpError,
  HELPER_BIND,
  HELPER_PORT,
  type AgentTestResult,
  type HelperServerDeps,
} from "./server.ts";
import type { HeartbeatRoom, HelperConfig, LocalAgent, ManualAgent, SeatRecord } from "./types.ts";

/**
 * `mapr up` 的入口：一条命令启动本机助手。
 *
 *   npx -y <包名或仓库地址> up --hub https://hub.wangdada8208.xyz [--pair <配对码>]
 *
 * 启动顺序：
 * 1. 读 ~/.mapr/helper.json；没有且给了 --pair 时立即配对；都没有就以「未配对」状态启动，
 *    本机页面会提示去网站拿配对码。
 * 2. 探测本机 Agent。
 * 3. 在 127.0.0.1:8790 启动本机接口（端口被占用时报错退出，不换端口，因为网站只认 8790）。
 * 4. 恢复所有未被吊销的席位进程。
 * 5. 每 30 秒向 Hub 发心跳；Hub 返回 revoked=true 时停止全部席位并删除 helper.json 中的令牌。
 * 6. 首次启动时用系统默认浏览器打开 http://127.0.0.1:8790/。
 * SIGINT/SIGTERM：停止全部席位进程后退出。
 */
export interface UpOptions {
  hubOrigin: string;
  pairCode?: string;
  rootDir: string;
  openBrowser: boolean;
}

export interface HelperRuntimeOptions {
  hubOrigin: string;
  pairCode?: string;
  rootDir: string;
  detectDeps?: DetectDeps;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  checkExecutable?: (filePath: string) => Promise<boolean>;
  hubClientFactory?: (origin: string, token: string | null) => HubClient;
  /** 测试注入：默认由本模块创建真实进程管理器。 */
  supervisor?: SeatSupervisor;
}

export interface HelperRuntime {
  deps: HelperServerDeps;
  store: SeatStore;
  supervisor: SeatSupervisor;
  heartbeat: () => Promise<void>;
}

export const DEFAULT_HUB_ORIGIN = "https://hub.wangdada8208.xyz";
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 成员进程单次回复的默认超时，与 engines/index.ts 的 DEFAULT_TIMEOUT_MS 一致。 */
const ENGINE_TIMEOUT_MS = 120_000;
/** 连通性测试探针超时（15 秒）。 */
const TEST_PROBE_TIMEOUT_MS = 15_000;
/** 版本号写死在这里而不是读 package.json：发布包可能不含完整 package.json。 */
const HELPER_VERSION = "0.1.0";
/** 打开过本机页面后写这个标记文件，之后开机自启不再弹浏览器。 */
const BROWSER_MARKER = ".ui-opened";

/** 房间元数据本机副本的文件名，位于 <rootDir>/seats/<seatId>/state/ 下。 */
export const ROOM_SETTINGS_FILENAME = "hub-room-settings.json";

/**
 * 把心跳下发的房间安全元数据写进每个本机席位的 state 目录。
 * 只在 settings_version 严格前进时重写（防止旧心跳回滚）；
 * 经 secureFile.ts 原子落盘（0600）。数据始终是建议性质，本机规则优先。
 */
async function syncRoomSettings(rootDir: string, store: SeatStore, rooms: HeartbeatRoom[]): Promise<void> {
  if (rooms.length === 0) return;
  const seats = await store.list();
  for (const room of rooms) {
    if (!room || typeof room.id !== "string" || !Number.isInteger(room.settings_version)) continue;
    for (const seat of seats) {
      if (seat.roomId !== room.id || !SEAT_ID_RE.test(seat.seatId)) continue;
      const file = path.join(rootDir, "seats", seat.seatId, "state", ROOM_SETTINGS_FILENAME);
      let currentVersion = -1;
      try {
        const cur = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> | null;
        if (typeof cur?.settings_version === "number") currentVersion = cur.settings_version;
      } catch {
        // 首次写入或损坏副本——覆盖重写即可。
      }
      if (currentVersion >= room.settings_version) continue;
      await writeJsonSecure(file, {
        settings_version: room.settings_version,
        settings_json: room.settings_json ?? null,
      });
    }
  }
}

export interface ActivitySyncProgress {
  checkpointSeq: Map<string, number>;
  activitySeq: Map<string, number>;
}

const MAX_ACTIVITY_EVENTS_PER_SEAT = 50;

/**
 * WP4：把各席位本机账本里的安全元数据事件与签名检查点增量上报给 Hub。
 * 严格只发白名单元数据与签名链头（绝不带 params/正文/params_hash）；
 * 单个席位报错不阻断其它席位或心跳，只有上传成功才推进游标。
 */
export async function syncSeatActivityToHub(
  rootDir: string,
  store: SeatStore,
  client: HubClient,
  progress: ActivitySyncProgress
): Promise<void> {
  const seats = await store.list();
  for (const rec of seats) {
    if (!rec.roomId || rec.roomId.length > 36 || !SEAT_ID_RE.test(rec.seatId)) continue;
    const stateDir = path.join(rootDir, "seats", rec.seatId, "state");

    try {
      const rawCp = JSON.parse(await readFile(path.join(stateDir, "ledger-checkpoint.json"), "utf8"));
      if (
        isSignedLedgerCheckpoint(rawCp) &&
        rawCp.room_id === rec.roomId &&
        rawCp.stream_id.length > 0 &&
        rawCp.stream_id.length <= 64
      ) {
        const prevSeq = progress.checkpointSeq.get(rec.seatId) ?? -1;
        if (rawCp.head_seq > prevSeq) {
          await client.reportCheckpoints([rawCp]);
          progress.checkpointSeq.set(rec.seatId, rawCp.head_seq);
        }
      }
    } catch {
      // 检查点文件缺失、损坏或网络/Hub 暂不可用不打断心跳，下次继续对齐。
    }

    try {
      const entries = await readLedger(path.join(stateDir, "ledger.jsonl"));
      const lastSeq = progress.activitySeq.get(rec.seatId) ?? 0;
      const fresh = entries
        .filter(
          (e): e is typeof e & { seq: number; entry_hash: string } =>
            typeof e.seq === "number" &&
            Number.isInteger(e.seq) &&
            e.seq > lastSeq &&
            typeof e.entry_hash === "string" &&
            e.entry_hash.length > 0
        )
        .sort((a, b) => a.seq - b.seq)
        .slice(0, MAX_ACTIVITY_EVENTS_PER_SEAT);

      if (fresh.length > 0) {
        const actorId = (rec.xmtpAddress || rec.seatId).slice(0, 128);
        const batch: HubSafeActivityEvent[] = fresh.map((entry) => {
          const parsedMs = Date.parse(entry.at);
          const safe = buildSafeActivityEvent({
            id: activityEventId(rec.seatId, entry.seq, entry.entry_hash),
            room_id: rec.roomId,
            actor_kind: "agent",
            actor_id: actorId,
            kind: entry.kind,
            status: ledgerEntryStatus(entry),
            subject_id:
              typeof entry.request_id === "string" && entry.request_id.length > 0
                ? entry.request_id.slice(0, 64)
                : null,
            now: Number.isFinite(parsedMs) ? new Date(parsedMs) : new Date(0),
          });
          return { ...safe, stream_seq: entry.seq };
        });
        await client.reportActivity(batch);
        progress.activitySeq.set(rec.seatId, fresh[fresh.length - 1].seq);
      }
    } catch {
      // 账本不存在或上传失败时不推进 activitySeq，下一轮幂等重传。
    }
  }
}

/**
 * helper 启动时恢复席位进程。显式暂停（pausedAt 非空）的席位保持停止：
 * 「暂停」语义是保留数据但进程不跑，重启机器或 helper 也不应把它拉起来。
 */
export async function restoreSeats(
  store: SeatStore,
  supervisor: SeatSupervisor,
  log: (msg: string) => void = (m) => console.error(m)
): Promise<void> {
  for (const seat of await store.list()) {
    if (seat.pausedAt) {
      log(`[helper] seat ${seat.seatId} is paused; leaving stopped`);
      continue;
    }
    try {
      await supervisor.start(seat.seatId);
    } catch (err) {
      // 单个席位起不来不阻塞其余席位；状态在 views() 里如实可见。
      log(`[helper] seat ${seat.seatId} failed to start: ${messageOf(err)}`);
    }
  }
}

export function parseUpArgs(flags: Record<string, string>, env: NodeJS.ProcessEnv, homeDir: string): UpOptions {
  const hubOrigin = (flags.hub || env.MAPR_HUB_ORIGIN || DEFAULT_HUB_ORIGIN).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/.test(hubOrigin)) {
    throw new Error(`--hub must be an http(s) origin, got: ${hubOrigin}`);
  }
  const pairCode = (flags.pair || "").trim() || undefined;
  const rootDir = (flags.dir || env.MAPR_DIR || path.join(homeDir, ".mapr")).trim();
  const openBrowser = flags["no-browser"] === undefined && flags.browser !== "false";
  return { hubOrigin, pairCode, rootDir, openBrowser };
}

function secretFileFor(rootDir: string, agentKey: string): string {
  // key 里带 "manual:" 前缀，':' 在 Windows 文件名里非法，统一替换成 '-'。
  return path.join(rootDir, "agents", `${agentKey.replace(/[^A-Za-z0-9-]/g, "-")}.secret`);
}

/** ~/.mapr 下凡是带密钥的文件都遵守同一套权限：文件 0600、目录 0700（S5）。 */
async function readJsonSecure(file: string): Promise<unknown | null> {
  let st;
  try {
    st = await stat(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.mode & 0o077) throw new Error(`${file} has unsafe permissions (want 0600)`);
  return JSON.parse(await readFile(file, "utf8"));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) {
      out = out.split(s).join("[REDACTED]");
    }
  }
  out = out.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  return out;
}

async function defaultCheckExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 打开系统默认浏览器；失败不致命（无图形界面的机器上 xdg-open 会报错）。 */
function openBrowser(url: string): void {
  try {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 打不开浏览器只是少了一次便利跳转，不影响助手本身。
  }
}

export async function createHelperRuntime(options: HelperRuntimeOptions): Promise<HelperRuntime> {
  const rootDir = options.rootDir;
  const runtimePlatform = options.platform ?? process.platform;
  const fetchImpl = options.fetchImpl ?? fetch;
  const isExecutable = options.checkExecutable ?? defaultCheckExecutable;
  const makeHub = options.hubClientFactory ?? createHubClient;

  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);

  // ── 1. 配置与配对 ──
  const configPath = path.join(rootDir, "helper.json");
  let config: HelperConfig | null = null;
  const raw = await readJsonSecure(configPath);
  if (raw !== null) {
    const c = raw as HelperConfig;
    if (
      typeof c.helperId !== "string" ||
      typeof c.helperToken !== "string" ||
      typeof c.hubOrigin !== "string" ||
      !/^https?:\/\//i.test(c.hubOrigin)
    ) {
      throw new Error(`${configPath} is malformed`);
    }
    c.manualAgents = Array.isArray(c.manualAgents) ? c.manualAgents : [];
    config = c;
  }

  let hub: HubClient | null = config?.helperToken ? makeHub(config.hubOrigin, config.helperToken) : null;
  const detectDeps = options.detectDeps ?? defaultDetectDeps();
  const agents = (): Promise<LocalAgent[]> => detectLocalAgents(detectDeps, config);

  const writeConfig = async (cfg: HelperConfig): Promise<void> => {
    await writeJsonSecure(configPath, cfg);
    config = cfg;
  };

  const doPair = async (code: string): Promise<HelperConfig> => {
    // 配对这一步本身不带令牌：配对码就是授权。
    const res = await makeHub(options.hubOrigin, null).pair(
      code,
      os.hostname() || "mapr-helper",
      runtimePlatform
    );
    const next: HelperConfig = {
      hubOrigin: options.hubOrigin,
      helperId: res.helper_id,
      helperToken: res.helper_token,
      deviceName: os.hostname() || "mapr-helper",
      ownerUserId: res.owner_user_id,
      ownerDisplayName: res.owner_display_name,
      // 重配对（旧令牌被吊销后换个码再来）保留已登记的手动 Agent。
      manualAgents: config?.manualAgents ?? [],
    };
    await writeConfig(next);
    hub = makeHub(next.hubOrigin, next.helperToken);
    return next;
  };

  if (options.pairCode) {
    const paired = await doPair(options.pairCode);
    console.log(`[helper] paired as ${paired.ownerDisplayName}`);
  } else if (config?.helperToken) {
    console.log(`[helper] loaded pairing for ${config.ownerDisplayName}`);
  } else {
    console.log("[helper] not paired; open http://127.0.0.1:8790/ after fetching a pairing code");
  }

  // ── 2. 席位存储与进程管理 ──
  const store = createSeatStore(rootDir);
  const xmtpEnv = (process.env.MAPR_XMTP_ENV || "production").trim();
  const memberEntry = path.resolve(import.meta.dirname, "..", "index.ts");

  const engineFor = async (agent: LocalAgent, seat: SeatRecord): Promise<EngineConfig> => {
    if (agent.kind === "claude-code" || agent.kind === "codex" || agent.kind === "gemini-cli") {
      if (!agent.binaryPath) throw new Error(`${agent.displayName} has no resolved binary path`);
      return {
        kind: agent.kind,
        binaryPath: agent.binaryPath,
        // 每个席位一个空白沙箱：命令行 Agent 的工作目录与主人的项目、家目录无关（S1）。
        sandboxDir: path.join(rootDir, "sandbox", seat.seatId),
        timeoutMs: ENGINE_TIMEOUT_MS,
      };
    }
    if (agent.kind === "cli-agent") {
      if (!agent.binaryPath) throw new Error(`${agent.displayName} has no resolved binary path`);
      return {
        kind: "cli-agent",
        agentKey: agent.key,
        binaryPath: agent.binaryPath,
        sandboxDir: path.join(rootDir, "sandbox", seat.seatId),
        timeoutMs: ENGINE_TIMEOUT_MS,
      };
    }
    // Magpie 托管探测项：模型经本机 Magpie 网关应答，回环免密钥，密钥位用占位值。
    if (agent.kind === "openai-compatible" && agent.source === "detected") {
      if (!agent.baseUrl || !agent.model) throw new Error(`${agent.displayName} missing gateway url/model`);
      return { kind: "openai-compatible", baseUrl: agent.baseUrl, apiKey: "mapr-magpie-local", model: agent.model, timeoutMs: ENGINE_TIMEOUT_MS };
    }
    // 手动云端/本地网关 Agent：元数据在 helper.json，密钥只在 ~/.mapr/agents/<key>.secret。
    const manual = config?.manualAgents.find((m) => m.key === agent.key);
    if (!manual) throw new Error(`manual agent ${agent.key} missing from helper config`);
    const secretPath = secretFileFor(rootDir, agent.key);
    const secret = (await readJsonSecure(secretPath)) as Record<string, unknown> | null;
    if (!secret) throw new Error(`secret file for ${agent.key} missing`);
    if (manual.kind === "openai-compatible") {
      if (!manual.baseUrl || !manual.model) throw new Error(`manual agent ${agent.key} missing baseUrl/model`);
      if (typeof secret.apiKey !== "string" || !secret.apiKey) throw new Error(`secret file for ${agent.key} missing apiKey`);
      return { kind: "openai-compatible", baseUrl: manual.baseUrl, apiKey: secret.apiKey, model: manual.model, timeoutMs: ENGINE_TIMEOUT_MS };
    }
    if (!manual.url) throw new Error(`manual agent ${agent.key} missing url`);
    if (typeof secret.secret !== "string" || !secret.secret) throw new Error(`secret file for ${agent.key} missing secret`);
    return { kind: "webhook", url: manual.url, secret: secret.secret, timeoutMs: ENGINE_TIMEOUT_MS };
  };

  const supervisor: SeatSupervisor = options.supervisor ?? createSeatSupervisor({
    store,
    helper: () => {
      if (!config?.helperToken) throw new Error("helper not paired");
      return config;
    },
    agents,
    engineFor,
    memberEntry,
    rootDir,
    xmtpEnv,
  });

  /** 停进程、删 seat.json、删沙箱：三种「移除席位」的路径共用一个收口。 */
  const removeSeatFully = async (seatId: string): Promise<void> => {
    await supervisor.stop(seatId);
    await store.remove(seatId);
    await rm(path.join(rootDir, "sandbox", seatId), { recursive: true, force: true });
  };

  const addManualAgent = async (input: unknown): Promise<LocalAgent> => {
    const cfg = config;
    if (!cfg?.helperToken) throw new HelperHttpError(409, "not_paired");
    const b = (input ?? {}) as Record<string, unknown>;
    const kind = b.kind;
    if (kind !== "openai-compatible" && kind !== "webhook") throw new HelperHttpError(400, "invalid_kind");
    const displayName = typeof b.displayName === "string" ? b.displayName.trim() : "";
    if (!displayName || displayName.length > 64) throw new HelperHttpError(400, "invalid_display_name");

    const key = `manual:${randomUUID()}`;
    let manual: ManualAgent;
    let secretBody: Record<string, string>;
    if (kind === "openai-compatible") {
      const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl.trim().replace(/\/+$/, "") : "";
      const model = typeof b.model === "string" ? b.model.trim() : "";
      const apiKey = typeof b.apiKey === "string" ? b.apiKey.trim() : "";
      // 公网地址强制要求 https，同时允许本机回环 http（Ollama、vLLM、Muse 本地网关等）。
      if (!isAllowedOpenAiBaseUrl(baseUrl)) {
        throw new HelperHttpError(400, "base_url_must_be_https_or_loopback");
      }
      if (!model) throw new HelperHttpError(400, "model_required");
      if (!apiKey) throw new HelperHttpError(400, "api_key_required");
      manual = { key, kind, displayName, baseUrl, model };
      secretBody = { apiKey };
    } else {
      const url = typeof b.url === "string" ? b.url.trim() : "";
      const secret = typeof b.secret === "string" ? b.secret.trim() : "";
      // Webhook 允许回环 http（本机自建的接入端），公网仍要求 https。
      if (!isAllowedOpenAiBaseUrl(url)) {
        throw new HelperHttpError(400, "url_must_be_https_or_loopback");
      }
      if (!secret) throw new HelperHttpError(400, "secret_required");
      manual = { key, kind, displayName, url };
      secretBody = { secret };
    }

    cfg.manualAgents.push(manual);
    await writeConfig(cfg);
    const agentsDir = path.join(rootDir, "agents");
    await mkdir(agentsDir, { recursive: true, mode: 0o700 });
    await chmod(agentsDir, 0o700);
    const secretFile = secretFileFor(rootDir, key);
    await writeFile(secretFile, JSON.stringify(secretBody), { encoding: "utf8", mode: 0o600 });
    await chmod(secretFile, 0o600);
    return {
      key,
      kind,
      displayName,
      source: "manual",
      loginState: "unknown",
      ...(manual.baseUrl ? { baseUrl: manual.baseUrl } : {}),
    };
  };

  const removeManualAgent = async (rawKey: string): Promise<void> => {
    const cfg = config;
    if (!cfg?.helperToken) throw new HelperHttpError(409, "not_paired");
    const key = rawKey.trim();
    if (!key.startsWith("manual:")) throw new HelperHttpError(400, "invalid_agent_key");
    const activeSeats = await store.list();
    if (activeSeats.some((s) => s.agentKey === key)) {
      throw new HelperHttpError(409, "agent_has_active_seats");
    }
    const idx = cfg.manualAgents.findIndex((m) => m.key === key);
    if (idx < 0) throw new HelperHttpError(404, "agent_not_found");
    cfg.manualAgents.splice(idx, 1);
    await writeConfig(cfg);
    await rm(secretFileFor(rootDir, key), { force: true });
  };

  const testAgent = async (rawKey: string): Promise<AgentTestResult> => {
    const key = rawKey.trim();
    const startedAt = Date.now();
    const agent = (await agents()).find((a) => a.key === key);
    if (!agent) throw new HelperHttpError(404, "agent_not_found");

    if (agent.kind === "claude-code" || agent.kind === "codex" || agent.kind === "gemini-cli" || agent.kind === "cli-agent") {
      const binOk = agent.binaryPath ? await isExecutable(agent.binaryPath) : false;
      const latencyMs = Math.max(0, Date.now() - startedAt);
      if (!binOk) {
        return {
          ok: false,
          latencyMs,
          detail: `未找到可执行的 ${agent.displayName} 命令文件`,
        };
      }
      if (agent.loginState === "likely-ready") {
        return {
          ok: true,
          latencyMs,
          detail: `已检测到 ${agent.displayName}${agent.version ? ` (${agent.version})` : ""}，登录态与运行环境就绪`,
        };
      }
      if (agent.loginState === "needs-login") {
        return {
          ok: false,
          latencyMs,
          detail: `已检测到 ${agent.displayName}，但尚未完成终端登录授权`,
        };
      }
      if (agent.kind === "codex") {
        const sandboxHint =
          runtimePlatform === "darwin"
            ? "缺少 macOS sandbox-exec 沙箱环境"
            : "缺少 bubblewrap (bwrap) 沙箱或登录凭证，请确认已安装 bwrap 并完成登录";
        return {
          ok: false,
          latencyMs,
          detail: `已检测到 ${agent.displayName}，但${sandboxHint}`,
        };
      }
      return {
        ok: true,
        latencyMs,
        detail: `已检测到 ${agent.displayName}${agent.version ? ` (${agent.version})` : ""} 可执行文件（登录态待首次调用确认）`,
      };
    }

    const secretsToScrub: string[] = [];
    try {
      const dummySeat: SeatRecord = {
        seatId: "test-probe",
        agentKey: agent.key,
        roomId: "probe",
        roomName: "probe",
        agentUsername: "probe",
        xmtpWalletKey: "0x" + "00".repeat(32),
        xmtpDbEncryptionKey: "0x" + "00".repeat(32),
        xmtpAddress: "0x" + "0".repeat(40),
        xmtpGroupId: null,
        allowedSenders: [],
        agentToken: "",
        consolePort: 0,
        createdAt: new Date(0).toISOString(),
      };
      const baseCfg = await engineFor(agent, dummySeat);
      if (baseCfg.kind === "openai-compatible") {
        secretsToScrub.push(baseCfg.apiKey);
        const engine = openAiCompatibleEngine(
          { ...baseCfg, timeoutMs: TEST_PROBE_TIMEOUT_MS },
          fetchImpl
        );
        const reply = await engine.reply({
          prompt: "连通性测试：请仅回复 OK",
          signal: AbortSignal.timeout(TEST_PROBE_TIMEOUT_MS),
        });
        const latencyMs = Math.max(0, Date.now() - startedAt);
        const preview = scrubSecrets(reply.trim().replace(/\s+/g, " "), secretsToScrub).slice(0, 100);
        return {
          ok: true,
          latencyMs,
          detail: preview ? `连接正常，返回：${preview}` : "连接正常（返回空内容）",
        };
      }
      if (baseCfg.kind === "webhook") {
        secretsToScrub.push(baseCfg.secret);
        const engine = webhookEngine(
          { ...baseCfg, timeoutMs: TEST_PROBE_TIMEOUT_MS },
          fetchImpl
        );
        const reply = await engine.reply({
          prompt: "连通性测试：请仅回复 OK",
          signal: AbortSignal.timeout(TEST_PROBE_TIMEOUT_MS),
        });
        const latencyMs = Math.max(0, Date.now() - startedAt);
        const preview = scrubSecrets(reply.trim().replace(/\s+/g, " "), secretsToScrub).slice(0, 100);
        return {
          ok: true,
          latencyMs,
          detail: preview ? `连接正常，返回：${preview}` : "连接正常（返回空内容）",
        };
      }
      return {
        ok: false,
        latencyMs: Math.max(0, Date.now() - startedAt),
        detail: "不支持的手动 Agent 类型",
      };
    } catch (err) {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const safeMsg = scrubSecrets(messageOf(err).replace(/\s+/g, " ").trim(), secretsToScrub).slice(0, 160);
      return {
        ok: false,
        latencyMs,
        detail: safeMsg || "连接测试失败",
      };
    }
  };

  const deps: HelperServerDeps = {
    version: HELPER_VERSION,
    config: () => config,
    pair: doPair,
    hub: () => hub,
    agents,
    rescan: agents,
    store,
    supervisor,
    removeSeat: removeSeatFully,
    addManualAgent,
    removeManualAgent,
    testAgent,
  };
  const activityProgress: ActivitySyncProgress = {
    checkpointSeq: new Map(),
    activitySeq: new Map(),
  };

  const heartbeat = async (): Promise<void> => {
    const client = hub;
    if (!client || !config?.helperToken) return;
    try {
      const [agentList, views] = await Promise.all([agents(), supervisor.views()]);
      const res = await client.heartbeat({
        agents: agentList.map((a) => ({ key: a.key, kind: a.kind, version: a.version })),
        seats: views.map((v) => ({ seat_id: v.seatId, status: v.status })),
      });
      if (res.revoked) {
        // 主人在网站上吊销了这台电脑：停全部席位、删本地令牌，回到未配对。
        console.log("[helper] revoked by owner; stopping all seats");
        await supervisor.stopAll();
        for (const s of await store.list()) await removeSeatFully(s.seatId);
        const next: HelperConfig = { ...config, helperId: "", helperToken: "" };
        await writeConfig(next);
        hub = null;
        return;
      }
      for (const seatId of res.seats_to_stop) {
        await removeSeatFully(seatId);
      }
      // WP5：seats_to_pause 只停进程不删数据——绝不复用 seats_to_stop（后者物理删除）。
      // Hub 端恢复 = 席位不再出现在列表里，此时清标记并重启；本机手动暂停（"local"）不受对账影响。
      const pauseSet = new Set(res.seats_to_pause ?? []);
      for (const rec of await store.list()) {
        if (pauseSet.has(rec.seatId)) {
          if (!rec.pausedAt) rec.pausedAt = new Date().toISOString();
          if (rec.pausedSource !== "local") rec.pausedSource = "hub";
          await store.save(rec);
          await supervisor.stop(rec.seatId);
        } else if (rec.pausedAt && rec.pausedSource !== "local") {
          rec.pausedAt = null;
          rec.pausedSource = null;
          await store.save(rec);
          try {
            await supervisor.start(rec.seatId);
          } catch (err) {
            console.error(`[helper] seat ${rec.seatId} failed to resume: ${messageOf(err)}`);
          }
        }
      }
      // WP9：房间安全元数据随心跳下发；settings_version 前进才重写，写进席位 state 目录。
      await syncRoomSettings(rootDir, store, res.rooms ?? []);
      // WP4：增量上报各席位的安全元数据活动事件与签名检查点（不带正文，失败不影响心跳）。
      await syncSeatActivityToHub(rootDir, store, client, activityProgress);
      // 房主晚于入座才建群：补上缺失的群号并重启成员进程让它生效。
      for (const rec of await store.list()) {
        if (rec.xmtpGroupId) continue;
        try {
          const st = await client.getSeat(rec.seatId);
          if (st.group_status === "removed") {
            await removeSeatFully(rec.seatId);
          } else if (st.xmtp_group_id) {
            rec.xmtpGroupId = st.xmtp_group_id;
            await store.save(rec);
            const running = (await supervisor.views()).find((v) => v.seatId === rec.seatId);
            if (running && running.status !== "stopped") {
              await supervisor.stop(rec.seatId);
              await supervisor.start(rec.seatId);
            }
          }
        } catch {
          // 单个席位刷新失败，下一次心跳再来。
        }
      }
    } catch (err) {
      // Hub 抖动不致命；心跳内容只含状态码级信息，天然不带秘密。
      console.error(`[helper] heartbeat failed: ${messageOf(err)}`);
    }
  };

  return { deps, store, supervisor, heartbeat };
}

export async function runHelper(options: UpOptions): Promise<number> {
  const rootDir = options.rootDir;
  const { deps, store, supervisor, heartbeat } = await createHelperRuntime({
    hubOrigin: options.hubOrigin,
    pairCode: options.pairCode,
    rootDir,
  });

  // ── 3. 本机接口 ──
  const server = createHelperServer(deps);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(HELPER_PORT, HELPER_BIND, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    // 不换端口：网站与页面只认 8790，悄悄换端口等于失联。
    console.error(`[helper] ${HELPER_BIND}:${HELPER_PORT} unavailable: ${messageOf(err)}`);
    return 1;
  }
  console.log(`[helper] listening on http://${HELPER_BIND}:${HELPER_PORT}/`);

  // ── 4. 恢复席位（已暂停的跳过，不自动拉起） ──
  await restoreSeats(store, supervisor);

  // ── 5. 心跳 ──
  const heartbeatTimer = setInterval(() => {
    void heartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  void heartbeat();

  // ── 6. 首次启动打开本机页面 ──
  const markerPath = path.join(rootDir, BROWSER_MARKER);
  if (options.openBrowser) {
    let marked = false;
    try {
      marked = (await stat(markerPath)).isFile();
    } catch {
      marked = false;
    }
    if (!marked) {
      openBrowser(`http://${HELPER_BIND}:${HELPER_PORT}/`);
      await writeFile(markerPath, `opened ${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
    }
  }

  // ── 关停：席位是子进程，helper 退出时必须全部带走。 ──
  return await new Promise<number>((resolve) => {
    let shuttingDown = false;
    const finish = async (code: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(heartbeatTimer);
      try {
        await supervisor.stopAll();
      } catch {
        // 关停路径尽力而为，不把一个杀不掉的席位变成整个进程退不掉的理由。
      }
      await new Promise<void>((r) => server.close(() => r()));
      resolve(code);
    };
    process.on("SIGINT", () => void finish(0));
    process.on("SIGTERM", () => void finish(0));
  });
}
