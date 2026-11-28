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
    subtitle: "手机和网页直接用 · 不需要你的电脑",
    description: "运行在 xAI 云端电脑，无需你自己的电脑。手机或网页直接生成一次性邀请，发给 Grok Bot 即可加入加密房间。",
  },
  {
    id: "muse",
    title: "Muse",
    mode: "cloud-agent",
    trustTier: "cloud-api",
    subtitle: "手机和网页直接用 · 不需要你的电脑",
    description: "运行在 Meta 云端安全环境，无需你自己的电脑。手机或网页直接生成一次性邀请，发给 Muse 即可加入加密房间。",
  },
  {
    id: "claude-code",
    title: "Claude Code",
    mode: "local-cli",
    cliKey: "claude-code",
    trustTier: "local-cli",
    subtitle: "在你的电脑上运行 · 适合写代码",
    description: "自动使用电脑上已安装的 Claude Code，并在本机保护边界内运行。",
    installCmd: "npm install -g @anthropic-ai/claude-code && claude",
  },
  {
    id: "codex",
    title: "Codex",
    mode: "local-cli",
    cliKey: "codex",
    trustTier: "local-cli",
    subtitle: "在你的电脑上运行 · 适合写代码",
    description: "自动使用电脑上已安装的 Codex，并在本机保护边界内运行。",
    installCmd: "npm install -g @openai/codex && codex",
  },
  {
    id: "gemini-cli",
    title: "Gemini CLI",
    mode: "local-cli",
    cliKey: "gemini-cli",
    trustTier: "local-cli",
    subtitle: "在你的电脑上运行 · 适合写代码",
    description: "自动使用电脑上已安装并登录的 Gemini CLI，把它接入加密房间。",
    installCmd: "npm install -g @google/gemini-cli && gemini",
  },
  {
    id: "xai-api",
    title: "Grok 云端模型",
    mode: "helper-preset",
    helperPreset: "grok",
    trustTier: "cloud-api",
    subtitle: "用你的密钥连接 Grok",
    description: "密钥只保存在你的电脑上，由电脑助手代你连接 Grok。开发者详情：xAI API Key。",
  },
  {
    id: "ollama",
    title: "Ollama 本机模型",
    mode: "helper-preset",
    helperPreset: "ollama",
    trustTier: "local-cli",
    subtitle: "在你的电脑上运行开源模型",
    description: "在你的电脑本地直接连接 Qwen、DeepSeek、Llama 等模型，对话无需经过平台服务器。",
  },
  {
    id: "webhook",
    title: "我自己的云端助手",
    mode: "helper-preset",
    helperPreset: "webhook",
    trustTier: "custom-webhook",
    subtitle: "连接你已有的云端服务",
    description: "连接 LangGraph、Dify、Coze 或你自己搭建的助手服务。开发者详情：Webhook / HTTP 接口。",
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
