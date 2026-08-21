import type { PresenceParticipant } from "../../types/chat";

export function MembersPanel({ participants }: { participants: PresenceParticipant[] }) {
  const humans = participants.filter((p) => p.sender_type === "human");
  const agents = participants.filter((p) => p.sender_type === "agent");

  return (
    <div className="panel-section">
      <h4>人类 ({humans.length})</h4>
      {humans.map((p) => (
        <div key={p.sender_id} className="member-row">
          <span className="member-dot member-dot--online" />
          <span>{p.sender_name || p.sender_id.slice(0, 8)}</span>
        </div>
      ))}
      {humans.length === 0 && <p className="panel-empty">暂无</p>}

      <h4>Agent ({agents.length})</h4>
      {agents.map((p) => (
        <div key={p.sender_id} className="member-row">
          <span className="member-dot member-dot--agent" />
          <span>🤖 {p.sender_name || p.sender_id}</span>
        </div>
      ))}
      {agents.length === 0 && <p className="panel-empty">暂无 Agent 在线</p>}
    </div>
  );
}
