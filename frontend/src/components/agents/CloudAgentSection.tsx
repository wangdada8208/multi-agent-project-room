import { Cloud } from "lucide-react";
import { useId } from "react";
import { AGENT_PRESETS, type CloudAgentPreset } from "../../lib/agentPresets";
import { Tag } from "../ui/Tag";
import { CloudAgentCard } from "./CloudAgentCard";
import { CloudConnectPanel } from "./CloudConnectPanel";

export function CloudAgentSection({ selected, onSelect, roomId, roomName, roomsLoaded, hubOrigin, wizard }: {
  selected?: CloudAgentPreset;
  onSelect: (preset?: CloudAgentPreset) => void;
  roomId: string;
  roomName?: string;
  roomsLoaded: boolean;
  hubOrigin: string;
  wizard?: boolean;
}) {
  const id = useId();
  return <section className="wb-cloud">
    <div className="wb-agents-section-head"><Cloud size={18} /><h2>手机和网页直接用的助手</h2><Tag tone="cloud">手机可用</Tag></div>
    <div className="wb-cloud-grid">
      {AGENT_PRESETS.filter((item) => item.mode === "cloud-agent").map((preset) => <CloudAgentCard key={preset.id}
        preset={preset} expanded={selected?.id === preset.id} controls={id} onToggle={() => onSelect(selected?.id === preset.id ? undefined : preset)} />)}
    </div>
    <div id={id}>
      {selected && <CloudConnectPanel preset={selected} roomId={roomId} roomName={roomName} roomsLoaded={roomsLoaded}
        defaultApproval={!wizard} hubOrigin={hubOrigin} onClose={() => onSelect(undefined)} />}
    </div>
  </section>;
}
