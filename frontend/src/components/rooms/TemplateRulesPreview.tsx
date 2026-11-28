import { ChevronRight, ListChecks, MessageSquare, Plus, X } from "lucide-react";
import type { HouseRuleDecision, RoomTemplateInfo } from "../../lib/api";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Tag } from "../ui/Tag";
import {
  HOUSE_RULE_DECISION_LABEL,
  parseTemplateRoles,
  SCOPE_LABELS,
  type ParsedTemplateRole,
  type TemplateOverrideDraft,
} from "./templateMeta";

export interface TemplateRulesPreviewProps {
  template: RoomTemplateInfo | null;
  draft: TemplateOverrideDraft | null;
  customizing: boolean;
  onToggleCustomizing: () => void;
  onChangeDraft: (updater: (prev: TemplateOverrideDraft) => TemplateOverrideDraft) => void;
}

function humanRoleName(name: string): string {
  const cleaned = name
    .replace(/\s*\([^)]*\)/gu, "")
    .replace(/(?:\s+[A-Za-z][A-Za-z-]*)+$/u, "")
    .trim();
  return cleaned || name;
}

function joinAlternatives(items: readonly string[]): string {
  const unique = [...new Set(items)];
  if (unique.length <= 1) return unique[0] ?? "使用外部能力";
  return `${unique.slice(0, -1).join("、")}或${unique[unique.length - 1]}`;
}

function buildTemplateSummaries(
  roles: readonly ParsedTemplateRole[],
  scopeEntries: readonly (readonly [string, HouseRuleDecision])[],
  notes: readonly string[],
  rounds: number | undefined,
): string[] {
  const summaries: string[] = [];
  const roleNames = roles.map((role) => humanRoleName(role.name)).filter(Boolean).slice(0, 3);
  if (roleNames.length === 1) summaries.push(`${roleNames[0]}负责协作。`);
  if (roleNames.length > 1) summaries.push(`${roleNames.join("、")}分工协作。`);

  const askLabels = scopeEntries
    .filter(([scope, decision]) => decision === "ask" && scope !== "gmail.send")
    .map(([scope]) => SCOPE_LABELS[scope] ?? "使用外部能力");
  if (askLabels.length > 0) summaries.push(`${joinAlternatives(askLabels)}前，都会先问主人。`);

  const gmailDecision = scopeEntries.find(([scope]) => scope === "gmail.send")?.[1];
  if (gmailDecision === "cannot") summaries.push("不会替主人对外发邮件。");
  if (gmailDecision === "ask") summaries.push("对外发邮件前也必须得到主人当场批准。");

  if (summaries.length < 3 && notes.length > 0) {
    summaries.push(`还附带 ${notes.length} 条房间建议，可在详情中查看。`);
  }
  if (summaries.length < 3 && rounds != null) {
    summaries.push(`默认最多 ${rounds} 轮，避免讨论失控。`);
  }
  return summaries.slice(0, 3);
}

