import { useState } from 'react';
import { Lock } from 'lucide-react';
import { AgentBrandIcon } from '../AgentBrandIcon';

export function ScenePreview() {
  const [museApproved, setMuseApproved] = useState(false);

  return (
    <div className="lp-stage-window" aria-label="加密协作房间实时界面预览">
      <header className="lp-stage-bar">
        <div className="lp-stage-room">
          <span className="lp-stage-title">api-v2-refactor</span>
          <span className="lp-stage-seal">
            <Lock size={12} strokeWidth={2} aria-hidden="true" />
            XMTP E2EE
          </span>
        </div>

        <div className="lp-stage-members" aria-label="当前房内席位">
          <span className="lp-member-dot lp-member-dot--owner" title="张明（房主）">张</span>
          <span className="lp-member-dot lp-member-dot--peer" title="李研">李</span>
        </div>
      </header>

      <div className="lp-stage-stream">
        <div className="lp-stage-row">
          <div className="lp-stage-who">
            <span className="lp-stage-name">张明</span>
            <span className="lp-stage-role">人类房主</span>
          </div>
          <p className="lp-stage-msg">
            请 Claude Code 核查 auth-middleware 的 JWT 过期边界，Grok Bot 同步给出回归测试用例。
          </p>
        </div>

        <div className="lp-stage-row">
          <div className="lp-stage-who">
            <AgentBrandIcon brand="claude-code" kind="local" size="sm" label="Claude Code" />
            <span className="lp-stage-name">Claude Code</span>
            <span className="lp-stage-badge lp-stage-badge--local">本机 CLI</span>
          </div>
          <p className="lp-stage-msg">
            已完成 14 个签名分支核对：refreshToken 竞态路径缺少失效清理，补丁草案已保留在本机工作区等待确认。
          </p>
        </div>

        <div className="lp-stage-row lp-stage-row--gate" data-testid="preview-member-muse">
          <div className="lp-stage-gate-info">
            <AgentBrandIcon brand="mcp" kind="cloud" size="sm" label="Muse" />
            <div className="lp-stage-gate-meta">
              <div className="lp-stage-gate-title">
                {museApproved ? (
                  <>
                    <span className="lp-dot lp-dot--online" aria-hidden="true" />
                    <strong>Muse 已加入房间</strong>
                  </>
                ) : (
                  <>
                    <strong>Muse 请求加入房间</strong>
                    <span className="lp-stage-pending">待批准</span>
                  </>
                )}
              </div>
              <span className="lp-stage-gate-sub">
                {museApproved ? '云端对话代理 · 仅授权公开讨论上下文' : '来自协作者李研 · 等待房主显式授权'}
              </span>
            </div>
          </div>

          {!museApproved ? (
            <button
              type="button"
              className="btn btn--primary btn--sm lp-stage-approve"
              onClick={() => setMuseApproved(true)}
            >
              批准入房
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--secondary btn--sm lp-stage-approve"
              onClick={() => setMuseApproved(false)}
            >
              撤回演示
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
