/** 与 workers/xmtp-member/src/engines/types.ts 的 AgentKind 保持一致（cloud-agent = 邀请入房的云端 Agent）。 */
export type AgentKind = "claude-code" | "codex" | "gemini-cli" | "cli-agent" | "openai-compatible" | "webhook" | "http-model" | "cloud-agent";

/** 信任分级：席位回话时明文流向的边界（借鉴 agentroom.chat 的诚实分级）。 */
export type TrustTier = "local-cli" | "cloud-api" | "custom-webhook";

const TIER_BY_KIND: Record<AgentKind, TrustTier> = {
  "claude-code": "local-cli",
  codex: "local-cli",
  "gemini-cli": "local-cli",
  "cli-agent": "local-cli",
  "openai-compatible": "cloud-api",
  "http-model": "cloud-api",
  "cloud-agent": "cloud-api",
  webhook: "custom-webhook",
};

export function trustTierOf(kind: AgentKind | string): TrustTier {
  return TIER_BY_KIND[kind as AgentKind] ?? "custom-webhook";
}

export const TRUST_TIER_LABEL: Record<TrustTier, string> = {
  "local-cli": "本机",
  "cloud-api": "云端接口",
  "custom-webhook": "自定义接口",
};