export function TemplateRulesPreview({
  template,
  draft,
  customizing,
  onToggleCustomizing,
  onChangeDraft,
}: TemplateRulesPreviewProps) {
  if (!template) {
    return (
      <div className="wb-preview-box">
        <header className="wb-preview-box__head">
          <MessageSquare size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>空白房间</span>
        </header>
        <section className="wb-preview-box__section">
          <p className="wb-preview-blank">
            不预置分工和规则。建房后可以在房间的「规则」面板里随时补充。
          </p>
        </section>
      </div>
    );
  }

  const activeDraft = draft ?? {
    house_rules: {
      scopes: { ...(template.house_rules?.scopes ?? {}) },
      notes: [...(template.house_rules?.notes ?? [])],
    },
    team_config_markdown: template.team_config_markdown ?? "",
    default_max_rounds: template.default_max_rounds ?? undefined,
  };

  const roles = parseTemplateRoles(activeDraft.team_config_markdown);
  const scopeEntries = Object.entries(activeDraft.house_rules.scopes);
  const notes = activeDraft.house_rules.notes;
  const rounds = activeDraft.default_max_rounds ?? template.default_max_rounds ?? undefined;
  const summaries = buildTemplateSummaries(roles, scopeEntries, notes, rounds);
  const hasAdvancedDetails = roles.length > 0 || scopeEntries.length > 0 || notes.length > 0;

  return (
    <div className="wb-preview-box">
      <header className="wb-preview-box__head">
        <ListChecks size={14} strokeWidth={1.9} aria-hidden="true" />
        <span>房间规则预览</span>
        <small>
          {rounds != null ? `默认 ${rounds} 轮 · ` : ""}建房后可在「规则」中修改
        </small>
      </header>

      {summaries.length > 0 && (
        <section className="wb-preview-box__section">
          <h5>这个模板会做什么</h5>
          <ul className="wb-preview-summary">
            {summaries.map((summary) => (
              <li key={summary}>{summary}</li>
            ))}
          </ul>
        </section>
      )}

      {hasAdvancedDetails && (
        <section className="wb-preview-box__section">
          <details className="wb-preview-advanced">
            <summary>查看完整分工与机器范围</summary>
            <div className="wb-preview-advanced__body">
              {roles.length > 0 && (
                <div>
                  <h5>分工</h5>
                  <div className="wb-preview-roles">
                    {roles.map((role) => (
                      <div key={role.name} className="wb-preview-role">
                        <strong>{role.name}</strong>
                        <span>{role.summary}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {scopeEntries.length > 0 && (
                <div>
                  <h5>Agent 行为规则</h5>
                  <div className="wb-preview-rules">
                    {scopeEntries.map(([scope, decision]) => (
                      <div key={scope} className="wb-preview-rule">
                        <span className="wb-preview-rule__scope">
                          <span className="wb-preview-rule__label">{SCOPE_LABELS[scope] ?? "自定义外部能力"}</span>
                          <code>{scope}</code>
                        </span>
                        <Tag tone={decision === "cannot" ? "warn" : "neutral"}>
                          {HOUSE_RULE_DECISION_LABEL[decision] ?? decision}
                        </Tag>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {notes.length > 0 && (
                <ul className="wb-preview-notes">
                  {notes.map((note, idx) => (
                    <li key={`${idx}-${note}`}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </section>
      )}

      <section className="wb-preview-box__section">
        <div className="wb-preview-box__foot">
          <span className="wb-preview-box__help">规则是建议，最终以各成员本机授权为准。</span>
          <Button variant="ghost" size="sm" onClick={onToggleCustomizing}>
            {customizing ? "收起自定义" : "自定义"}
            {!customizing && <ChevronRight size={13} strokeWidth={2} />}
          </Button>
        </div>
      </section>

      {customizing && (
        <section className="wb-preview-box__section">
          <div className="wb-preview-custom">
            <h5>自定义范围建议</h5>
            {scopeEntries.map(([scope, decision]) => (
              <div key={scope} className="wb-preview-custom__row">
                <input
                  className="wb-preview-custom__scope-input"
                  aria-label={`范围 ${scope}`}
                  value={scope}
                  onChange={(e) =>
                    onChangeDraft((prev) => ({
                      ...prev,
                      house_rules: {
                        ...prev.house_rules,
                        scopes: Object.fromEntries(
                          Object.entries(prev.house_rules.scopes).map(([k, v]) => [
                            k === scope ? e.target.value : k,
                            v,
                          ]),
                        ),
                      },
                    }))
                  }
                  placeholder="scope，如 gmail.send"
                />
                <select
                  className="wb-create-drawer__select"
                  aria-label={`${scope} 规则`}
                  value={decision}
                  onChange={(e) =>
                    onChangeDraft((prev) => ({
                      ...prev,
                      house_rules: {
                        ...prev.house_rules,
                        scopes: {
                          ...prev.house_rules.scopes,
                          [scope]: e.target.value as HouseRuleDecision,
                        },
                      },
                    }))
                  }
                >
                  <option value="ask">需询问</option>
                  <option value="cannot">不允许</option>
                </select>
                <IconButton
                  label={`删除规则 ${scope}`}
                  size="sm"
                  onClick={() =>
                    onChangeDraft((prev) => ({
                      ...prev,
                      house_rules: {
                        ...prev.house_rules,
                        scopes: Object.fromEntries(
                          Object.entries(prev.house_rules.scopes).filter(([k]) => k !== scope),
                        ),
                      },
                    }))
                  }
                >
                  <X size={13} strokeWidth={1.9} />
                </IconButton>
              </div>
            ))}
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChangeDraft((prev) => {
                    let n = 1;
                    while (`custom.rule_${n}` in prev.house_rules.scopes) n += 1;
                    return {
                      ...prev,
                      house_rules: {
                        ...prev.house_rules,
                        scopes: { ...prev.house_rules.scopes, [`custom.rule_${n}`]: "ask" },
                      },
                    };
                  })
                }
              >
                <Plus size={13} strokeWidth={2} />
                添加范围建议
              </Button>
            </div>

            <div className="wb-create-drawer__field">
              <label className="wb-create-drawer__label" htmlFor="tpl-custom-md">
                分工说明（Markdown）
              </label>
              <textarea
                id="tpl-custom-md"
                className="wb-create-drawer__textarea"
                rows={4}
                value={activeDraft.team_config_markdown}
                onChange={(e) =>
                  onChangeDraft((prev) => ({ ...prev, team_config_markdown: e.target.value }))
                }
                placeholder="分工说明（Markdown，纯建议文字）"
              />
            </div>

            <label className="wb-preview-custom__rounds">
              <span>默认轮次上限</span>
              <input
                type="number"
                min={1}
                max={64}
                value={activeDraft.default_max_rounds ?? ""}
                onChange={(e) =>
                  onChangeDraft((prev) => ({
                    ...prev,
                    default_max_rounds: e.target.value
                      ? Math.min(64, Math.max(1, Number(e.target.value)))
                      : undefined,
                  }))
                }
              />
            </label>
          </div>
        </section>
      )}
    </div>
  );
}
