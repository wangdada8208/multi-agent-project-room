import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EngineConfig } from "../engines/types.ts";
import type { HelperConfig, LocalAgent, SeatRecord, SeatStatus, SeatView } from "./types.ts";

export const SEAT_PORT_BASE = 8791;

/** seatId 来自 Hub（uuid），这里再拦一次，保证它永远不可能拼出越界路径。 */
export const SEAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** S5：同组/其他人有任何权限位都拒绝，包括读与执行。 */
function assertSecureMode(mode: number, what: string): void {
  if (mode & 0o077) {
    throw new Error(`refusing to read ${what}: permissions too open`);
  }
}

/** 读写 ~/.mapr/seats/<seatId>/seat.json。写入用 0600，目录用 0700；权限不对时拒绝读取。 */
export interface SeatStore {
  list(): Promise<SeatRecord[]>;
  get(seatId: string): Promise<SeatRecord | null>;
  save(seat: SeatRecord): Promise<void>;
  /** 删除私钥文件与数据目录。只在主人确认移除席位、或 Hub 明确吊销后调用。 */
  remove(seatId: string): Promise<void>;
  /** 从 SEAT_PORT_BASE 起找第一个未被已有席位占用的端口。 */
  nextFreePort(): Promise<number>;
}

export function createSeatStore(rootDir: string): SeatStore {
  const seatsDir = path.join(rootDir, "seats");
  const dirOf = (seatId: string) => path.join(seatsDir, seatId);
  const fileOf = (seatId: string) => path.join(dirOf(seatId), "seat.json");

  // mkdir 对已存在的目录不改权限，权限位必须显式 chmod 一次。
  const ensureDir = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  };

  const readRecord = async (seatId: string): Promise<SeatRecord | null> => {
    if (!SEAT_ID_RE.test(seatId)) return null;
    const file = fileOf(seatId);
    let st;
    try {
      st = await stat(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const dirSt = await stat(dirOf(seatId));
    assertSecureMode(dirSt.mode & 0o777, `seat directory ${seatId}`);
    assertSecureMode(st.mode & 0o777, `seat record ${seatId}`);
    return JSON.parse(await readFile(file, "utf8")) as SeatRecord;
  };

  const listRecords = async (): Promise<SeatRecord[]> => {
    let entries;
    try {
      entries = await readdir(seatsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: SeatRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SEAT_ID_RE.test(entry.name)) continue;
      const rec = await readRecord(entry.name);
      if (rec) out.push(rec);
    }
    // 稳定排序：端口分配与页面展示都依赖一个可预期的顺序。
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seatId.localeCompare(b.seatId));
    return out;
  };

  return {
    list: listRecords,
    get: readRecord,
    async save(seat) {
      if (!SEAT_ID_RE.test(seat.seatId)) throw new Error(`invalid seat id ${seat.seatId}`);
      await ensureDir(seatsDir);
      await ensureDir(dirOf(seat.seatId));
      // 先写临时文件再 rename：进程中途被杀不会留下半份 seat.json。
      const tmp = `${fileOf(seat.seatId)}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(seat, null, 2), { encoding: "utf8", mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, fileOf(seat.seatId));
    },
    async remove(seatId) {
      if (!SEAT_ID_RE.test(seatId)) return;
      await rm(dirOf(seatId), { recursive: true, force: true });
    },
    async nextFreePort() {
      const used = new Set((await listRecords()).map((s) => s.consolePort));
      let port = SEAT_PORT_BASE;
      while (used.has(port)) port += 1;
      return port;
    },
  };
}

/**
 * 生成成员进程（src/index.ts）的完整设置项。这是席位与现有成员进程之间唯一的接口：
 *   XMTP_SELF_NAME, XMTP_ENV, XMTP_WALLET_KEY, XMTP_DB_ENCRYPTION_KEY, XMTP_DB_DIRECTORY,
 *   XMTP_ALLOWED_SENDERS, XMTP_ALLOW_GROUP_MEMBERS=1, XMTP_GROUP_ID, XMTP_LOOP_STATE_PATH,
 *   HUB_BASE_URL, HUB_ROOM_ID, HUB_TOKEN(=agentToken，不是主人的登录令牌),
 *   OWNER_NOTES_PORT(=consolePort),
 *   MEMBER_AGENT_KIND 及该种类需要的 MEMBER_AGENT_* 项（见 engines/index.ts）。
 * 不继承父进程的设置项，只给 PATH、HOME、LANG（S2 白名单：helper 令牌、配对码之类
 * 绝不下发；HOME 指回真实家目录是因为命令行 Agent 的登录凭证存在那里）。
 */
export function seatEnv(
  seat: SeatRecord,
  agent: LocalAgent,
  engine: EngineConfig,
  helper: Pick<HelperConfig, "hubOrigin">,
  paths: { dbDir: string; statePath: string },
  xmtpEnv: string
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.XMTP_SELF_NAME = agent.displayName;
  env.XMTP_ENV = xmtpEnv;
  env.XMTP_WALLET_KEY = seat.xmtpWalletKey;
  env.XMTP_DB_ENCRYPTION_KEY = seat.xmtpDbEncryptionKey;
  env.XMTP_DB_DIRECTORY = paths.dbDir;
  env.XMTP_LOOP_STATE_PATH = paths.statePath;
  env.XMTP_ALLOWED_SENDERS = seat.allowedSenders.join(",");
  // 决定 D3：同一加密群里的成员都算允许的发送者；群外私信仍按白名单。
  env.XMTP_ALLOW_GROUP_MEMBERS = "1";
  // 本机助手管理的席位默认严格按 @席位名 或 @all / @全体 唤醒，避免偶数轮无故抢答。
  env.XMTP_MENTION_ONLY = "1";
  if (seat.xmtpGroupId) env.XMTP_GROUP_ID = seat.xmtpGroupId;
  env.HUB_BASE_URL = helper.hubOrigin;
  env.HUB_ROOM_ID = seat.roomId;
  env.HUB_TOKEN = seat.agentToken;
  env.MAPR_HELPER_SEAT_ID = seat.seatId;
  env.OWNER_NOTES_PORT = String(seat.consolePort);
  env.MEMBER_AGENT_KIND = engine.kind;
  env.MEMBER_AGENT_TIMEOUT_MS = String(engine.timeoutMs);
  switch (engine.kind) {
    case "claude-code":
    case "codex":
    case "gemini-cli":
      env.MEMBER_AGENT_BIN = engine.binaryPath;
      env.MEMBER_AGENT_SANDBOX_DIR = engine.sandboxDir;
      if (engine.model) env.MEMBER_AGENT_MODEL = engine.model;
      // bwrap 挂载清单是可选透传项，原样写回让 engineConfigFromEnv 重新解析。
      if (engine.bwrapRoDirs?.length) env.MEMBER_AGENT_BWRAP_RO = engine.bwrapRoDirs.join(path.delimiter);
      if (engine.bwrapRwDirs?.length) env.MEMBER_AGENT_BWRAP_RW = engine.bwrapRwDirs.join(path.delimiter);
      break;
    case "cli-agent":
      env.MEMBER_AGENT_BIN = engine.binaryPath;
      env.MEMBER_AGENT_SANDBOX_DIR = engine.sandboxDir;
      env.MEMBER_AGENT_KEY = engine.agentKey;
      if (engine.model) env.MEMBER_AGENT_MODEL = engine.model;
      break;
    case "openai-compatible":
      env.MEMBER_AGENT_BASE_URL = engine.baseUrl;
      env.MEMBER_AGENT_API_KEY = engine.apiKey;
      env.MEMBER_AGENT_MODEL = engine.model;
      break;
    case "webhook":
      env.MEMBER_AGENT_WEBHOOK_URL = engine.url;
      env.MEMBER_AGENT_WEBHOOK_SECRET = engine.secret;
      break;
    case "http-model":
      env.MEMBER_MODEL_URL = engine.url;
      env.MEMBER_MODEL_API_KEY = engine.apiKey;
      break;
  }
  return env;
}

/**
 * 席位进程管理。每个席位一个子进程：node --experimental-strip-types src/index.ts。
 * - start：已在运行则直接返回（重复运行也不会出问题）。
 * - 子进程异常退出：状态记为 crashed，按 2s/4s/8s… 最长 60s 退避重启；连续 5 次失败后停止重启。
 *   进程稳定跑满 60 秒后的退出不累计「连续失败」（否则偶发抖动几天也会耗尽重启次数）。
 * - stop：SIGTERM，5 秒后 SIGKILL；状态记为 stopped，并如实保留最后的错误。
 * - 本机助手退出时停止所有子进程。
 */
export interface SeatSupervisor {
  start(seatId: string): Promise<void>;
  stop(seatId: string): Promise<void>;
  stopAll(): Promise<void>;
  views(): Promise<SeatView[]>;
}

export interface SupervisorDeps {
  store: SeatStore;
  helper: () => HelperConfig;
  agents: () => Promise<LocalAgent[]>;
  /** 从 LocalAgent 推出引擎配置；手动云端 Agent 会在这里读取 ~/.mapr/agents/<key>.secret。 */
  engineFor: (agent: LocalAgent, seat: SeatRecord) => Promise<EngineConfig>;
  memberEntry: string;
  rootDir: string;
  /** 传给席位子进程的 XMTP_ENV（dev / production 等）。 */
  xmtpEnv: string;
  /** 测试注入点：自定义退避间隔（毫秒）。默认 2s/4s/8s… 封顶 60s。 */
  restartDelayMs?: (consecutiveFailures: number) => number;
}

/** 异常退出后存活满这个时长，重启计数清零。 */
const STABLE_RUN_MS = 60_000;
/** 连续异常退出达到此次数后放弃重启。 */
const MAX_FAILURES = 5;
/** spawn 成功后存活满这个时长才把状态从 starting 改成 running。 */
const MARK_RUNNING_MS = 5_000;
/** SIGTERM 之后等这么久仍不死就补 SIGKILL。 */
const SIGKILL_GRACE_MS = 5_000;
/** lastError 最多保留 stderr 尾部这么多字符，防止刷屏。 */
const STDERR_TAIL = 400;
/** 透传子进程日志时保留的滚动缓冲，供 lastError 使用。 */
const PIPE_TAIL_BYTES = 4096;

interface ProcState {
  child: ChildProcess | null;
  status: SeatStatus;
  lastError: string | null;
  failures: number;
  /** 主动停止中：退出属于预期，不触发重启。 */
  stopping: boolean;
  restartTimer: NodeJS.Timeout | null;
  upTimer: NodeJS.Timeout | null;
  startedAt: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSeatSupervisor(deps: SupervisorDeps): SeatSupervisor {
  const states = new Map<string, ProcState>();
  const delayFor =
    deps.restartDelayMs ?? ((failures: number) => Math.min(2000 * 2 ** (failures - 1), 60_000));

  const ensureState = (seatId: string): ProcState => {
    let state = states.get(seatId);
    if (!state) {
      state = {
        child: null,
        status: "stopped",
        lastError: null,
        failures: 0,
        stopping: false,
        restartTimer: null,
        upTimer: null,
        startedAt: 0,
      };
      states.set(seatId, state);
    }
    return state;
  };

  const fail = (state: ProcState, reason: string): Error => {
    state.status = "crashed";
    state.lastError = reason;
    return new Error(reason);
  };

  const seatPaths = (seatId: string) => {
    const seatDir = path.join(deps.rootDir, "seats", seatId);
    return {
      seatDir,
      dbDir: path.join(seatDir, "xmtp"),
      statePath: path.join(seatDir, "state", "loop.json"),
      sandboxDir: path.join(deps.rootDir, "sandbox", seatId),
    };
  };

  const clearTimers = (state: ProcState): void => {
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    if (state.upTimer) {
      clearTimeout(state.upTimer);
      state.upTimer = null;
    }
  };

  const onExit = (seatId: string, child: ChildProcess, why: string, errTail: string): void => {
    const state = states.get(seatId);
    // 旧进程迟到的退出事件不得覆盖新进程的状态（stop 后立即 start 的场景）。
    if (!state || state.child !== child) return;
    state.child = null;
    clearTimers(state);
    if (state.stopping) {
      state.status = "stopped";
      return;
    }
    const uptime = Date.now() - state.startedAt;
    state.failures = uptime >= STABLE_RUN_MS ? 1 : state.failures + 1;
    state.status = "crashed";
    const tail = errTail.trim().slice(-STDERR_TAIL);
    state.lastError = `member exited (${why})${tail ? `: ${tail}` : ""}`;
    if (state.failures >= MAX_FAILURES) {
      state.lastError += `; gave up after ${MAX_FAILURES} consecutive failures`;
      return;
    }
    const delay = delayFor(state.failures);
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (state.stopping) return;
      spawnMember(seatId, state).catch((err) => {
        state.status = "crashed";
        state.lastError = `restart failed: ${messageOf(err)}`;
      });
    }, delay);
    state.restartTimer.unref();
  };

  const spawnMember = async (seatId: string, state: ProcState): Promise<void> => {
    const seat = await deps.store.get(seatId);
    if (!seat) throw fail(state, `seat record ${seatId} missing`);
    const agent = (await deps.agents()).find((a) => a.key === seat.agentKey);
    if (!agent) throw fail(state, `agent ${seat.agentKey} no longer available`);
    let engine: EngineConfig;
    try {
      engine = await deps.engineFor(agent, seat);
    } catch (err) {
      throw fail(state, messageOf(err));
    }
    let helper: HelperConfig;
    try {
      helper = deps.helper();
    } catch {
      throw fail(state, "helper not paired");
    }
    const paths = seatPaths(seatId);
    for (const dir of [paths.dbDir, path.dirname(paths.statePath), paths.sandboxDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    const env = seatEnv(seat, agent, engine, helper, paths, deps.xmtpEnv);
    const child = spawn(process.execPath, ["--experimental-strip-types", deps.memberEntry], {
      env,
      cwd: paths.seatDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.child = child;
    state.startedAt = Date.now();

    // 成员进程的日志不含房间正文与密钥，原样透传到 helper 终端便于排查；
    // 同时留一份 stderr 滚动尾部，崩溃时写进 lastError。
    let errTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errTail = (errTail + chunk.toString("utf8")).slice(-PIPE_TAIL_BYTES);
      process.stderr.write(chunk);
    });
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));

    let settled = false;
    const finish = (why: string) => {
      if (settled) return;
      settled = true;
      onExit(seatId, child, why, errTail);
    };
    child.on("error", (err) => finish(`spawn error: ${messageOf(err)}`));
    child.on("close", (code, signal) =>
      finish(code !== null ? `exit code ${code}` : `signal ${signal ?? "unknown"}`));

    state.upTimer = setTimeout(() => {
      state.upTimer = null;
      if (state.child === child && state.status === "starting") state.status = "running";
    }, MARK_RUNNING_MS);
    state.upTimer.unref();
  };

  const api: SeatSupervisor = {
    async start(seatId) {
      const state = ensureState(seatId);
      if (state.child) return;
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      state.stopping = false;
      state.failures = 0;
      state.status = "starting";
      state.lastError = null;
      await spawnMember(seatId, state);
    },
    async stop(seatId) {
      const state = states.get(seatId);
      if (!state) return;
      state.stopping = true;
      clearTimers(state);
      const child = state.child;
      if (!child) {
        state.status = "stopped";
        state.stopping = false;
        return;
      }
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("close", () => resolve());
      });
      try {
        child.kill("SIGTERM");
      } catch {
        // 进程刚好退出：close 事件会收口。
      }
      const hardKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已经死了，无需处理。
        }
      }, SIGKILL_GRACE_MS);
      hardKill.unref();
      await exited;
      clearTimeout(hardKill);
      state.child = null;
      state.status = "stopped";
      state.stopping = false;
    },
    async stopAll() {
      await Promise.all([...states.keys()].map((seatId) => api.stop(seatId)));
    },
    async views() {
      // 磁盘记录是席位清单的唯一事实来源；运行态只补充 status 与 lastError。
      return (await deps.store.list()).map((rec) => {
        const state = states.get(rec.seatId);
        return {
          seatId: rec.seatId,
          agentKey: rec.agentKey,
          roomId: rec.roomId,
          roomName: rec.roomName,
          xmtpAddress: rec.xmtpAddress,
          consolePort: rec.consolePort,
          status: state?.status ?? "stopped",
          lastError: state?.lastError ?? null,
          pausedAt: rec.pausedAt ?? null,
        };
      });
    },
  };
  return api;
}
