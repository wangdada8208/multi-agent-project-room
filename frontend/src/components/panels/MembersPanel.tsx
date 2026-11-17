import type { PresenceParticipant } from "../../types/chat";

export function MembersPanel({ participants }: { participants: PresenceParticipant[] }) {
  const humans = participants.filter((p) => p.sender_type === "human");
  const agents = participants.filter((p) => p.sender_type === "agent");

  return (
    <div className="panel-section">
      <p className="panel-heading">人类 ({humans.length})</p>
      {humans.length === 0 && <p className="panel-empty">暂无</p>}
      {humans.map((p) => (
        <div key={p.sender_id} className="member-row">
          <span className="member-dot" />
          <span>{p.sender_name || p.sender_id.slice(0, 8)}</span>
        </div>
      ))}

      <p className="panel-heading" style={{ marginTop: 8 }}>Agent ({agents.length})</p>
      {agents.length === 0 && (
        <p className="panel-empty">暂无 Agent 在线。<br /><span className="panel-hint">运行「一键配置」接入你的 Agent。</span></p>
      )}
      {agents.map((p) => (
        <div key={p.sender_id} className="member-row">
          <span className="member-dot member-dot--agent" />
          <span>🤖 {p.sender_name || p.sender_id}</span>
        </div>
      ))}
    </div>
  );
}
