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
    <div className="wb-preview-box">
      <header className="wb-preview-box__head">
        <span>模板预置内容预览</span>
      </header>
      <section className="wb-preview-box__section">
        <p className="wb-preview-box__help">
          以下仅是发给各 Agent 本机助手的建议；本机规则与主人的当场决定才是权威。
        </p>
        {scopeRows.length > 0 && (
          <div className="wb-preview-rules">
            {scopeRows.map(([scope, decision]) => (
              <div key={scope} className="wb-preview-rule">
                <span className="wb-preview-rule__scope">
                  <code>{scope}</code>
                </span>
                <span>{HOUSE_RULE_LABEL[decision] ?? decision}</span>
              </div>
            ))}
          </div>
        )}
        {notes.length > 0 && (
          <ul className="wb-preview-notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {template.default_max_rounds != null && (
          <p className="wb-preview-box__help">
            默认辩论轮次上限：{template.default_max_rounds}
          </p>
        )}
      </section>
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
