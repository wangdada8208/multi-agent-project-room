import { ChevronDown, ChevronUp } from "lucide-react";
import type { CloudAgentPreset } from "../../lib/agentPresets";
import { AgentBrandIcon } from "../icons/BrandIcons";

export function CloudAgentCard({ preset, expanded, controls, onToggle }: {
  preset: CloudAgentPreset;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return <button type="button" className="wb-cloud-card agents-preset-card" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
    <span className="wb-cloud-card__icon" aria-hidden="true">
      <AgentBrandIcon id={preset.id} size={22} />
    </span>
    <span className="wb-cloud-card__copy"><strong>{preset.title}</strong><small>{preset.id === "grok" ? "xAI 云端常驻 Agent，自带云电脑与 Webhook 唤醒。" : "Meta 云端常驻 Agent，运行在安全虚拟机。"}</small></span>
    <span className="wb-cloud-card__action">{expanded ? "收起" : "接入"}{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
  </button>;
}
