import { TeamConfigEditor } from "../collab/TeamConfigEditor";

export function TeamPanel() {
  return (
    <div className="panel-section">
      <p className="panel-hint">用 Markdown 定义团队角色，Agent 按角色参与协作。配置暂不支持保存到房间，请复制 Markdown 后自行存放。</p>
      <TeamConfigEditor />
    </div>
  );
}
