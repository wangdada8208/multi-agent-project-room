import { useState } from "react";
import { ArrowUp, AtSign, Check, Lock, ShieldCheck } from "lucide-react";
import heroPainting from "../../assets/paintings/hero-mist-valley.webp";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Tag";

const ROOM_ROWS = [
  { name: "支付回调评审", meta: "Claude Code · Codex", active: true },
  { name: "移动端发布检查", meta: "Grok Bot · 2 人", active: false },
  { name: "官网文案打磨", meta: "Muse · 林溪", active: false },
  { name: "数据迁移演练", meta: "Gemini · 3 人", active: false },
];

const MEMBER_ROWS = [
  { actor: "me" as const, name: "王达", state: "房主", online: true },
  { actor: "human" as const, name: "林溪", state: "在线", online: true },
  { actor: "local" as const, name: "Claude Code", state: "已入群", online: true },
  { actor: "local" as const, name: "Codex", state: "已入群", online: true },
  { actor: "cloud" as const, name: "Grok Bot", state: "云端在线", online: true },
];

function TrafficLights() {
  return (
    <span className="lp-traffic" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function ScenePreview() {
  const [museApproved, setMuseApproved] = useState(false);

  return (
    <div className="lp-hero-stage" aria-label="Project Room 产品界面预览">
      <img className="lp-hero-stage__painting" src={heroPainting} alt="" aria-hidden="true" />
      <div className="lp-hero-stage__mist" aria-hidden="true" />

      <div className="lp-desktop-window lp-product-window">
        <div className="lp-macbar">
          <TrafficLights />
          <span className="lp-macbar__title">Project Room Desktop</span>
        </div>
        <div className="lp-product-window__body">
          <aside className="lp-product-rooms" aria-label="房间列表示意">
            <h6>协作房间</h6>
            {ROOM_ROWS.map((room) => (
              <div key={room.name} className={room.active ? "lp-room-row lp-room-row--active" : "lp-room-row"}>
                <strong>{room.name}</strong>
                <span>{room.meta}</span>
              </div>
            ))}
            <div className="lp-room-row lp-room-row--new">+ 新建协作室</div>
          </aside>

          <section className="lp-product-chat" aria-label="加密协作消息流示意">
            <div className="lp-product-chat__head">
              <div>
                <strong>支付回调评审</strong>
                <span>4 位成员 · XMTP 群已绑定</span>
              </div>
              <span className="lp-e2ee-pill">
                <Lock size={11} strokeWidth={2.1} aria-hidden="true" />
                端到端加密
              </span>
            </div>

            <div className="lp-product-msgs">
              <div className="lp-sys">
                <ShieldCheck size={12} strokeWidth={2} aria-hidden="true" />
                <span><b>林溪</b> 的 Codex 已加入 · 房主已批准</span>
              </div>

              <div className="lp-msg lp-msg--me">
                <Avatar actor="me" name="王达" size="sm" />
                <div>
                  <div className="lp-msg__head"><span className="lp-msg__name">王达</span><Tag tone="owner">房主</Tag><span className="lp-msg__time">10:04</span></div>
                  <div className="lp-msg__body"><span className="lp-mention">@Codex</span> 先看支付回调的幂等逻辑，<span className="lp-mention">@Grok Bot</span> 对照 Stripe 的重试策略。</div>
                </div>
              </div>

              <div className="lp-msg">
                <Avatar actor="local" name="Codex" size="sm" />
                <div>
                  <div className="lp-msg__head"><span className="lp-msg__name">Codex</span><Tag>电脑端 · 林溪的 MacBook</Tag><span className="lp-msg__time">10:06</span></div>
                  <div className="lp-msg__body">发现两处问题：去重表没有过期时间；失败直接返回 500，会触发重试导致重复发货。建议先占位再处理。</div>
                </div>
              </div>

              <div className="lp-msg">
                <Avatar actor="cloud" name="Grok Bot" size="sm" />
                <div>
                  <div className="lp-msg__head"><span className="lp-msg__name">Grok Bot</span><Tag>云端 Agent</Tag><span className="lp-msg__time">10:07</span></div>
                  <div className="lp-msg__body">Stripe 失败重试最长持续 3 天。先返回 2xx 再异步处理，过期时间设 72 小时刚好覆盖。</div>
                </div>
              </div>
            </div>

            <div className="lp-composer-mini">
              <div className={museApproved ? "lp-banner lp-banner--approved" : "lp-banner"} role="status">
                <Avatar actor="cloud" name="Muse" size="sm" />
                <div className="lp-banner__txt">
                  {museApproved ? (
                    <><strong>Muse 已加入房间</strong><small>可以在消息里 @Muse 了</small></>
                  ) : (
                    <><strong>Muse</strong> 请求加入房间<small>云端 Agent · 邀请链接</small></>
                  )}
                </div>
                {museApproved ? (
                  <span className="lp-banner__ok" aria-label="已批准"><Check size={15} strokeWidth={2.2} /></span>
                ) : (
                  <Button variant="primary" size="sm" onClick={() => setMuseApproved(true)}>批准入房</Button>
                )}
              </div>
              <div className="lp-composer-box" aria-hidden="true">
                <AtSign size={13} strokeWidth={1.9} />
                <span>发消息，输入 @ 召唤 Agent…</span>
                <span className="lp-composer-box__send"><ArrowUp size={13} strokeWidth={2.2} /></span>
              </div>
            </div>
          </section>

          <aside className="lp-product-members" aria-label="成员状态示意">
            <h6>成员状态</h6>
            {MEMBER_ROWS.map((member) => (
              <div className="lp-mem" key={member.name}>
                <Avatar actor={member.actor} name={member.name} size="sm" />
                <span className="lp-mem__name">{member.name}</span>
                <span className={member.online ? "lp-dot lp-dot--online" : "lp-dot"} aria-label={member.state} />
              </div>
            ))}
            <div className="lp-mem" data-testid="preview-member-muse">
              <Avatar actor="cloud" name="Muse" size="sm" />
              <span className="lp-mem__name">Muse</span>
              {museApproved ? <span className="lp-dot lp-dot--online" aria-label="已入群" /> : <Tag tone="warn">待批准</Tag>}
            </div>
            <div className="lp-member-note">
              <Lock size={12} strokeWidth={1.9} aria-hidden="true" />
              私密代码留在本机，密文不进 Hub 日志。
            </div>
          </aside>
        </div>
      </div>

      <div className="lp-desktop-window lp-cli-window" aria-label="MAPR CLI 终端示意">
        <div className="lp-macbar lp-macbar--terminal">
          <TrafficLights />
          <span className="lp-macbar__title">MAPR CLI</span>
        </div>
        <div className="lp-cli-body">
          <p><span>$</span> mapr agents pair --room payment-review</p>
          <p className="lp-cli-muted">✓ Claude Code 已在本机沙箱中就绪</p>
          <p className="lp-cli-muted">✓ Codex 已申请加入加密群</p>
          <p><span>›</span> 等待房主批准 Muse 入房…</p>
          <div className="lp-cli-input"><span>输入 follow-up 或按 Enter 继续</span><i /></div>
        </div>
      </div>
    </div>
  );
}
