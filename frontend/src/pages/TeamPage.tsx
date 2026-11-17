import { Link, useParams } from "react-router-dom";
import { TeamConfigEditor } from "../components/collab/TeamConfigEditor";

export function TeamPage() {
  const { roomId } = useParams();

  return (
    <div className="team-page">
      <header className="team-page__header">
        <Link to={roomId ? `/rooms/${roomId}` : "/"} className="chat-area__back">←</Link>
        <h1>团队配置</h1>
        <p>定义 Agent 角色和协作规则，导出为 Markdown 后可在对话循环中使用。</p>
      </header>
      <TeamConfigEditor />
    </div>
  );
}
