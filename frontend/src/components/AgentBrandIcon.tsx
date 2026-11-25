import { Terminal, Webhook } from 'lucide-react';

export type BrandIconKind = 'cloud' | 'local';

interface BrandEntry {
  src: string;
  alt: string;
}

const BRAND_MAP: Record<string, BrandEntry> = {
  claude: { src: '/assets/icons/claude.svg', alt: 'Claude' },
  'claude-code': { src: '/assets/icons/claude-code.svg', alt: 'Claude Code' },
  codex: { src: '/assets/icons/codex.svg', alt: 'Codex' },
  openai: { src: '/assets/icons/openai.svg', alt: 'OpenAI' },
  gemini: { src: '/assets/icons/gemini.svg', alt: 'Gemini' },
  'gemini-cli': { src: '/assets/icons/gemini.svg', alt: 'Gemini CLI' },
  grok: { src: '/assets/icons/grok.svg', alt: 'Grok' },
  'xai-api': { src: '/assets/icons/grok.svg', alt: 'Grok' },
  muse: { src: '/assets/icons/meta.svg', alt: 'Muse (Meta)' },
  meta: { src: '/assets/icons/meta.svg', alt: 'Meta' },
  mcp: { src: '/assets/icons/mcp.svg', alt: 'MCP' },
  ollama: { src: '/assets/icons/ollama.svg', alt: 'Ollama' },
  github: { src: '/assets/icons/github.svg', alt: 'GitHub' },
  docker: { src: '/assets/icons/docker.svg', alt: 'Docker' },
};

function resolveBrandKey(id?: string | null): string | null {
  if (!id) return null;
  const k = id.trim().toLowerCase();
  if (BRAND_MAP[k]) return k;
  if (k.includes('claude-code')) return 'claude-code';
  if (k.includes('claude')) return 'claude';
  if (k.includes('codex')) return 'codex';
  if (k.includes('openai')) return 'openai';
  if (k.includes('gemini')) return 'gemini';
  if (k.includes('grok') || k.includes('xai')) return 'grok';
  if (k.includes('muse') || k.includes('mcp')) return 'mcp';
  if (k.includes('ollama')) return 'ollama';
  if (k.includes('github')) return 'github';
  if (k.includes('docker')) return 'docker';
  return null;
}

export function AgentBrandIcon({
  brand,
  kind = 'local',
  size = 'md',
  label,
}: {
  brand?: string | null;
  kind?: BrandIconKind;
  size?: 'sm' | 'md';
  label?: string;
}) {
  const key = resolveBrandKey(brand);
  const entry = key ? BRAND_MAP[key] : null;
  const px = size === 'sm' ? 16 : 20;

  return (
    <span className={`brand-icon-tile brand-icon-tile--${size}`} aria-hidden={entry ? undefined : 'true'}>
      {entry ? (
        <img src={entry.src} alt={label ?? entry.alt} width={px} height={px} loading="eager" />
      ) : kind === 'cloud' ? (
        <Webhook size={px} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Terminal size={px} strokeWidth={1.75} aria-hidden="true" />
      )}
    </span>
  );
}
