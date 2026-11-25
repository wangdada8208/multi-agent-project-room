import type { ReactNode } from "react";
import type { AgentPresetItem } from "../../lib/agentPresets";
import { AgentBrandIcon } from "../AgentBrandIcon";

export function LocalAgentCard({ item, title, subtitle, children }: {
  item?: Exclude<AgentPresetItem, { mode: "cloud-agent" }>;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return <article className="wb-local-card agents-preset-card">
    <header>
      <AgentBrandIcon
        brand={item?.id ?? title}
        kind={item?.id === "webhook" ? "cloud" : "local"}
        size="md"
        label={item?.title ?? title}
      />
      <div><strong>{item?.title ?? title}</strong><small>{item?.subtitle ?? subtitle}</small></div>
    </header>
    {children}
  </article>;
}
