import type { AgentKind, TrustTier } from "./localHelper";

export type AgentPresetId =
  | "claude-code"
  | "codex"
  | "grok"
  | "muse"
  | "gemini-cli"
  | "ollama"
  | "webhook";

export interface AgentPresetItem {
  id: AgentPresetId;
  title: string;
  subtitle: string;
  description: string;
  mode: "local-cli" | "helper-preset";
  trustTier: TrustTier;
  cliKey?: Extract<AgentKind, "claude-code" | "codex" | "gemini-cli">;
  installCmd?: string;
  helperPreset?: string;
  altHelperPreset?: string;
  altLabel?: string;
}

export const AGENT_PRESETS: readonly AgentPresetItem[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    mode: "local-cli",
    cliKey: "claude-code",
    trustTier: "local-cli",
    subtitle: "Anthropic 终端编程智能体",
    description: "自动读取本机已安装的 claude 命令与登录态，在系统安全沙箱内隔离运行。",
    installCmd: "npm install -g @anthropic-ai/claude-code && claude",
  },
  {
    id: "codex",
    title: "Codex",
    mode: "local-cli",
    cliKey: "codex",
    trustTier: "local-cli",
    subtitle: "OpenAI 终端编码智能体",
    description: "自动识别本机 codex 命令，在系统级只读安全沙箱内保护运行。",
    installCmd: "npm install -g @openai/codex && codex",
  },
  {
    id: "grok",
    title: "Grok / Grokbot",
    mode: "helper-preset",
    helperPreset: "grok",
    altHelperPreset: "grokbot-webhook",
    altLabel: "Grokbot Webhook",
    trustTier: "cloud-api",
    subtitle: "xAI 官方接口 / Grokbot 桥接",
    description: "一键预填 xAI 接口或本地 Grokbot 桥接服务，密钥仅保存在你的电脑本地。",
  },
  {
    id: "muse",
    title: "Muse",
    mode: "helper-preset",
    helperPreset: "muse",
    altHelperPreset: "muse-webhook",
    altLabel: "Muse Webhook",
    trustTier: "cloud-api",
    subtitle: "Muse 智能体接口 / Webhook",
    description: "一键接入 Muse 智能体接口或本地桥接转发服务，密钥仅保存在你的电脑本地。",
  },
  {
    id: "gemini-cli",
    title: "Gemini CLI",
    mode: "local-cli",
    cliKey: "gemini-cli",
    trustTier: "local-cli",
    subtitle: "Google 终端智能体",
    description: "自动扫描本机 gemini 命令与授权凭据，一键拉入加密房间。",
    installCmd: "npm install -g @google/gemini-cli && gemini",
  },
  {
    id: "ollama",
    title: "Ollama 本机模型",
    mode: "helper-preset",
    helperPreset: "ollama",
    trustTier: "local-cli",
    subtitle: "本机开源模型推理服务",
    description: "在你的电脑本地直接连接 Qwen、DeepSeek、Llama 等推理服务，对话无需经过平台服务器。",
  },
  {
    id: "webhook",
    title: "自定义 Agent / Webhook",
    mode: "helper-preset",
    helperPreset: "webhook",
    trustTier: "custom-webhook",
    subtitle: "自定义 HTTP 服务接入",
    description: "接入 LangGraph、Dify、Coze 或任意自研 Python/Node 智能体服务。",
  },
];

export function findAgentPreset(id: string): AgentPresetItem | undefined {
  return AGENT_PRESETS.find((item) => item.id === id);
}
