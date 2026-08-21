import { useState } from "react";
import type { TeamConfig, TeamRoleConfig } from "../../types/chat";

interface TeamConfigEditorProps {
  initialConfig?: Partial<TeamConfig>;
  onSave?: (config: TeamConfig) => void;
}

const EMPTY_ROLE: TeamRoleConfig = {
  name: "",
  agent_name: "",
  responsibilities: [],
  focus_areas: [],
  ignore_areas: [],
};

export function TeamConfigEditor({ initialConfig, onSave }: TeamConfigEditorProps) {
  const [title, setTitle] = useState(initialConfig?.title || "");
  const [roles, setRoles] = useState<TeamRoleConfig[]>(
    initialConfig?.roles?.length ? initialConfig.roles : [{ ...EMPTY_ROLE }]
  );
  const [rules, setRules] = useState(initialConfig?.rules?.join("\n") || "");

  const updateRole = (index: number, field: keyof TeamRoleConfig, value: string | string[]) => {
    setRoles((prev) =>
      prev.map((r, i) => (i === index ? { ...r, [field]: value } : r))
    );
  };

  const addRole = () => {
    setRoles((prev) => [...prev, { ...EMPTY_ROLE }]);
  };

  const removeRole = (index: number) => {
    setRoles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (!onSave) return;
    onSave({
      title,
      roles,
      rules: rules.split("\n").filter(Boolean),
    });
  };

  const exportMarkdown = (): string => {
    let md = `# 团队配置：${title || "未命名"}\n\n## 成员\n\n`;
    for (const role of roles) {
      md += `### ${role.name} (${role.agent_name})\n`;
      if (role.responsibilities.length)
        md += `- 职责：${role.responsibilities.join("、")}\n`;
      if (role.focus_areas.length)
        md += `- 关注范围：${role.focus_areas.join("、")}\n`;
      if (role.ignore_areas.length)
        md += `- 不关注：${role.ignore_areas.join("、")}\n`;
      md += "\n";
    }
    if (rules.trim()) {
      md += `## 协作规则\n\n`;
      for (const [i, rule] of rules.split("\n").filter(Boolean).entries()) {
        md += `${i + 1}. ${rule}\n`;
      }
    }
    return md;
  };

  return (
    <div className="team-editor">
      <div className="team-editor__section">
        <div className="team-editor__section-title">团队名称</div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：项目开发组"
          style={{ width: "100%", padding: "8px", borderRadius: 6, border: "1px solid #d1d5db" }}
        />
      </div>

      <div className="team-editor__section">
        <div className="team-editor__section-title">成员角色</div>
        {roles.map((role, i) => (
          <div key={i} className="team-role-card">
            <div className="team-role-card__header">
              <span className="team-role-card__name">
                角色 {i + 1}
              </span>
              <button
                type="button"
                className="team-role-remove"
                onClick={() => removeRole(i)}
              >
                删除
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div className="team-role-field">
                <label>角色名</label>
                <input
                  value={role.name}
                  onChange={(e) => updateRole(i, "name", e.target.value)}
                  placeholder="架构师"
                />
              </div>
              <div className="team-role-field">
                <label>Agent 名称</label>
                <input
                  value={role.agent_name}
                  onChange={(e) => updateRole(i, "agent_name", e.target.value)}
                  placeholder="Claude"
                />
              </div>
            </div>
            <div className="team-role-field">
              <label>职责（用顿号分隔）</label>
              <input
                value={role.responsibilities.join("、")}
                onChange={(e) => updateRole(i, "responsibilities", e.target.value.split("、"))}
                placeholder="系统设计、技术选型、架构评审"
              />
            </div>
            <div className="team-role-field">
              <label>关注范围（用顿号分隔）</label>
              <input
                value={role.focus_areas.join("、")}
                onChange={(e) => updateRole(i, "focus_areas", e.target.value.split("、"))}
                placeholder="整体架构、模块边界"
              />
            </div>
            <div className="team-role-field">
              <label>不关注（用顿号分隔）</label>
              <input
                value={role.ignore_areas.join("、")}
                onChange={(e) => updateRole(i, "ignore_areas", e.target.value.split("、"))}
                placeholder="具体代码实现细节"
              />
            </div>
          </div>
        ))}
        <button type="button" onClick={addRole} style={{ padding: "6px 16px", borderRadius: 6, border: "1px dashed #9ca3af", background: "none", cursor: "pointer" }}>
          + 添加角色
        </button>
      </div>

      <div className="team-editor__section">
        <div className="team-editor__section-title">协作规则</div>
        <textarea
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          rows={5}
          placeholder={"每行一条规则\n开发者完成代码后必须提交给审查者\n审查者发现问题直接反馈给开发者"}
          style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #d1d5db", resize: "vertical" }}
        />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {onSave && (
          <button type="button" onClick={handleSave} style={{ padding: "8px 20px", borderRadius: 6, background: "#2563eb", color: "#fff", border: "none", cursor: "pointer" }}>
            保存配置
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            const md = exportMarkdown();
            navigator.clipboard.writeText(md);
          }}
          style={{ padding: "8px 20px", borderRadius: 6, background: "#f3f4f6", border: "1px solid #d1d5db", cursor: "pointer" }}
        >
          复制 Markdown
        </button>
      </div>

      <details>
        <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "#6b7280" }}>
          预览 Markdown
        </summary>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.75rem", background: "#f9fafb", padding: 12, borderRadius: 8, marginTop: 8 }}>
          {exportMarkdown()}
        </pre>
      </details>
    </div>
  );
}
