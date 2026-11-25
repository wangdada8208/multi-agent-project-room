import type { SVGProps } from "react";

export interface BrandIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

/** 双联加密室建筑光学徽标 */
export function ProjectRoomMark({ size = 20, ...props }: BrandIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="4.5" width="10.5" height="15" rx="2" stroke="currentColor" strokeWidth="1.9" />
      <rect x="10.5" y="4.5" width="10.5" height="15" rx="2" stroke="currentColor" strokeWidth="1.9" opacity="0.72" />
      <circle cx="12" cy="12" r="2.1" fill="currentColor" />
    </svg>
  );
}

/** Claude Code 终端星徽 SVG */
export function ClaudeCodeIcon({ size = 18, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M5.5 7.5 10 12l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 6.5v11M11.7 8.7l7.6 6.6M19.3 8.7l-7.6 6.6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Codex 六边形矩阵节点 SVG */
export function CodexIcon({ size = 18, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6L12 3.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M12 7.2v9.6M7.8 9.6l8.4 4.8M16.2 9.6l-8.4 4.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
    </svg>
  );
}

/** Gemini CLI 精密四角星标 SVG */
export function GeminiCliIcon({ size = 18, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M12 3.5c1.1 4.2 3.3 6.4 7.5 7.5-4.2 1.1-6.4 3.3-7.5 7.5-1.1-4.2-3.3-6.4-7.5-7.5 4.2-1.1 6.4-3.3 7.5-7.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M6 20h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** xAI Grok 斜切星环 SVG */
export function GrokIcon({ size = 18, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="7.8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6.2 17.8 18.2 5.8" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <circle cx="16.2" cy="15.8" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** Meta Muse 光学双环波纹 SVG */
export function MuseIcon({ size = 18, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4.5 14.5c0-3.2 2-5.5 4.2-5.5 1.8 0 2.7 1.6 3.3 3 .6-1.4 1.5-3 3.3-3 2.2 0 4.2 2.3 4.2 5.5 0 2.5-1.6 4-3.6 4-1.7 0-2.8-1.1-3.9-2.7-1.1 1.6-2.2 2.7-3.9 2.7-2 0-3.6-1.5-3.6-4Z"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="5.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** OpenClaw 命令行机械双爪 SVG */
export function OpenClawIcon({ size = 18, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M8 5.5 4.5 9v6L8 18.5M16 5.5l3.5 3.5v6L16 18.5"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.5 10.5 12 13l2.5-2.5M12 13v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Ollama 本机推理模型几何标 SVG */
export function OllamaIcon({ size = 18, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M7.5 9.5V5.8L10 8h4l2.5-2.2v3.7c1.4 1 2 2.5 2 4.5a6.5 6.5 0 0 1-13 0c0-2 .6-3.5 2-4.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="9.8" cy="13.2" r="1.1" fill="currentColor" />
      <circle cx="14.2" cy="13.2" r="1.1" fill="currentColor" />
    </svg>
  );
}

/** Webhook 节点中继线 SVG */
export function WebhookIcon({ size = 18, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="7" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M10.8 9.2 8.2 14.3M13.2 9.2l2.6 5.1M9.5 16.5h5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Google 几何徽标 SVG */
export function GoogleIcon({ size = 18, ...props }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.4-.18-2.06H12v3.9h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.23c1.89-1.74 2.99-4.3 2.99-7.37Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.61-2.4l-3.23-2.51c-.89.6-2.04.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A9.99 9.99 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.41 13.93A6 6 0 0 1 6.1 12c0-.67.11-1.32.31-1.93V7.48H3.07A9.99 9.99 0 0 0 2 12c0 1.61.39 3.14 1.07 4.52l3.34-2.59Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.95c1.47 0 2.79.5 3.83 1.5l2.87-2.87C16.95 2.96 14.7 2 12 2 8.09 2 4.71 4.24 3.07 7.48l3.34 2.59c.79-2.36 2.99-4.12 5.59-4.12Z"
      />
    </svg>
  );
}

export function AgentBrandIcon({
  id,
  size = 18,
  className,
}: {
  id: string;
  size?: number;
  className?: string;
}) {
  switch (id) {
    case "grok":
    case "xai-api":
      return <GrokIcon size={size} className={className} />;
    case "muse":
      return <MuseIcon size={size} className={className} />;
    case "claude-code":
      return <ClaudeCodeIcon size={size} className={className} />;
    case "codex":
      return <CodexIcon size={size} className={className} />;
    case "gemini-cli":
      return <GeminiCliIcon size={size} className={className} />;
    case "openclaw":
      return <OpenClawIcon size={size} className={className} />;
    case "ollama":
      return <OllamaIcon size={size} className={className} />;
    case "webhook":
    default:
      return <WebhookIcon size={size} className={className} />;
  }
}
