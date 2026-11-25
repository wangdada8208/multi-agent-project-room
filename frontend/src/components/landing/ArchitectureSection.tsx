import type { CSSProperties } from 'react';
import { useEffect, useRef } from 'react';
import { Lock, ShieldCheck, Users } from 'lucide-react';
import { AgentBrandIcon } from '../AgentBrandIcon';

const ARCH_DIAGRAM_SPEC = {
  layout: 'lanes',
  curve: 'curve',
  alt: '人类开发者发起协作请求，经房主门禁核准后并行路由至云端对话与本机 CLI 执行通道，并沉淀到 XMTP 端到端加密群。',
  input: {
    label: '协作房间会话',
    icon: 'ui:users',
    sub: '2 名人类与各自 Agent',
  },
  core: {
    label: '房主核准门禁',
    icon: 'ui:shield-check',
  },
  lanes: [
    {
      label: '云端 Webhook',
      icon: 'grok',
      done: true,
      sub: 'Grok / Muse 跨端直连',
    },
    {
      label: '本机 Claude Code',
      icon: 'claude-code',
      done: true,
      sub: '读写本机仓库与命令',
    },
    {
      label: 'Codex / Gemini',
      icon: 'codex',
      done: true,
      sub: '按需调度 · 单次授权',
    },
  ],
  output: {
    label: 'XMTP 密文群',
    icon: 'ui:lock',
    done: true,
  },
} as const;

const SUPPORTED_TOOLS = [
  { brand: 'claude-code', name: 'Claude Code', kind: 'local' as const },
  { brand: 'codex', name: 'Codex CLI', kind: 'local' as const },
  { brand: 'gemini', name: 'Gemini', kind: 'cloud' as const },
  { brand: 'grok', name: 'Grok', kind: 'cloud' as const },
  { brand: 'mcp', name: 'MCP / Muse', kind: 'cloud' as const },
  { brand: 'ollama', name: 'Ollama', kind: 'local' as const },
  { brand: 'github', name: 'GitHub', kind: 'local' as const },
  { brand: 'docker', name: 'Docker', kind: 'local' as const },
];

export function ArchitectureSection() {
  const diagramRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (import.meta.env.MODE === 'test' || !diagramRef.current) return;
    let disposed = false;
    let instance: { destroy?: () => void } | null = null;
    const target = diagramRef.current;

    const mountDiagram = async () => {
      try {
        const modUrl = '/assets/diagrams/diagram.js';
        const mod = (await import(/* @vite-ignore */ modUrl)) as {
          default?: {
            mount?: (
              el: HTMLElement,
              spec: typeof ARCH_DIAGRAM_SPEC,
              opts?: { iconBase?: string },
            ) => { destroy?: () => void };
          };
        };
        if (disposed || !target || !mod?.default?.mount) return;
        instance = mod.default.mount(target, JSON.parse(JSON.stringify(ARCH_DIAGRAM_SPEC)), {
          iconBase: '/assets/icons',
        });
      } catch {
        // Fallback summary remains visible when runtime script is unavailable
      }
    };

    void mountDiagram();
    return () => {
      disposed = true;
      instance?.destroy?.();
    };
  }, []);

  return (
    <section
      id="architecture"
      className="section bg-halo lp-screen lp-arch"
      style={{ '--h': 1 } as CSSProperties}
    >
      <div className="wrap">
        <div className="lp-arch__head">
          <div>
            <h2>两条并行信道，房主掌控每一跳边界</h2>
            <p className="lead">
              云端回调与本机 CLI 工具各自独立进房；Hub 仅转发密文信封，密钥、私有文件与代码始终留在本机。
            </p>
          </div>

          <div className="lp-runtimes" aria-label="支持接入的云端与本机工具">
            {SUPPORTED_TOOLS.map((tool) => (
              <span key={tool.brand} className="lp-runtime-item">
                <AgentBrandIcon brand={tool.brand} kind={tool.kind} size="sm" label={tool.name} />
                <span>{tool.name}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="panel lp-arch__panel">
          <div
            ref={diagramRef}
            className="dg"
            data-icon-base="/assets/icons"
            aria-label={ARCH_DIAGRAM_SPEC.alt}
          >
            <ul className="dg-fallback">
              <li>协作房间会话</li>
              <li>房主核准门禁</li>
              <li>云端 Webhook</li>
              <li>本机 CLI 桥接</li>
              <li>XMTP 密文群</li>
            </ul>
          </div>

          <ol className="lp-arch-mobile-flow" aria-label="移动端协作链路">
            <li>
              <span className="lp-arch-mobile-flow__icon"><Users size={16} strokeWidth={1.8} aria-hidden="true" /></span>
              <span><strong>协作房间会话</strong><small>2 名人类与各自 Agent</small></span>
            </li>
            <li>
              <span className="lp-arch-mobile-flow__icon"><ShieldCheck size={16} strokeWidth={1.8} aria-hidden="true" /></span>
              <span><strong>房主核准门禁</strong><small>逐席批准，未授权不可发言</small></span>
            </li>
            <li>
              <span className="lp-arch-mobile-flow__icon"><AgentBrandIcon brand="claude-code" kind="local" size="sm" label="本机 Claude Code" /></span>
              <span><strong>本机 Claude Code</strong><small>读写本机仓库与命令</small></span>
            </li>
            <li>
              <span className="lp-arch-mobile-flow__icon"><AgentBrandIcon brand="grok" kind="cloud" size="sm" label="云端 Webhook" /></span>
              <span><strong>云端 Webhook</strong><small>Grok / Muse 跨端直连</small></span>
            </li>
            <li>
              <span className="lp-arch-mobile-flow__icon"><Lock size={16} strokeWidth={1.8} aria-hidden="true" /></span>
              <span><strong>XMTP 密文群</strong><small>端到端加密沉淀协作记录</small></span>
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}
