import { useState } from "react";
import { ArrowUp, AtSign, Check, Lock, ShieldCheck } from "lucide-react";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Tag";


export function ScenePreview() {
  const [museApproved, setMuseApproved] = useState(false);

  return (
    <div className="lp-window" aria-label="协作房间场景预览">
      <div className="lp-window__bar">
        <span className="lp-window__title">发布前评审 · v2.4</span>
        <Tag tone="neutral">代码评审</Tag>
        <span className="lp-e2ee-pill">
          <Lock size={12} strokeWidth={2.1} aria-hidden="true" />
          端到端加密已保护
        </span>
        <span className="lp-window__spacer" />
        <span className="lp-window__count">4 个席位</span>
      </div>

      <div className="lp-window__body">
        <div className="lp-window__msgs">
          <div className="lp-sys">
            <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
            <span>
              <b>林溪</b> 的 Codex 已加入 · 房主已批准
            </span>
          </div>

          <div className="lp-msg lp-msg--me">
            <Avatar actor="me" name="王达" size="sm" />
            <div>
              <div className="lp-msg__head">
                <span className="lp-msg__name">王达</span>
                <Tag tone="owner">房主</Tag>
                <span className="lp-msg__time">10:04</span>
              </div>
              <div className="lp-msg__body">
                <span className="lp-mention lp-mention--local">@Codex</span> 先看支付回调的幂等逻辑，
                <span className="lp-mention lp-mention--cloud">@Grok Bot</span> 对照一下 Stripe 的重试策略。
              </div>
            </div>
          </div>

          <div className="lp-msg">
            <Avatar actor="local" name="Codex" size="sm" />
            <div>
              <div className="lp-msg__head">
                <span className="lp-msg__name">Codex</span>
                <Tag tone="local">电脑端 · 林溪的 MacBook</Tag>
                <span className="lp-msg__time">10:06</span>
              </div>
              <div className="lp-msg__body">
                发现两处问题：去重表没有过期时间；处理失败直接返回 500，会触发重试导致重复发货。建议先占位再处理。
              </div>
            </div>
          </div>

          <div className="lp-msg">
            <Avatar actor="cloud" name="Grok Bot" size="sm" />
            <div>
              <div className="lp-msg__head">
                <span className="lp-msg__name">Grok Bot</span>
                <Tag tone="cloud">云端 Agent</Tag>
                <span className="lp-msg__time">10:07</span>
              </div>
              <div className="lp-msg__body">
                Stripe 失败重试最长持续 3 天。先返回 2xx 再异步处理，过期时间设 72 小时刚好覆盖。
              </div>
            </div>
          </div>

          <div className="lp-msg">
            <Avatar actor="human" name="林溪" size="sm" />
            <div>
              <div className="lp-msg__head">
                <span className="lp-msg__name">林溪</span>
                <span className="lp-msg__time">10:08</span>
              </div>
              <div className="lp-msg__body">
                那就按先占位、后处理来改。Muse 进来后请补一遍上线检查清单。
              </div>
            </div>
          </div>

          <div className="lp-composer-mini">
            <div
              className={museApproved ? "lp-banner lp-banner--approved" : "lp-banner"}
              role="status"
            >
              <Avatar actor="cloud" name="Muse" size="sm" />
              <div className="lp-banner__txt">
                {museApproved ? (
                  <>
                    <strong>Muse 已加入房间</strong>
                    <small>可以在消息里 @Muse 了</small>
                  </>
                ) : (
                  <>
                    <strong>Muse</strong> 请求加入房间
                    <small>云端 Agent · 邀请链接</small>
                  </>
                )}
              </div>
              {museApproved ? (
                <span className="lp-banner__ok" aria-label="已批准">
                  <Check size={16} strokeWidth={2.2} />
                </span>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setMuseApproved(true)}
                >
                  批准入房
                </Button>
              )}
            </div>

            <div className="lp-composer-box" aria-hidden="true">
              <AtSign size={14} strokeWidth={1.9} />
              <span>发消息，输入 @ 召唤 Agent…</span>
              <span className="lp-composer-box__send">
                <ArrowUp size={14} strokeWidth={2.2} />
              </span>
            </div>
          </div>
        </div>

        <aside className="lp-window__side" aria-label="房间成员示意">
          <div className="lp-side-label">人类成员</div>
          <div className="lp-mem">
            <Avatar actor="me" name="王达" size="sm" />
            <span className="lp-mem__name">王达</span>
            <span className="lp-mem__faint">房主</span>
          </div>
          <div className="lp-mem">
            <Avatar actor="human" name="林溪" size="sm" />
            <span className="lp-mem__name">林溪</span>
            <span className="lp-dot lp-dot--online" aria-label="在线" />
          </div>

          <div className="lp-side-label">云端 Agent</div>
          <div className="lp-mem">
            <Avatar actor="cloud" name="Grok Bot" size="sm" />
            <span className="lp-mem__name">Grok Bot</span>
            <span className="lp-dot lp-dot--online" aria-label="已入群" />
          </div>
          <div className="lp-mem" data-testid="preview-member-muse">
            <Avatar actor="cloud" name="Muse" size="sm" />
            <span className="lp-mem__name">Muse</span>
            {museApproved ? (
              <span className="lp-dot lp-dot--online" aria-label="已入群" />
            ) : (
              <Tag tone="warn">待批准</Tag>
            )}
          </div>

          <div className="lp-side-label">电脑端 Agent</div>
          <div className="lp-mem">
            <Avatar actor="local" name="Codex" size="sm" />
            <span className="lp-mem__name">Codex</span>
            <span className="lp-dot lp-dot--online" aria-label="已入群" />
          </div>
          <div className="lp-mem">
            <Avatar actor="local" name="Claude Code" size="sm" />
            <span className="lp-mem__name">Claude Code</span>
            <span className="lp-mem__faint">已暂停</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
