type AgentMarkKind = "claude" | "codex" | "gemini" | "grok" | "muse" | "generic-local" | "generic-cloud";

export function agentMarkKind(name: string, actor?: string): AgentMarkKind {
  const normalized = name.toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex") || normalized.includes("openai")) return "codex";
  if (normalized.includes("gemini")) return "gemini";
  if (normalized.includes("grok") || normalized.includes("xai")) return "grok";
  if (normalized.includes("muse")) return "muse";
  return actor === "cloud" ? "generic-cloud" : "generic-local";
}

function ClaudeMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" fill="#d97757" />
      <g stroke="#fff4ea" strokeWidth="2.7" strokeLinecap="round">
        <path d="M16 7.2v5" />
        <path d="M16 19.8v5" />
        <path d="M9.8 10.4l3.8 2.8" />
        <path d="M18.4 18.8l3.8 2.8" />
        <path d="M22.2 10.4l-3.8 2.8" />
        <path d="M13.6 18.8l-3.8 2.8" />
        <path d="M8 16h5" />
        <path d="M19 16h5" />
      </g>
      <circle cx="16" cy="16" r="2.35" fill="#fff4ea" />
    </svg>
  );
}

function CodexMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" fill="#101010" />
      <g fill="none" stroke="#f8f8f2" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 5.8 22.4 9.4 26 16 22.4 22.6 16 26.2 9.6 22.6 6 16 9.6 9.4Z" />
        <path d="M16 5.8v6.2M22.4 9.4l-3.1 5.4M26 16h-6.2M22.4 22.6l-5.3-3.1M16 26.2V20M9.6 22.6l3.1-5.4M6 16h6.2M9.6 9.4l5.3 3.1" />
      </g>
      <circle cx="16" cy="16" r="2.2" fill="#f8f8f2" />
    </svg>
  );
}

function GeminiMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" fill="#0b57d0" />
      <path
        d="M16 4.8c.8 5.7 2.1 8.2 4 9.6 1.5 1.1 3.9 2.1 7.2 2.4-5.1.8-8.1 2.8-9.2 7.2-.8 3.1-1.2 4.4-1.8 6.4-.7-5.6-2-8.2-4-9.7-1.5-1.1-3.9-2-7.1-2.5 5-.7 8-2.7 9.2-7.1.8-3.1 1.1-4.1 1.7-6.3Z"
        fill="#fff"
      />
      <path d="M24.4 3.8c.3 2 .9 2.8 1.6 3.4.6.4 1.4.8 2.7 1-2 .4-3.1 1.2-3.6 2.9-.3 1.1-.4 1.6-.7 2.3-.3-2-.9-2.9-1.6-3.4-.6-.5-1.5-.8-2.7-1.1 2-.4 3.1-1.2 3.6-2.8.3-1.1.4-1.5.7-2.3Z" fill="#a8e6ff" />
    </svg>
  );
}

function GrokMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" fill="#111312" />
      <path
        d="M6.5 5.5h5l4.5 5.5 4.5-5.5h5l-7 8.4 7.2 12.6h-5.1L16 20.2l-4.6 6.3H6.3l7.2-12.6-7-8.4Z"
        fill="#f6f3e9"
      />
      <path d="M21.7 5.5h3.8v21h-3.8z" fill="#f6f3e9" opacity="0.28" />
    </svg>
  );
}

function MuseMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" fill="#0866ff" />
      <path
        d="M6.4 18.4c0-4.1 3-7 6.7-7 4.3 0 5.7 4.2 9.1 4.2 1.8 0 3.2-1.2 3.2-3"
        fill="none"
        stroke="#fff"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M25.6 13.6c0 4.1-3 7-6.7 7-4.3 0-5.7-4.2-9.1-4.2-1.8 0-3.2 1.2-3.2 3"
        fill="none"
        stroke="#bfe3ff"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GenericMark({ cloud }: { cloud: boolean }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" fill={cloud ? "#006a71" : "#884411"} />
      {cloud ? (
        <path
          d="M9 21.5h14.2a4.3 4.3 0 0 0 .8-8.5 6.4 6.4 0 0 0-12.4-1.6A5 5 0 0 0 9 21.5Z"
          fill="none"
          stroke="#fffdf8"
          strokeWidth="2.1"
          strokeLinejoin="round"
        />
      ) : (
        <g fill="none" stroke="#fffdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6.5" y="7" width="19" height="18" rx="2" />
          <path d="m11 13 4 3-4 3M17 20h5" />
        </g>
      )}
    </svg>
  );
}

export function AgentMark({ name, actor }: { name: string; actor?: string }) {
  const kind = agentMarkKind(name, actor);
  if (kind === "claude") return <ClaudeMark />;
  if (kind === "codex") return <CodexMark />;
  if (kind === "gemini") return <GeminiMark />;
  if (kind === "grok") return <GrokMark />;
  if (kind === "muse") return <MuseMark />;
  return <GenericMark cloud={kind === "generic-cloud"} />;
}
