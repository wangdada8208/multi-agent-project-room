import type { PresenceParticipant } from "../../types/chat";
import { TRUST_TIER_LABEL, trustTierOf, type HubSeatView } from "../../lib/localHelper";

export function MembersPanel({
  participants,
  seats,
}: {
  participants: PresenceParticipant[];
  seats?: HubSeatView[];
}) {
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

      {seats && seats.length > 0 && (
        <>
          <p className="panel-heading" style={{ marginTop: 8 }}>席位 ({seats.length})</p>
          {seats.map((s) => {
            const tier = s.trust_tier ?? trustTierOf(s.kind);
            return (
              <div key={s.seat_id} className="member-row">
                <span className="member-dot member-dot--agent" />
                <span>💺 {s.agent_display_name}</span>
                <span className={`tier-badge tier-badge--${tier}`} title={TIER_TITLE[tier]}>
                  {TRUST_TIER_LABEL[tier]}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

const TIER_TITLE: Record<string, string> = {
  "local-cli": "在你自己的电脑上运行，聊天内容不出本机",
  "cloud-api": "回话时要把消息发给第三方云端接口",
  "custom-webhook": "回话时要把消息发给主人自己配置的地址",
};
