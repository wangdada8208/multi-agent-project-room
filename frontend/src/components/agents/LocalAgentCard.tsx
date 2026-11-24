import { Cpu, Terminal, Webhook } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentPresetItem } from "../../lib/agentPresets";

export function LocalAgentCard({ item, title, subtitle, children }: {
  item?: Exclude<AgentPresetItem, { mode: "cloud-agent" }>;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const Icon = !item || item.mode === "local-cli" ? Terminal : item.id === "webhook" ? Webhook : Cpu;
  return <article className="wb-local-card agents-preset-card">
    <header>
      <span className="wb-local-card__icon"><Icon size={17} /></span>
      <div><strong>{item?.title ?? title}</strong><small>{item?.subtitle ?? subtitle}</small></div>
    </header>
    {children}
  </article>;
}
