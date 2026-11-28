import { ChevronDown, ChevronUp } from "lucide-react";
import type { CloudAgentPreset } from "../../lib/agentPresets";
import { Avatar } from "../ui/Avatar";

export function CloudAgentCard({ preset, expanded, controls, onToggle }: {
  preset: CloudAgentPreset;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return <button type="button" className="wb-cloud-card agents-preset-card" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
    <Avatar actor="cloud" name={preset.title} size="lg" />
    <span className="wb-cloud-card__copy"><strong>{preset.title}</strong><small>{preset.subtitle}</small></span>
    <span className="wb-cloud-card__action">{expanded ? "收起" : "接入"}{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
  </button>;
}
