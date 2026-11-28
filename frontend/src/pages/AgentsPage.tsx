import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell";
import { AgentPromptSetupPicker } from "../components/AgentPromptSetupPicker";
import { CloudAgentSection } from "../components/agents/CloudAgentSection";
import { LocalAgentSection } from "../components/agents/LocalAgentSection";
import { PairedDevices } from "../components/agents/PairedDevices";
import { CreateTargetRoom, TargetRoomPicker } from "../components/agents/TargetRoomPicker";
import { Drawer } from "../components/ui/Drawer";
import { useViewportWidth } from "../hooks/useViewportWidth";
import { useLocalHelper } from "../hooks/useLocalHelper";
import { PairingCodeContext, usePairingCode } from "../hooks/agents/useLocalAgents";
import { useTargetRoom } from "../hooks/agents/useTargetRoom";
import { findAgentPreset } from "../lib/agentPresets";
import { apiUrl } from "../lib/api";
import { isMobileBrowser } from "../lib/localHelper";
import "../components/agents/Agents.css";

export { AgentJoinSection, type AgentJoinSectionProps } from "../components/agents/AgentJoinSection";

export function AgentsPage() {
  const [params, setParams] = useSearchParams();
  const [managing, setManaging] = useState(false);
  const phone = useViewportWidth() < 768 || isMobileBrowser();
  const { probe } = useLocalHelper(!phone);
  const paired = !phone && probe?.state === "running" && probe.hello.paired;
  const pairing = usePairingCode();
  const preset = findAgentPreset(params.get("agent") ?? "");
  const target = useTargetRoom({ selectedRoomId: params.get("room") ?? undefined, onSelect: (id) => setParam("room", id) });
  const hubOrigin = new URL(apiUrl(""), window.location.href).origin;
  const targetRoomName = target.rooms.find(({ id }) => id === target.roomId)?.name;

  function setParam(key: string, value?: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }

  return <AppShell>
    <div className="wb-agents-page">
      <header className="wb-agents-head">
        <div>
          <h1>接入 Agent</h1>
          <p>选择你正在使用的客户端，复制专属提示词给 Agent。</p>
        </div>
        <TargetRoomPicker target={target} />
      </header>
      <CreateTargetRoom target={target} />
      <AgentPromptSetupPicker key={phone ? "phone" : "desktop"} compact mobile={phone}
        defaultClient={phone ? "cloud-webhook" : "claude-code"} roomId={target.roomId || undefined}
        roomName={targetRoomName} hubOrigin={hubOrigin} webOrigin={window.location.origin}
        localPaired={paired} pairing={phone ? undefined : pairing} />
      <CloudAgentSection selected={preset?.mode === "cloud-agent" ? preset : undefined} onSelect={(selected) => setParam("agent", selected?.id)}
        roomId={target.roomId} roomName={targetRoomName}
        roomsLoaded={target.roomsLoaded} hubOrigin={hubOrigin} />
      {!phone && <PairingCodeContext.Provider value={pairing}>
        <LocalAgentSection roomId={target.roomId} hubOrigin={hubOrigin} onManage={() => setManaging(true)} />
        {managing && <Drawer open title="管理设备" onClose={() => setManaging(false)}><PairedDevices /></Drawer>}
      </PairingCodeContext.Provider>}
    </div>
  </AppShell>;
}
