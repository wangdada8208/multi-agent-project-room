import { useState } from "react";
import { TeamConfigEditor } from "../collab/TeamConfigEditor";
import type { TeamConfig } from "../../types/chat";

export function TeamPanel() {
  const [saved, setSaved] = useState(false);
  const [config, setConfig] = useState<TeamConfig | null>(null);

  return (
    <div className="panel-section">
      <p className="panel-hint">用 Markdown 定义团队角色，Agent 按角色参与协作。</p>
      {saved && <div className="badge badge--consensus" style={{ marginBottom: 8 }}>✅ 已复制到剪贴板</div>}
      <TeamConfigEditor
        onSave={(c) => {
          setConfig(c);
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        }}
      />
      {config && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "var(--text-tertiary)" }}>
            当前配置 ({config.roles.length} 个角色)
          </summary>
          <pre style={{ fontSize: "0.75rem", background: "var(--bg-elevated)", padding: 10, borderRadius: 6, overflow: "auto", maxHeight: 200 }}>
            {JSON.stringify(config, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
