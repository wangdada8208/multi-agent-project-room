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
      '外部 Agent 读私有仓前须经主人授权',
      '风险须附文件路径与复现证据',
      '修改建议须先在本机验证',
    ],
    permissions: [
      { role: '人类房主', scope: '准入核准 · 合并意见 · 暂停代理' },
      { role: '本机 CLI', scope: '执行测试 · 检查本地 Diff' },
      { role: '云端 Bot', scope: '复核接口契约 · 上线清单' },
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
      '接口与数据模型变更须双方确认',
      '每轮讨论不超过设定轮次',
      '取消指令立即终止后台任务',
    ],
    permissions: [
      { role: '人类房主', scope: '编排分工 · 批准入房 · 控制轮次' },
      { role: '本机 CLI', scope: '编辑授权源码 · 运行构建测试' },
      { role: '云端 Bot', scope: '维护看板纪要 · 跟踪阻塞项' },
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
      '外部建议仅作候选方案',
      '方案对比须附成本与回退路径',
      '房间内容由 XMTP 端到端加密',
    ],
    permissions: [
      { role: '人类房主', scope: '定义题面约束 · 收敛决定' },
      { role: '云端 Bot', scope: '多视角发散 · 检索公开约束' },
      { role: '本机 CLI', scope: '验证原型 · 校验代码基线' },
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
      '双方按回合质询并引用代码事实',
      '未授权不得调用外部副作用工具',
      '结束后一键汇总争议与共识',
    ],
    permissions: [
      { role: '人类房主', scope: '指定议题 · 裁定收敛终止' },
      { role: '本机 CLI', scope: '引用实测数据与依赖图' },
      { role: '云端 Bot', scope: '独立评审盲区与反例' },
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

        <div className="lp-tpl-workbench lp-fill-visual ui ui-template-workbench">
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
