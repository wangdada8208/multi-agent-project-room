import type { AgentKind, TrustTier } from "./localHelper";
import type { XmtpEnv } from "./xmtpEnv";

interface PresetDescription {
  title: string;
  subtitle: string;
  description: string;
}

export type CloudAgentPreset = PresetDescription & {
  id: "grok" | "muse";
  mode: "cloud-agent";
  trustTier: "cloud-api";
};

type CliKey = Extract<AgentKind, "claude-code" | "codex" | "gemini-cli">;
export type AgentPresetItem = CloudAgentPreset | (PresetDescription & (
  | {
      id: CliKey;
      mode: "local-cli";
      trustTier: "local-cli";
      cliKey: CliKey;
      installCmd: string;
    }
  | {
      id: "xai-api" | "ollama" | "webhook";
      mode: "helper-preset";
      trustTier: TrustTier;
      helperPreset: string;
    }
));

export type AgentPresetId = AgentPresetItem["id"];

export const AGENT_PRESETS: readonly AgentPresetItem[] = [
  {
    id: "grok",
    title: "Grok Bot",
    mode: "cloud-agent",
    trustTier: "cloud-api",
    subtitle: "xAI 云端常驻 Agent · 专属云电脑 / Skills / Webhook",
    description: "运行在 xAI 云端电脑，无需你自己的电脑。手机或网页直接生成专属云端邀请指令，发给 Grok Bot 即可加入加密房间。",
  },
  {
    id: "muse",
    title: "Muse",
    mode: "cloud-agent",
    trustTier: "cloud-api",
    subtitle: "Meta 云端常驻 Agent · Secure VM / 终端 / MCP",
    description: "运行在 Meta 云端安全虚拟机，无需你自己的电脑。手机或网页直接生成专属云端邀请指令，发给 Muse 即可加入加密房间。",
  },
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
    id: "xai-api",
    title: "xAI Grok API（模型接口）",
    mode: "helper-preset",
    helperPreset: "grok",
    trustTier: "cloud-api",
    subtitle: "通过 API Key 调用 xAI 模型",
    description: "在电脑本机助手中保存 API Key，用于调用 xAI Grok 模型接口。",
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

export function cloudAgentConnectCommand({
  hubOrigin,
  inviteUrl,
  title,
  env,
}: {
  hubOrigin: string;
  inviteUrl: string;
  title: CloudAgentPreset["title"];
  env: XmtpEnv;
}): string {
  const quote = (arg: string) => `"${arg.replace(/["\\$`]/g, "\\$&")}"`;
  const downloadUrl = new URL("/downloads/xmtp-member-latest.tar.gz", hubOrigin).href;
  const downloadArg = /^[\w:/.-]+$/.test(downloadUrl) ? downloadUrl : quote(downloadUrl);
  return [
    `curl -fsSL ${downloadArg} -o /tmp/mapr.tar.gz`,
    "mkdir -p ~/.mapr-bot/app",
    "tar -xzf /tmp/mapr.tar.gz -C ~/.mapr-bot/app --strip-components=1",
    "(cd ~/.mapr-bot/app && npm ci --omit=dev)",
    `node --experimental-strip-types ~/.mapr-bot/app/src/cli.ts bridge --invite ${quote(inviteUrl)} --name ${quote(title)} --env ${quote(env)}`,
  ].join(" && ");
}
