import path from "node:path";
import { claudeCodeEngine, cliAgentEngine, codexEngine, geminiCliEngine } from "./cliEngines.ts";
import { httpModelEngine, openAiCompatibleEngine, webhookEngine } from "./httpEngines.ts";
import { AGENT_KINDS, type AgentKind, type EngineConfig, type ReplyEngine } from "./types.ts";

export type { AgentKind, EngineConfig, ReplyEngine, ReplyRequest } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = (env[name] || "").trim();
  if (!value) throw new Error(`engine config missing required env ${name}`);
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = (env[name] || "").trim();
  return value || undefined;
}

function requireAbsolutePath(env: NodeJS.ProcessEnv, name: string): string {
  const value = requiredEnv(env, name);
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path, got: ${value}`);
  }
  return value;
}

function parseTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = (env.MEMBER_AGENT_TIMEOUT_MS || "").trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid MEMBER_AGENT_TIMEOUT_MS: ${raw}`);
  }
  return Math.floor(value);
}

/**
 * 从成员进程设置项读取引擎配置。
 *
 * 读取顺序：
 * 1. MEMBER_AGENT_KIND 有值：按种类读取 MEMBER_AGENT_BIN / MEMBER_AGENT_SANDBOX_DIR /
 *    MEMBER_AGENT_MODEL / MEMBER_AGENT_TIMEOUT_MS / MEMBER_AGENT_BASE_URL /
 *    MEMBER_AGENT_API_KEY / MEMBER_AGENT_WEBHOOK_URL / MEMBER_AGENT_WEBHOOK_SECRET。
 * 2. MEMBER_AGENT_KIND 为空，但 MEMBER_MODEL_URL 与 MEMBER_MODEL_API_KEY 都有值：返回 http-model，
 *    保证网页向导生成的旧 .env 继续可用。
 * 3. 都没有：返回 null，成员进程保持「只听不答」的现有行为。
 *
 * 种类未知或必填项缺失时抛错，让进程启动失败，不得静默降级。
 */
export function engineConfigFromEnv(env: NodeJS.ProcessEnv): EngineConfig | null {
  const rawKind = (env.MEMBER_AGENT_KIND || "").trim();
  const timeoutMs = parseTimeoutMs(env);

  if (!rawKind) {
    const url = optionalEnv(env, "MEMBER_MODEL_URL");
    const apiKey = optionalEnv(env, "MEMBER_MODEL_API_KEY");
    if (url && apiKey) return { kind: "http-model", url, apiKey, timeoutMs };
    if (url || apiKey) {
      throw new Error("MEMBER_MODEL_URL and MEMBER_MODEL_API_KEY must be set together");
    }
    return null;
  }

  if (!(AGENT_KINDS as readonly string[]).includes(rawKind)) {
    throw new Error(`unknown MEMBER_AGENT_KIND: ${rawKind}`);
  }
  const kind = rawKind as AgentKind;

  const parseDirList = (name: string): string[] | undefined => {
    const raw = optionalEnv(env, name);
    if (!raw) return undefined;
    return raw.split(path.delimiter).filter((s) => s.trim().length > 0 && path.isAbsolute(s));
  };

  switch (kind) {
    case "claude-code":
    case "codex":
    case "gemini-cli": {
      const roDirs = parseDirList("MEMBER_AGENT_BWRAP_RO");
      const rwDirs = parseDirList("MEMBER_AGENT_BWRAP_RW");
      return {
        kind,
        binaryPath: requireAbsolutePath(env, "MEMBER_AGENT_BIN"),
        sandboxDir: requireAbsolutePath(env, "MEMBER_AGENT_SANDBOX_DIR"),
        timeoutMs,
        model: optionalEnv(env, "MEMBER_AGENT_MODEL"),
        ...(roDirs ? { bwrapRoDirs: roDirs } : {}),
        ...(rwDirs ? { bwrapRwDirs: rwDirs } : {}),
      };
    }
    case "cli-agent":
      return {
        kind,
        agentKey: requiredEnv(env, "MEMBER_AGENT_KEY"),
        binaryPath: requireAbsolutePath(env, "MEMBER_AGENT_BIN"),
        sandboxDir: requireAbsolutePath(env, "MEMBER_AGENT_SANDBOX_DIR"),
        timeoutMs,
        model: optionalEnv(env, "MEMBER_AGENT_MODEL"),
      };
    case "openai-compatible":
      return {
        kind,
        baseUrl: requiredEnv(env, "MEMBER_AGENT_BASE_URL"),
        apiKey: requiredEnv(env, "MEMBER_AGENT_API_KEY"),
        model: requiredEnv(env, "MEMBER_AGENT_MODEL"),
        timeoutMs,
      };
    case "webhook":
      return {
        kind,
        url: requiredEnv(env, "MEMBER_AGENT_WEBHOOK_URL"),
        secret: requiredEnv(env, "MEMBER_AGENT_WEBHOOK_SECRET"),
        timeoutMs,
      };
    case "http-model":
      return {
        kind,
        url: requiredEnv(env, "MEMBER_MODEL_URL"),
        apiKey: requiredEnv(env, "MEMBER_MODEL_API_KEY"),
        timeoutMs,
      };
  }
}

export function createReplyEngine(config: EngineConfig): ReplyEngine {
  switch (config.kind) {
    case "claude-code":
      return claudeCodeEngine(config);
    case "codex":
      return codexEngine(config);
    case "gemini-cli":
      return geminiCliEngine(config);
    case "cli-agent":
      return cliAgentEngine(config);
    case "openai-compatible":
      return openAiCompatibleEngine(config);
    case "webhook":
      return webhookEngine(config);
    case "http-model":
      return httpModelEngine(config);
    default: {
      const unreachable: never = config;
      throw new Error(`unknown engine kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * 把引擎包装成 index.ts 现有的 `complete(prompt)` 形状。
 * 每次调用生成独立的超时信号；外部取消信号（如任务取消）可通过 `parentSignal` 串联。
 */
export function engineToComplete(
  engine: ReplyEngine,
  timeoutMs: number,
  parentSignal?: AbortSignal
): (prompt: string) => Promise<string> {
  return (prompt: string) => {
    const signals = [AbortSignal.timeout(timeoutMs), ...(parentSignal ? [parentSignal] : [])];
    return engine.reply({ prompt, signal: AbortSignal.any(signals) });
  };
}
