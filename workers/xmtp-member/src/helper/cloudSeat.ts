/**
 * 云端席位自查（WP5/WP6）：没有本机 helper 的云端 Agent 周期性向 Hub 查询
 * 自己席位的生命周期。通知可能丢失，自查是兜底；被撤即 fail-closed 停跑。
 *
 *   GET  /api/v1/agent-seats/{seat_id}        → {seat_id, room_id, source, group_status, paused_at, removed_at}
 *   POST /api/v1/agent-seats/{seat_id}/token  → {agent_token}
 *
 * 状态映射：
 *   removed_at 非空 / group_status === "removed" / HTTP 403 / HTTP 404 → "removed"（一律按被撤处理）
 *   paused_at 非空                                                   → "paused"
 *   其余 200                                                         → "active"
 *   网络错误 / 5xx / 401 / 响应解析失败                               → "unknown"（下次再查，不误停）
 *
 * 令牌只在 "active" 时续约；续约失败不改判状态，旧令牌原样返回。
 * 任何返回值/错误都不带令牌、签名或响应原文。
 */
import { explicitRevocation } from "../pairingCredentials.ts";

export type CloudSeatState = "active" | "paused" | "removed" | "unknown";

export interface CloudSeatCheck {
  state: CloudSeatState;
  /** Credentials are safe to clear only after an explicit response from the seat API. */
  confirmedRemoval?: true;
  /** Hub 回传的暂停/撤除时间戳（ISO 字符串），无则 null。 */
  pausedAt: string | null;
  removedAt: string | null;
  /** 续约成功时是新令牌，否则与调用方传入的一致。 */
  agentToken: string;
  tokenRenewed: boolean;
  /** 最后一次状态查询的 HTTP 状态码；网络层失败为 0。 */
  httpStatus: number;
}

export interface CloudSeatClientOptions {
  hubOrigin: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 60_000;

interface ApiResult {
  status: number;
  body: unknown | null;
}

async function callSeatApi(
  base: string,
  method: "GET" | "POST",
  apiPath: string,
  agentToken: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${agentToken}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    return { status: 0, body: null };
  }
  if (res.status === 204) return { status: res.status, body: null };
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: res.status, body: null };
  }
}

/** 单次席位自查；renewToken=true 且席位 active 时顺带续约。 */
export async function checkCloudSeat(
  options: CloudSeatClientOptions & { seatId: string; agentToken: string; renewToken?: boolean }
): Promise<CloudSeatCheck> {
  const base = options.hubOrigin.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const seatPath = `/api/v1/agent-seats/${encodeURIComponent(options.seatId)}`;
  const fail = (state: "removed" | "unknown" | "paused", httpStatus: number): CloudSeatCheck => ({
    state,
    pausedAt: null,
    removedAt: null,
    agentToken: options.agentToken,
    tokenRenewed: false,
    httpStatus,
  });

  const res = await callSeatApi(base, "GET", seatPath, options.agentToken, fetchImpl, timeoutMs);
  const detail = res.body && typeof res.body === "object" && "detail" in res.body ? res.body.detail : null;
  if (explicitRevocation(res.status, res.body) ||
      (res.status === 403 && detail === "Agent account required") ||
      (res.status === 404 && detail === "Seat not found")) {
    return { ...fail("removed", res.status), confirmedRemoval: true };
  }
  // Preserve fail-closed on ambiguous 403/404 responses without deleting local credentials.
  if (res.status === 403 || res.status === 404) return fail("removed", res.status);
  if (res.status !== 200 || !res.body || typeof res.body !== "object") {
    return fail("unknown", res.status);
  }

  const body = res.body as Record<string, unknown>;
  const pausedAt = typeof body.paused_at === "string" ? body.paused_at : null;
  const removedAt = typeof body.removed_at === "string" ? body.removed_at : null;
  if (removedAt || body.group_status === "removed") {
    return { ...fail("removed", res.status), pausedAt, removedAt, confirmedRemoval: true };
  }
  if (pausedAt) {
    return { ...fail("paused", res.status), pausedAt };
  }

  let agentToken = options.agentToken;
  let tokenRenewed = false;
  if (options.renewToken) {
    const renew = await callSeatApi(base, "POST", `${seatPath}/token`, options.agentToken, fetchImpl, timeoutMs);
    if (explicitRevocation(renew.status, renew.body) ||
        (renew.status === 409 && renew.body && typeof renew.body === "object" &&
          "detail" in renew.body && renew.body.detail === "Seat removed")) {
      return { ...fail("removed", renew.status), confirmedRemoval: true };
    }
    const tok =
      renew.body && typeof renew.body === "object"
        ? (renew.body as Record<string, unknown>).agent_token
        : null;
    if (renew.status === 200 && typeof tok === "string" && tok) {
      agentToken = tok;
      tokenRenewed = true;
    }
  }
  return { state: "active", pausedAt: null, removedAt: null, agentToken, tokenRenewed, httpStatus: res.status };
}

export interface CloudSeatPoller {
  /** 停止轮询（幂等）。 */
  stop(): void;
  /** 立即自查，并复用正在进行的自查。 */
  checkNow(): Promise<void>;
}

/**
 * 周期性自查席位状态，给云端 Agent 的 index.ts 十行接线用。
 * 首次 tick 立即执行，之后按 intervalMs（默认 60s）。
 * - removed：触发一次 onRemoved 后自动停止轮询（席位被撤即终点）；
 * - 首次确认暂停状态及后续切换：onPaused(true/false)；
 * - 续约成功：onToken(newToken)。
 * 定时器 unref，不阻止进程退出。
 */
export function startCloudSeatPolling(
  options: CloudSeatClientOptions & {
    seatId: string;
    agentToken: string;
    renewToken?: boolean;
    intervalMs?: number;
    onToken?: (agentToken: string) => void;
    onPaused?: (paused: boolean) => void;
    onRemoved?: (confirmed: boolean) => void | Promise<void>;
  }
): CloudSeatPoller {
  let stopped = false;
  let lastPaused: boolean | undefined;
  let agentToken = options.agentToken;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async (renewToken: boolean): Promise<void> => {
    if (stopped) return;
    const res = await checkCloudSeat({
      hubOrigin: options.hubOrigin,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      seatId: options.seatId,
      agentToken,
      renewToken,
    });
    if (stopped) return;
    if (res.tokenRenewed) {
      agentToken = res.agentToken;
      options.onToken?.(agentToken);
    }
    if (res.state === "removed") {
      stopped = true;
      if (timer) clearInterval(timer);
      await options.onRemoved?.(res.confirmedRemoval === true);
      return;
    }
    if (res.state === "unknown") return;
    const paused = res.state === "paused";
    if (paused !== lastPaused) {
      lastPaused = paused;
      options.onPaused?.(paused);
    }
  };

  let checking: Promise<void> | undefined;
  const checkNow = (renewToken = false): Promise<void> => {
    checking ??= tick(renewToken).finally(() => { checking = undefined; });
    return checking;
  };
  void checkNow(options.renewToken);
  timer = setInterval(() => void checkNow(options.renewToken), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return {
    checkNow: () => checkNow(),
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
