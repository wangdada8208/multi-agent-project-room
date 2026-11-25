import { Webhook } from "lucide-react";
import { AgentMark } from "../ui/AgentMark";
import type { ReactNode } from "react";
import type { AgentPresetItem } from "../../lib/agentPresets";

export function LocalAgentCard({ item, title, subtitle, children }: {
  item?: Exclude<AgentPresetItem, { mode: "cloud-agent" }>;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const label = item?.title ?? title ?? "Local Agent";
  const genericWebhook = item?.id === "webhook" || title === "连接另一台电脑";
  return <article className="wb-local-card agents-preset-card">
    <header>
      <span className="wb-local-card__icon">{genericWebhook ? <Webhook size={17} /> : <AgentMark name={label} actor="local" />}</span>
      <div><strong>{item?.title ?? title}</strong><small>{item?.subtitle ?? subtitle}</small></div>
    </header>
    {children}
  </article>;
}
