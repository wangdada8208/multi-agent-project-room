import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { TeamConfigEditor } from "../components/collab/TeamConfigEditor";
import type { TeamConfig } from "../types/chat";

export function TeamPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);

  const handleSave = (config: TeamConfig) => {
    // TODO: persist to backend
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="team-page">
      <header className="team-page__header">
        <Link to={roomId ? `/rooms/${roomId}` : "/"} className="chat-area__back">←</Link>
        <h1>团队配置</h1>
        <p>定义 Agent 角色和协作规则，导出为 Markdown 后可在对话循环中使用。</p>
      </header>
      <TeamConfigEditor onSave={handleSave} />
      {saved && <p className="team-saved-toast">✅ 配置已保存</p>}
    </div>
  );
}
