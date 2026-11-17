import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineConfig } from "../engines/types.ts";
import { createHubClient, type HubClient } from "./hubClient.ts";
import { defaultDetectDeps, detectLocalAgents } from "./knownAgents.ts";
import { createSeatStore, createSeatSupervisor, type SeatSupervisor } from "./seats.ts";
import { createHelperServer, HelperHttpError, HELPER_BIND, HELPER_PORT } from "./server.ts";
import type { HelperConfig, LocalAgent, ManualAgent, SeatRecord } from "./types.ts";

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

const DEFAULT_HUB_ORIGIN = "https://hub.wangdada8208.xyz";
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 成员进程单次回复的默认超时，与 engines/index.ts 的 DEFAULT_TIMEOUT_MS 一致。 */
const ENGINE_TIMEOUT_MS = 120_000;
/** 版本号写死在这里而不是读 package.json：发布包可能不含完整 package.json。 */
const HELPER_VERSION = "0.1.0";
/** 打开过本机页面后写这个标记文件，之后开机自启不再弹浏览器。 */
const BROWSER_MARKER = ".ui-opened";

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

async function writeJsonSecure(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

export async function runHelper(options: UpOptions): Promise<number> {
  const rootDir = options.rootDir;
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);

  // ── 1. 配置与配对 ──
  const configPath = path.join(rootDir, "helper.json");
  let config: HelperConfig | null = null;
  const raw = await readJsonSecure(configPath);
  if (raw !== null) {
    const c = raw as HelperConfig;
    if (typeof c.helperId !== "string" || typeof c.helperToken !== "string" || typeof c.hubOrigin !== "string") {
      throw new Error(`${configPath} is malformed`);
    }
    c.manualAgents = Array.isArray(c.manualAgents) ? c.manualAgents : [];
    config = c;
  }

  let hub: HubClient | null = config?.helperToken ? createHubClient(config.hubOrigin, config.helperToken) : null;
  const detectDeps = defaultDetectDeps();
  const agents = (): Promise<LocalAgent[]> => detectLocalAgents(detectDeps, config);

  const writeConfig = async (cfg: HelperConfig): Promise<void> => {
    await writeJsonSecure(configPath, cfg);
    config = cfg;
  };

  const doPair = async (code: string): Promise<HelperConfig> => {
    // 配对这一步本身不带令牌：配对码就是授权。
    const res = await createHubClient(options.hubOrigin, null).pair(
      code,
      os.hostname() || "mapr-helper",
      process.platform
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
    hub = createHubClient(next.hubOrigin, next.helperToken);
    return next;
  };

  if (!config && options.pairCode) {
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
    // 手动云端 Agent：元数据在 helper.json，密钥只在 ~/.mapr/agents/<key>.secret。
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

  const supervisor: SeatSupervisor = createSeatSupervisor({
    store,
    helper: () => {
      if (!config) throw new Error("helper not paired");
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

  // ── 3. 本机接口 ──
  const server = createHelperServer({
    version: HELPER_VERSION,
    config: () => config,
    pair: doPair,
    hub: () => hub,
    agents,
    rescan: agents,
    store,
    supervisor,
    removeSeat: removeSeatFully,
    addManualAgent: async (input: unknown): Promise<LocalAgent> => {
      const cfg = config;
      if (!cfg) throw new HelperHttpError(409, "not_paired");
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
        // 引擎只接受 https：密钥要过网络，明文 http 等于广播。
        if (!/^https:\/\//.test(baseUrl)) throw new HelperHttpError(400, "base_url_must_be_https");
        if (!model) throw new HelperHttpError(400, "model_required");
        if (!apiKey) throw new HelperHttpError(400, "api_key_required");
        manual = { key, kind, displayName, baseUrl, model };
        secretBody = { apiKey };
      } else {
        const url = typeof b.url === "string" ? b.url.trim() : "";
        const secret = typeof b.secret === "string" ? b.secret.trim() : "";
        // Webhook 允许回环 http（本机自建的接入端），公网仍要求 https。
        const loopbackHttp = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
        if (!/^https:\/\//.test(url) && !loopbackHttp) {
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
      await writeFile(secretFileFor(rootDir, key), JSON.stringify(secretBody), { encoding: "utf8", mode: 0o600 });
      return { key, kind, displayName, source: "manual", loginState: "unknown" };
    },
  });

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

  // ── 4. 恢复席位 ──
  for (const seat of await store.list()) {
    try {
      await supervisor.start(seat.seatId);
    } catch (err) {
      // 单个席位起不来不阻塞其余席位；状态在 views() 里如实可见。
      console.error(`[helper] seat ${seat.seatId} failed to start: ${messageOf(err)}`);
    }
  }

  // ── 5. 心跳 ──
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
