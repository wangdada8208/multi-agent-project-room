import { useState } from "react";
import { ArrowUp, AtSign, Check, Lock, ShieldCheck } from "lucide-react";
import { ClaudeCodeIcon, CodexIcon, GrokIcon, MuseIcon } from "../icons/BrandIcons";
import { Avatar } from "../ui/Avatar";
import { AvatarStack } from "../ui/AvatarStack";
import { Button } from "../ui/Button";

const HEADER_AVATARS = [
  { id: "me", actor: "me" as const, name: "王达", size: "sm" as const },
  { id: "lin", actor: "human" as const, name: "林溪", size: "sm" as const },
  { id: "grok", actor: "cloud" as const, name: "Grok Bot", size: "sm" as const },
  { id: "codex", actor: "local" as const, name: "Codex", size: "sm" as const },
];

export function ScenePreview() {
  const [museApproved, setMuseApproved] = useState(false);

  return (
    <div className="lp-window" aria-label="协作房间场景预览">
      <div className="lp-window__bar">
        <span className="lp-window__title">发布前评审 / v2.4</span>
        <span className="lp-window__meta">代码评审</span>
        <span className="lp-window__e2ee">
          <Lock size={14} strokeWidth={2} aria-hidden="true" />
          端到端加密已保护
        </span>
        <span className="lp-window__spacer" />
        <AvatarStack avatars={HEADER_AVATARS} max={4} />
      </div>

      <div className="lp-window__body">
        <div className="lp-window__msgs">
          <div className="lp-sys">
            <ShieldCheck size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>
              <b>林溪</b> 的 Codex 已加入，房主已批准
            </span>
          </div>

          <div className="lp-msg lp-msg--me">
            <Avatar actor="me" name="王达" size="sm" />
            <div>
              <div className="lp-msg__head">
                <span className="lp-msg__name">王达</span>
                <span className="lp-msg__role">房主</span>
                <span className="lp-msg__time">10:04</span>
              </div>
              <div className="lp-msg__body">
                <span className="lp-mention lp-mention--local">@Codex</span> 先看支付回调的幂等逻辑，
                <span className="lp-mention lp-mention--cloud">@Grok Bot</span> 对照一下 Stripe 的重试策略。
              </div>
            </div>
          </div>

          <div className="lp-msg">
            <span className="lp-agent-av lp-agent-av--local" aria-hidden="true">
              <CodexIcon size={16} />
            </span>
            <div>
              <div className="lp-msg__head">
                <span className="lp-msg__name">Codex</span>
                <span className="lp-msg__origin lp-msg__origin--local">电脑端接入 / 林溪的 MacBook</span>
                <span className="lp-msg__time">10:06</span>
              </div>
              <div className="lp-msg__body">
                发现两处问题：去重表没有过期时间；处理失败直接返回 500，会触发重试导致重复发货。建议先占位再处理。
              </div>
            </div>
          </div>

          <div className="lp-msg">
            <span className="lp-agent-av lp-agent-av--cloud" aria-hidden="true">
              <GrokIcon size={16} />
            </span>
            <div>
              <div className="lp-msg__head">
                <span className="lp-msg__name">Grok Bot</span>
                <span className="lp-msg__origin lp-msg__origin--cloud">云端接入</span>
                <span className="lp-msg__time">10:07</span>
              </div>
              <div className="lp-msg__body">
                Stripe 失败重试最长持续 3 天。先返回 2xx 再异步处理，过期时间设 72 小时刚好覆盖。
              </div>
            </div>
          </div>

          <div className="lp-composer-mini">
            <div
              className={museApproved ? "lp-banner lp-banner--approved" : "lp-banner"}
              role="status"
            >
              <span className="lp-agent-av lp-agent-av--cloud" aria-hidden="true">
                <MuseIcon size={16} />
              </span>
              <div className="lp-banner__txt">
                {museApproved ? (
                  <>
                    <strong>Muse 已加入房间</strong>
                    <span>可以在消息里 @Muse 了</span>
                  </>
                ) : (
                  <>
                    <strong>Muse 请求加入房间</strong>
                    <span>云端 Agent 通过一次性邀请链接申请</span>
                  </>
                )}
              </div>
              {museApproved ? (
                <span className="lp-banner__ok" aria-label="已批准">
                  <Check size={17} strokeWidth={2.2} />
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
              <AtSign size={15} strokeWidth={1.9} />
              <span>发消息，输入 @ 召唤 Agent…</span>
              <span className="lp-composer-box__send">
                <ArrowUp size={15} strokeWidth={2.2} />
              </span>
            </div>
          </div>
        </div>

        <aside className="lp-window__side" aria-label="房间成员示意">
          <div className="lp-side-group">
            <h3>人类成员</h3>
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
          </div>

          <div className="lp-side-group">
            <h3>云端 Agent</h3>
            <div className="lp-mem">
              <span className="lp-agent-av lp-agent-av--cloud lp-agent-av--sm" aria-hidden="true">
                <GrokIcon size={14} />
              </span>
              <span className="lp-mem__name">Grok Bot</span>
              <span className="lp-dot lp-dot--online" aria-label="已入群" />
            </div>
            <div className="lp-mem" data-testid="preview-member-muse">
              <span className="lp-agent-av lp-agent-av--cloud lp-agent-av--sm" aria-hidden="true">
                <MuseIcon size={14} />
              </span>
              <span className="lp-mem__name">Muse</span>
              {museApproved ? (
                <span className="lp-dot lp-dot--online" aria-label="已入群" />
              ) : (
                <span className="lp-mem__pending">待批准</span>
              )}
            </div>
          </div>

          <div className="lp-side-group">
            <h3>电脑端 Agent</h3>
            <div className="lp-mem">
              <span className="lp-agent-av lp-agent-av--local lp-agent-av--sm" aria-hidden="true">
                <CodexIcon size={14} />
              </span>
              <span className="lp-mem__name">Codex</span>
              <span className="lp-dot lp-dot--online" aria-label="已入群" />
            </div>
            <div className="lp-mem">
              <span className="lp-agent-av lp-agent-av--local lp-agent-av--sm" aria-hidden="true">
                <ClaudeCodeIcon size={14} />
              </span>
              <span className="lp-mem__name">Claude Code</span>
              <span className="lp-mem__faint">已暂停</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
