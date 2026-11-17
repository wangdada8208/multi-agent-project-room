/**
 * 回复引擎：成员进程里唯一调用「真正的 Agent」的地方。
 *
 * 成员进程原来只有一个 `complete(prompt) => Promise<string>` 缝隙（见 index.ts），
 * 由 MEMBER_MODEL_URL 驱动。本模块把这条缝隙换成按 Agent 种类分派的引擎。
 * onInboundText 与 handleEnvelope 都只依赖 `complete`，不感知引擎种类。
 */

export type AgentKind =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "openai-compatible"
  | "webhook"
  | "http-model";

export const AGENT_KINDS: readonly AgentKind[] = [
  "claude-code",
  "codex",
  "gemini-cli",
  "openai-compatible",
  "webhook",
  "http-model",
];

export interface ReplyRequest {
  prompt: string;
  /** 取消信号：主人取消或超时时触发，引擎必须终止底层子进程或网络请求。 */
  signal: AbortSignal;
}

export interface ReplyEngine {
  readonly kind: AgentKind;
  reply(req: ReplyRequest): Promise<string>;
}

interface CliEngineBase {
  /** 探测阶段得到的可执行文件绝对路径；不得用 shell 拼接命令。 */
  binaryPath: string;
  /** 空白沙箱目录，作为子进程工作目录，不得指向主人的项目或家目录。 */
  sandboxDir: string;
  timeoutMs: number;
  model?: string;
  /** 环境相关的额外只读挂载（冒号分隔解析自 MEMBER_AGENT_BWRAP_RO）。 */
  bwrapRoDirs?: string[];
  /** 环境相关的额外可写挂载（冒号分隔解析自 MEMBER_AGENT_BWRAP_RW）。 */
  bwrapRwDirs?: string[];
}

export type EngineConfig =
  | ({ kind: "claude-code" } & CliEngineBase)
  | ({ kind: "codex" } & CliEngineBase)
  | ({ kind: "gemini-cli" } & CliEngineBase)
  | {
      kind: "openai-compatible";
      /** 例如 xAI Grok：https://api.x.ai/v1 */
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
    }
  | {
      kind: "webhook";
      /** 同步问答：POST {prompt} → 200 {text}。异步唤醒型 Bot 不适用。 */
      url: string;
      secret: string;
      timeoutMs: number;
    }
  | {
      kind: "http-model";
      /** 旧通道：MEMBER_MODEL_URL + MEMBER_MODEL_API_KEY，保持现有行为。 */
      url: string;
      apiKey: string;
      timeoutMs: number;
    };

/** 引擎单次输出的上限，超出部分截断，防止子进程刷屏撑爆内存。 */
export const MAX_REPLY_BYTES = 64 * 1024;
