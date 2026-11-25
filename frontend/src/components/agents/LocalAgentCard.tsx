import { Laptop } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentPresetItem } from "../../lib/agentPresets";
import { AgentBrandIcon, OpenClawIcon } from "../icons/BrandIcons";

export function LocalAgentCard({ item, title, subtitle, children }: {
  item?: Exclude<AgentPresetItem, { mode: "cloud-agent" }>;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const icon = item ? (
    <AgentBrandIcon id={item.id} size={18} />
  ) : title === "OpenClaw" ? (
    <OpenClawIcon size={18} />
  ) : (
    <Laptop size={17} />
  );
  return <article className="wb-local-card agents-preset-card">
    <header>
      <span className="wb-local-card__icon" aria-hidden="true">{icon}</span>
      <div><strong>{item?.title ?? title}</strong><small>{item?.subtitle ?? subtitle}</small></div>
    </header>
    {children}
  </article>;
}
