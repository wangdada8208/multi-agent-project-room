import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell";
import { CloudAgentSection } from "../components/agents/CloudAgentSection";
import { DesktopOnlyNotice } from "../components/agents/DesktopOnlyNotice";
import { LocalAgentSection } from "../components/agents/LocalAgentSection";
import { PairedDevices } from "../components/agents/PairedDevices";
import { CreateTargetRoom, TargetRoomPicker } from "../components/agents/TargetRoomPicker";
import { Drawer } from "../components/ui/Drawer";
import { useViewportWidth } from "../hooks/useViewportWidth";
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
  const preset = findAgentPreset(params.get("agent") ?? "");
  const target = useTargetRoom({ selectedRoomId: params.get("room") ?? undefined, onSelect: (id) => setParam("room", id) });
  const hubOrigin = apiUrl("").replace(/\/$/u, "") || window.location.origin;

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
          <p>云端 Agent 用手机就能接入；电脑端 Agent 需要在电脑上配对一次。</p>
        </div>
        <TargetRoomPicker target={target} />
      </header>
      <CreateTargetRoom target={target} />
      <CloudAgentSection selected={preset?.mode === "cloud-agent" ? preset : undefined} onSelect={(selected) => setParam("agent", selected?.id)}
        roomId={target.roomId} roomName={target.rooms.find(({ id }) => id === target.roomId)?.name}
        roomsLoaded={target.roomsLoaded} hubOrigin={hubOrigin} />
      {phone ? <DesktopOnlyNotice roomId={target.roomId} /> : <>
        <LocalAgentSection roomId={target.roomId} hubOrigin={hubOrigin} onManage={() => setManaging(true)} />
        {managing && <Drawer open title="管理设备" onClose={() => setManaging(false)}><PairedDevices /></Drawer>}
      </>}
    </div>
  </AppShell>;
}
