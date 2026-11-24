import { useState } from "react";
import { useTargetRoom } from "../../hooks/agents/useTargetRoom";
import { apiUrl } from "../../lib/api";
import type { CloudAgentPreset } from "../../lib/agentPresets";
import type { SeatViewLocal } from "../../lib/localHelper";
import { CloudAgentSection } from "./CloudAgentSection";
import { LocalAgentSection } from "./LocalAgentSection";
import { CreateTargetRoom, TargetRoomPicker } from "./TargetRoomPicker";
import "./Agents.css";

export interface AgentJoinSectionProps {
  roomId?: string;
  roomName?: string;
  defaultRoomId?: string;
  ownerXmtpAddress?: string;
  onJoined?: (seat: SeatViewLocal) => void;
}

export function AgentJoinSection({ roomId, roomName, defaultRoomId, ownerXmtpAddress, onJoined }: AgentJoinSectionProps) {
  const target = useTargetRoom({ fixedRoomId: roomId, selectedRoomId: defaultRoomId });
  const [cloud, setCloud] = useState<CloudAgentPreset>();
  const hubOrigin = apiUrl("").replace(/\/$/u, "") || window.location.origin;
  return <div className="wb-agents-flow">
    {!roomId && <TargetRoomPicker target={target} />}
    <CreateTargetRoom target={target} />
    <CloudAgentSection selected={cloud} onSelect={setCloud} roomId={target.roomId}
      roomName={roomName ?? target.rooms.find(({ id }) => id === target.roomId)?.name}
      roomsLoaded={target.roomsLoaded} hubOrigin={hubOrigin} wizard />
    <LocalAgentSection roomId={target.roomId} hubOrigin={hubOrigin} ownerXmtpAddress={ownerXmtpAddress} onJoined={onJoined} legacyMobile />
  </div>;
}
