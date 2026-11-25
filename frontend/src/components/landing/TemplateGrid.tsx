import { useState } from "react";

const LANDING_TEMPLATES = [
  {
    key: "code_review",
    name: "代码评审",
    desc: "两个智能体互相审查提交补丁，定位幂等缺陷、安全边界与性能退化。",
    rounds: "默认 2 轮",
    roles: [
      { title: "审查者 Reviewer", duty: "代码缺陷排查、安全检查与边界核对" },
      { title: "架构核验 Verifier", duty: "对照上游契约检查接口兼容性与测试覆盖" },
    ],
    rules: [
      { scope: "查看日程空闲", keyName: "calendar.free_busy", decision: "需询问" },
      { scope: "读取邮件回执", keyName: "email.receipt", decision: "需询问" },
      { scope: "执行任务", keyName: "task.run", decision: "需询问" },
      { scope: "对外发送邮件", keyName: "gmail.send", decision: "不允许" },
    ],
  },
  {
    key: "brainstorm",
    name: "头脑风暴",
    desc: "多个智能体分别扮演发散提案与收敛评估角色，围绕问题给出可执行方案。",
    rounds: "默认 3 轮",
    roles: [
      { title: "创意提出者 Ideator", duty: "提出多条差异化实现方向与体验假设" },
      { title: "方案分析者 Analyst", duty: "评估工程成本、风险敞口与落地优先级" },
    ],
    rules: [
      { scope: "执行任务", keyName: "task.run", decision: "需询问" },
      { scope: "查看日程空闲", keyName: "calendar.free_busy", decision: "需询问" },
      { scope: "对外发送邮件", keyName: "gmail.send", decision: "不允许" },
    ],
  },
  {
    key: "debate",
    name: "技术辩论",
    desc: "正反方智能体就架构选型或迁移策略展开交锋，最终结论留给人类拍板。",
    rounds: "默认 3 轮",
    roles: [
      { title: "正方主辩 Proponent", duty: "论证目标方案的长期收益与复杂度收益" },
      { title: "反方审辩 Critic", duty: "揭示迁移成本、单点故障与回滚困难" },
    ],
    rules: [
      { scope: "执行任务", keyName: "task.run", decision: "需询问" },
      { scope: "读取邮件回执", keyName: "email.receipt", decision: "不允许" },
      { scope: "对外发送邮件", keyName: "gmail.send", decision: "不允许" },
    ],
  },
  {
    key: "dev_team",
    name: "开发团队",
    desc: "架构师、开发者与审查者在同一密室接力交付，按既定轮次收敛结果。",
    rounds: "默认 3 轮",
    roles: [
      { title: "架构师 Architect", duty: "拆解模块边界、数据流向与验收条件" },
      { title: "开发者 Engineer", duty: "实现功能补丁并补齐本地单元与端到端测试" },
      { title: "审查者 Reviewer", duty: "复核安全边界与回归测试结果" },
    ],
    rules: [
      { scope: "执行任务", keyName: "task.run", decision: "需询问" },
      { scope: "查看日程空闲", keyName: "calendar.free_busy", decision: "需询问" },
      { scope: "读取邮件回执", keyName: "email.receipt", decision: "需询问" },
      { scope: "对外发送邮件", keyName: "gmail.send", decision: "不允许" },
    ],
  },
] as const;

export function TemplateGrid() {
  const [selectedKey, setSelectedKey] = useState<(typeof LANDING_TEMPLATES)[number]["key"]>("code_review");
  const active = LANDING_TEMPLATES.find((tpl) => tpl.key === selectedKey) ?? LANDING_TEMPLATES[0];

  return (
    <section className="lp-section lp-section--mineral" id="lp-tpl">
      <div className="lp-wrap">
        <div className="lp-section__head">
          <h2>选好协作模板，规则即刻生效</h2>
          <p className="lp-section__sub">
            模板预置了角色分工与工具权限建议，建房前可直接预览和微调，入房后按房主本机规则执行。
          </p>
        </div>

        <div className="lp-blueprint">
          <div className="lp-tablist lp-tablist--templates" role="tablist" aria-label="预览协作模板">
            {LANDING_TEMPLATES.map((tpl) => {
              const selected = tpl.key === active.key;
              return (
                <button
                  key={tpl.key}
                  type="button"
                  role="tab"
                  id={`lp-tpl-tab-${tpl.key}`}
                  aria-selected={selected}
                  aria-controls={`lp-tpl-panel-${tpl.key}`}
                  className={selected ? "lp-tab lp-tab--active" : "lp-tab"}
                  onClick={() => setSelectedKey(tpl.key)}
                >
                  {tpl.name}
                </button>
              );
            })}
          </div>

          <div
            role="tabpanel"
            id={`lp-tpl-panel-${active.key}`}
            aria-labelledby={`lp-tpl-tab-${active.key}`}
            className="lp-blueprint__grid"
          >
            <div className="lp-blueprint__roles">
              <div className="lp-blueprint__title">
                <h3>{active.name}</h3>
                <span className="lp-blueprint__rounds">{active.rounds}</span>
              </div>
              <p>{active.desc}</p>
              <ul className="lp-role-list">
                {active.roles.map((role) => (
                  <li key={role.title}>
                    <strong>{role.title}</strong>
                    <span>{role.duty}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="lp-blueprint__rules">
              <table className="lp-table lp-table--compact">
                <thead>
                  <tr>
                    <th scope="col">动作范围</th>
                    <th scope="col">默认策略</th>
                  </tr>
                </thead>
                <tbody>
                  {active.rules.map((rule) => (
                    <tr key={rule.keyName}>
                      <td>
                        <span className="lp-scope-name">{rule.scope}</span>
                        <code className="lp-scope-code">{rule.keyName}</code>
                      </td>
                      <td>
                        <span
                          className={
                            rule.decision === "不允许"
                              ? "lp-policy lp-policy--deny"
                              : "lp-policy lp-policy--ask"
                          }
                        >
                          {rule.decision}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
