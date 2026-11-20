import type { HouseRuleDecision, HouseRules, RoomTemplateInfo } from "../lib/api";

export const HOUSE_RULE_LABEL: Record<HouseRuleDecision | string, string> = {
  ask: "每次需当场批准",
  cannot: "建议一律禁止",
};

/** 模板建议内容的只读预览：规则建议 + 分工说明 + 默认轮次。 */
export function TemplatePreview({ template }: { template: RoomTemplateInfo }) {
  const rules: HouseRules | null = template.house_rules ?? null;
  const scopeRows = Object.entries(rules?.scopes ?? {});
  const notes = rules?.notes ?? [];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        borderRadius: 10,
        background: "#f5f5f7",
        border: "1px solid rgba(0, 0, 0, 0.06)",
        fontSize: 12,
        color: "#1d1d1f",
      }}
    >
      <strong style={{ fontSize: 12.5 }}>模板预置内容预览</strong>
      <p style={{ fontSize: 11.5, color: "#6e6e73", lineHeight: 1.5, margin: 0 }}>
        以下仅是发给各 Agent 本机助手的建议；本机规则与主人的当场决定才是权威。
      </p>
      {scopeRows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600 }}>规则建议</span>
          {scopeRows.map(([scope, decision]) => (
            <div key={scope} style={{ display: "flex", gap: 8, fontSize: 11.5 }}>
              <code style={{ fontFamily: "var(--mono)", flex: 1 }}>{scope}</code>
              <span style={{ color: "#6e6e73" }}>{HOUSE_RULE_LABEL[decision] ?? decision}</span>
            </div>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, color: "#6e6e73", lineHeight: 1.5 }}>
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {template.team_config_markdown && (
        <details>
          <summary style={{ fontSize: 11.5, cursor: "pointer", color: "#6e6e73" }}>
            查看分工说明（Markdown）
          </summary>
          <pre
            style={{
              margin: "6px 0 0",
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 180,
              overflow: "auto",
              fontFamily: "inherit",
              color: "#1d1d1f",
            }}
          >
            {template.team_config_markdown}
          </pre>
        </details>
      )}
      {template.default_max_rounds != null && (
        <span style={{ fontSize: 11.5, color: "#6e6e73" }}>
          默认辩论轮次上限：{template.default_max_rounds}
        </span>
      )}
    </div>
  );
}

export interface TemplateOverrideDraft {
  house_rules: HouseRules;
  team_config_markdown: string;
  default_max_rounds?: number;
}

/** 把模板建议值转成可编辑草稿。 */
export function draftFromTemplate(template: RoomTemplateInfo): TemplateOverrideDraft {
  return {
    house_rules: {
      scopes: { ...(template.house_rules?.scopes ?? {}) },
      notes: [...(template.house_rules?.notes ?? [])],
    },
    team_config_markdown: template.team_config_markdown ?? "",
    default_max_rounds: template.default_max_rounds ?? undefined,
  };
}
