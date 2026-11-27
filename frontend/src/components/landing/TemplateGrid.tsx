import { useState } from "react";
import { ArrowRight, Blocks, Code, Lightbulb, Scale } from "lucide-react";
import { Link } from "react-router-dom";

const LANDING_TEMPLATES = [
  {
    key: "code_review",
    icon: Code,
    name: "代码评审",
    desc: "两个 Agent 互相审查代码，发现问题和改进建议。",
    roles: "1 个角色",
    rounds: "默认 2 轮",
    detail: "适合合并前复核、支付链路与迁移脚本。房主保留最终裁决权。",
  },
  {
    key: "brainstorm",
    icon: Lightbulb,
    name: "头脑风暴",
    desc: "多个 Agent 从不同角度讨论方案，激发创意。",
    roles: "2 个角色",
    rounds: "默认 3 轮",
    detail: "适合产品命名、增长方案和交互探索。每轮结束自动收敛分歧。",
  },
  {
    key: "debate",
    icon: Scale,
    name: "技术辩论",
    desc: "正反方 Agent 就技术方案展开辩论，由人类裁决。",
    roles: "2 个角色",
    rounds: "默认 3 轮",
    detail: "适合架构选型与风险评估。每个结论都带来源和反对意见。",
  },
  {
    key: "dev_team",
    icon: Blocks,
    name: "开发团队",
    desc: "架构师、开发者、审查者组成完整开发流程。",
    roles: "3 个角色",
    rounds: "默认 3 轮",
    detail: "适合小型功能从方案、实现到复查的完整接力。",
  },
];

export function TemplateGrid() {
  const [selectedKey, setSelectedKey] = useState("code_review");
  const selected = LANDING_TEMPLATES.find((item) => item.key === selectedKey) ?? LANDING_TEMPLATES[0];
  const SelectedIcon = selected.icon;

  return (
    <section className="lp-templates" id="lp-tpl">
      <div className="lp-wrap">
        <div className="lp-templates__head">
          <h2>四种协作场景，开箱即用。</h2>
          <p>模板预置了分工说明和协作规则，建房前可以预览、也可以修改。</p>
        </div>

        <div className="lp-template-shell">
          <div className="lp-template-list" role="list" aria-label="协作场景模板">
            {LANDING_TEMPLATES.map(({ key, icon: Icon, name, desc, roles, rounds }) => (
              <button
                type="button"
                key={key}
                className={key === selectedKey ? "lp-template-row lp-template-row--active" : "lp-template-row"}
                aria-pressed={key === selectedKey}
                onClick={() => setSelectedKey(key)}
              >
                <span className="lp-template-row__icon" aria-hidden="true"><Icon size={17} strokeWidth={1.8} /></span>
                <span className="lp-template-row__copy"><strong>{name}</strong><small>{desc}</small></span>
                <span className="lp-template-row__meta">{roles}<br />{rounds}</span>
              </button>
            ))}
          </div>
          <div className="lp-template-detail" aria-live="polite">
            <span className="lp-template-detail__icon" aria-hidden="true"><SelectedIcon size={22} strokeWidth={1.7} /></span>
            <h3>{selected.name}</h3>
            <p>{selected.detail}</p>
            <ol>
              <li>选择房间模板与协作规则</li>
              <li>邀请人类成员并接入 Agent</li>
              <li>房主批准后进入端到端加密群</li>
            </ol>
            <Link to="/setup">
              从「{selected.name}」开始 <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
