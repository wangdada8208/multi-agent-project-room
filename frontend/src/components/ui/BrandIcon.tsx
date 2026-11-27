import type { SVGProps } from "react";

export type BrandKey =
  | "claude"
  | "codex"
  | "gemini"
  | "grok"
  | "muse"
  | "ollama"
  | "xmtp"
  | "github"
  | "webhook"
  | "cloud"
  | "terminal"
  | "agent";

export function brandKeyForName(name: string): BrandKey | null {
  const value = name.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("claude")) return "claude";
  if (value.includes("codex") || value.includes("openai")) return "codex";
  if (value.includes("gemini")) return "gemini";
  if (value.includes("grok") || value.includes("xai")) return "grok";
  if (value.includes("muse")) return "muse";
  if (value.includes("ollama")) return "ollama";
  if (value.includes("xmtp")) return "xmtp";
  if (value.includes("github")) return "github";
  if (value.includes("webhook")) return "webhook";
  return null;
}

function pathsFor(kind: BrandKey) {
  switch (kind) {
    case "claude":
      return (
        <>
          <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
          {Array.from({ length: 8 }, (_, index) => {
            const angle = (index * Math.PI) / 4;
            const x1 = 12 + Math.cos(angle) * 4.3;
            const y1 = 12 + Math.sin(angle) * 4.3;
            const x2 = 12 + Math.cos(angle) * 8.2;
            const y2 = 12 + Math.sin(angle) * 8.2;
            return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </>
      );
    case "codex":
      return (
        <>
          <path d="M12 3.8 18.6 7.6v7.6L12 19l-6.6-3.8V7.6L12 3.8Z" />
          <path d="M8.2 9.1c2.4-1.5 5.2-1.5 7.6 0M8.2 14.9c2.4 1.5 5.2 1.5 7.6 0M12 5.6v12.8" />
        </>
      );
    case "gemini":
      return <path d="M12 3.7c.8 4.5 3.8 7.5 8.3 8.3-4.5.8-7.5 3.8-8.3 8.3-.8-4.5-3.8-7.5-8.3-8.3 4.5-.8 7.5-3.8 8.3-8.3Z" />;
    case "grok":
      return (
        <>
          <path d="m5 5 14 14M19 5 5 19" />
          <path d="M7.2 5h4.2L19 16.8v2.2h-4.2L5 7.2V5h2.2Z" opacity=".28" fill="currentColor" stroke="none" />
        </>
      );
    case "muse":
      return (
        <>
          <path d="M4.8 18.5v-9.4c0-1 .8-1.8 1.8-1.8.6 0 1.1.3 1.4.8l4 6.5 4-6.5c.3-.5.8-.8 1.4-.8 1 0 1.8.8 1.8 1.8v9.4" />
          <path d="M6.4 18.5h11.2" opacity=".45" />
        </>
      );
    case "ollama":
      return (
        <>
          <path d="M7.1 9.2 5.7 4.7c-.2-.6.5-1.1 1-.8l3 1.9M16.9 9.2l1.4-4.5c.2-.6-.5-1.1-1-.8l-3 1.9" />
          <path d="M6.4 11.2c0-3 2.5-5.2 5.6-5.2s5.6 2.2 5.6 5.2v3.1c0 3-2.5 5.2-5.6 5.2s-5.6-2.2-5.6-5.2v-3.1Z" />
          <path d="M9.1 12h.1M14.9 12h.1M9.6 15.2c1.4.9 3.4.9 4.8 0" />
        </>
      );
    case "xmtp":
      return (
        <>
          <path d="M4.5 7.5c0-1 .8-1.8 1.8-1.8h11.4c1 0 1.8.8 1.8 1.8v7.6c0 1-.8 1.8-1.8 1.8H9.3l-4.8 3.4v-12.8Z" />
          <path d="m6.2 8 5.8 4.3L17.8 8" />
        </>
      );
    case "github":
      return (
        <>
          <path d="M7.1 8.1c-.3-.9-.2-2 .2-3 1.2 0 2.2.5 3 1.2a10.5 10.5 0 0 1 3.4 0c.8-.7 1.8-1.2 3-1.2.4 1 .5 2.1.2 3 .8.8 1.3 1.9 1.3 3.1 0 3-2.2 4.5-5 4.7v2.4c0 .8-.5 1.2-1.2 1.2s-1.2-.4-1.2-1.2v-2.4c-2.8-.2-5-1.7-5-4.7 0-1.2.5-2.3 1.3-3.1Z" />
          <path d="M9.1 12.1h.1M14.9 12.1h.1" />
        </>
      );
    case "webhook":
      return (
        <>
          <path d="M8.1 8.2a4 4 0 1 1 5.7 5l-2.7 2.7" />
          <path d="M15.9 15.8a4 4 0 1 1-5.7-5l2.7-2.7" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
        </>
      );
    case "cloud":
      return <path d="M7.2 17.5h9.3a3.4 3.4 0 0 0 .6-6.7A5.1 5.1 0 0 0 7.1 12a3.1 3.1 0 0 0 .1 5.5Z" />;
    case "terminal":
      return (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2.2" />
          <path d="m7.5 9 3 3-3 3M12.5 15h4" />
        </>
      );
    case "agent":
    default:
      return (
        <>
          <rect x="5" y="7" width="14" height="11" rx="3" />
          <path d="M12 7V4.5M9 4.5h6" />
          <path d="M9 12h.1M14.9 12h.1M9.5 15c1.5.8 3.5.8 5 0" />
        </>
      );
  }
}

export function BrandIcon({ kind, size = 18, strokeWidth = 1.7, ...props }: SVGProps<SVGSVGElement> & {
  kind: BrandKey;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {pathsFor(kind)}
    </svg>
  );
}

export function NamedBrandIcon({ name, fallback = "agent", size = 18, strokeWidth = 1.7 }: {
  name: string;
  fallback?: BrandKey;
  size?: number;
  strokeWidth?: number;
}) {
  return <BrandIcon kind={brandKeyForName(name) ?? fallback} size={size} strokeWidth={strokeWidth} />;
}
