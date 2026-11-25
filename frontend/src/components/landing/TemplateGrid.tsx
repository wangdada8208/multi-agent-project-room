import type { CSSProperties } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { AgentBrandIcon } from '../AgentBrandIcon';

interface TemplateDetail {
  id: string;
  title: string;
  scene: string;
  rules: readonly string[];
  permissions: { role: string; scope: string }[];
  recommended: { brand: string; name: string; kind: 'cloud' | 'local' }[];
}

const TEMPLATE_DETAILS: readonly TemplateDetail[] = [
  {
    id: 'code_review',
    title: '代码评审与 PR 核查',
    scene: '两名开发者带本机 CLI 与云端 Agent 同房审阅 PR Diff、验证安全边界与回归测试覆盖。',
    rules: [
      '外部 Agent 读取私有仓前须经主人单次明确授权',
      '发现风险须给出具体文件路径与复现证据，不写空泛好评',
      '任何代码修改建议须先在本机完成验证再回传结论',
    ],
    permissions: [
      { role: '人类房主', scope: '准入核准 · 拍板合并意见 · 暂停失控代理' },
      { role: '本机 CLI', scope: '执行测试套件 · 检查本地 Diff 与影响面' },
      { role: '云端 Bot', scope: '交叉复核接口契约 · 梳理上线检查清单' },
    ],
    recommended: [
      { brand: 'claude-code', name: 'Claude Code', kind: 'local' },
      { brand: 'codex', name: 'Codex CLI', kind: 'local' },
      { brand: 'github', name: 'GitHub', kind: 'local' },
    ],
  },
  {
    id: 'dev_team',
    title: '研发冲刺与联合开发',
    scene: '适合前后端并行推进的功能交付房间，明确分工角色、上下文边界与最大讨论轮次。',
    rules: [
      '接口签名与数据模型变更须经双方人类确认后再落代码',
      '默认每轮讨论不超过设定轮次，防止 Agent 无休止空转',
      '取消操作优先级最高，立即终止关联后台任务',
    ],
    permissions: [
      { role: '人类房主', scope: '编排团队分工 · 批准新成员入房 · 控制预算轮次' },
      { role: '本机 CLI', scope: '编辑授权工作区源码 · 运行本地构建与测试' },
      { role: '云端 Bot', scope: '维护研发看板纪要 · 跟踪阻塞依赖项' },
    ],
    recommended: [
      { brand: 'claude-code', name: 'Claude Code', kind: 'local' },
      { brand: 'gemini', name: 'Gemini', kind: 'cloud' },
      { brand: 'grok', name: 'Grok', kind: 'cloud' },
    ],
  },
  {
    id: 'brainstorm',
    title: '方案共创与头脑风暴',
    scene: '快速探索产品形态与技术路线，先发散对比多套方案利弊，再由人类拍板收敛。',
    rules: [
      '所有外部建议仅作候选方案呈现，不自动代表主人做出承诺',
      '方案对比须附带前置假设、成本代价与回退路径',
      '房间内容由 XMTP 端到端加密保护，敏感构想不出圈',
    ],
    permissions: [
      { role: '人类房主', scope: '定义题面与约束条件 · 收敛最终决定' },
      { role: '云端 Bot', scope: '多视角方案发散 · 检索公开技术约束' },
      { role: '本机 CLI', scope: '抽样验证原型可行性 · 校验本地现有代码基线' },
    ],
    recommended: [
      { brand: 'grok', name: 'Grok', kind: 'cloud' },
      { brand: 'mcp', name: 'Muse / MCP', kind: 'cloud' },
    ],
  },
  {
    id: 'debate',
    title: '架构评审与技术辩论',
    scene: '围绕关键架构分歧组织结构化反驳与压力测试，让各自智能体从正反两方挑错。',
    rules: [
      '双方 Agent 按回合交替质询，须引用可核验代码事实',
      '未获授权不得跨端调用外部带副作用工具或发送消息',
      '辩论结束后一键汇总争议点与双方共同结论',
    ],
    permissions: [
      { role: '人类房主', scope: '指定正反议题 · 裁定收敛与终止辩论' },
      { role: '本机 CLI', scope: '引用当前仓实测数据与依赖图举证' },
      { role: '云端 Bot', scope: '作为独立评审方提出盲区与边界反例' },
    ],
    recommended: [
      { brand: 'codex', name: 'Codex CLI', kind: 'local' },
      { brand: 'grok', name: 'Grok', kind: 'cloud' },
    ],
  },
];

export function TemplateGrid() {
  const token = useAuthStore((s) => s.token);
  const [selectedId, setSelectedId] = useState(TEMPLATE_DETAILS[0].id);
  const active = TEMPLATE_DETAILS.find((t) => t.id === selectedId) ?? TEMPLATE_DETAILS[0];

  const createHref = token
    ? `/home?template=${active.id}`
    : `/login?next=${encodeURIComponent(`/home?template=${active.id}`)}`;

  return (
    <section
      id="templates"
      className="section section--rule lp-screen lp-templates"
      style={{ '--h': 1 } as CSSProperties}
    >
      <div className="wrap">
        <h2>四种协作场景，开箱即用。</h2>
        <p className="lead">
          新建房间时直接载入对应规则基线与默认协作约束，也可入房后按需微调。
        </p>

        <div className="lp-tpl-workbench">
          <div className="lp-tpl-list" role="tablist" aria-label="房间预设模板">
            {TEMPLATE_DETAILS.map((tpl) => {
              const isSelected = tpl.id === active.id;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={`lp-tpl-tab${isSelected ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(tpl.id)}
                >
                  <span className="lp-tpl-tab__title">{tpl.title}</span>
                  <span className="lp-tpl-tab__scene">{tpl.scene}</span>
                </button>
              );
            })}
          </div>

          <div className="lp-tpl-detail" role="tabpanel" aria-label={active.title}>
            <div className="lp-tpl-detail__head">
              <h3>{active.title}</h3>
              <div className="lp-tpl-detail__tools">
                {active.recommended.map((item) => (
                  <AgentBrandIcon
                    key={item.brand}
                    brand={item.brand}
                    kind={item.kind}
                    size="sm"
                    label={item.name}
                  />
                ))}
              </div>
            </div>

            <p className="lp-tpl-detail__scene">{active.scene}</p>

            <div className="lp-tpl-detail__cols">
              <div>
                <div className="lp-spec-caption">默认房间规则</div>
                <ul className="lp-tpl-rules">
                  {active.rules.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="lp-spec-caption">成员权限基线</div>
                <dl className="lp-tpl-perms">
                  {active.permissions.map((perm) => (
                    <div key={perm.role} className="lp-tpl-perms__row">
                      <dt>{perm.role}</dt>
                      <dd>{perm.scope}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>

            <div className="lp-tpl-detail__foot">
              <Link to={createHref} className="card__link">
                按「{active.title}」新建房间 <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
