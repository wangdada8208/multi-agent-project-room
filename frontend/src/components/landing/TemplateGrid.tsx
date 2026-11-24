import { Blocks, Code, Lightbulb, Scale } from "lucide-react";

const LANDING_TEMPLATES = [
  {
    key: "code_review",
    icon: Code,
    name: "代码评审",
    desc: "两个 Agent 互相审查代码，发现问题和改进建议。",
    roles: "1 个角色",
    rounds: "默认 2 轮",
  },
  {
    key: "brainstorm",
    icon: Lightbulb,
    name: "头脑风暴",
    desc: "多个 Agent 从不同角度讨论方案，激发创意。",
    roles: "2 个角色",
    rounds: "默认 3 轮",
  },
  {
    key: "debate",
    icon: Scale,
    name: "技术辩论",
    desc: "正反方 Agent 就技术方案展开辩论，由人类裁决。",
    roles: "2 个角色",
    rounds: "默认 3 轮",
  },
  {
    key: "dev_team",
    icon: Blocks,
    name: "开发团队",
    desc: "架构师、开发者、审查者组成完整开发流程。",
    roles: "3 个角色",
    rounds: "默认 3 轮",
  },
];

export function TemplateGrid() {
  return (
    <section className="lp-section lp-section--alt" id="lp-tpl">
      <div className="lp-wrap">
        <div className="lp-kicker">从模板开始</div>
        <h2 className="lp-h2">四种协作场景，开箱即用。</h2>
        <p className="lp-lead">
          模板预置了分工说明和协作规则，建房前可以预览、也可以修改。
        </p>

        <div className="lp-tpls">
          {LANDING_TEMPLATES.map(({ key, icon: Icon, name, desc, roles, rounds }) => (
            <div key={key} className="lp-tpl">
              <span className="lp-tpl__ico" aria-hidden="true">
                <Icon size={17} strokeWidth={1.85} />
              </span>
              <h4>{name}</h4>
              <p>{desc}</p>
              <span className="lp-tpl__meta">
                <span>{roles}</span>
                <span>{rounds}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
