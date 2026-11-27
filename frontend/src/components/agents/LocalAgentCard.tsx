import type { ReactNode } from "react";
import { NamedBrandIcon } from "../ui/BrandIcon";
import type { AgentPresetItem } from "../../lib/agentPresets";

export function LocalAgentCard({ item, title, subtitle, children }: {
  item?: Exclude<AgentPresetItem, { mode: "cloud-agent" }>;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return <article className="wb-local-card agents-preset-card">
    <header>
      <span className="wb-local-card__icon"><NamedBrandIcon name={item?.title ?? title ?? "Agent"} fallback={item?.id === "webhook" ? "webhook" : "terminal"} size={19} /></span>
      <div><strong>{item?.title ?? title}</strong><small>{item?.subtitle ?? subtitle}</small></div>
    </header>
    {children}
  </article>;
}
