import { useState } from "react";
import { ArrowUp, AtSign, Check, Lock, ShieldCheck } from "lucide-react";
import heroPainting from "../../assets/paintings/hero-mist-valley.webp";
import type { ActorKind } from "../../lib/domain/displayMessages";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Tag";

type ScenarioKey = "solo" | "team";

interface RoomRow {
  name: string;
  meta: string;
  active: boolean;
}

interface MemberRow {
  actor: ActorKind;
  name: string;
  state: string;
  online: boolean;
}

interface ScenarioContent {
  label: string;
  caption: string;
  roomTitle: string;
  roomMeta: string;
  systemLine: string;
  rooms: RoomRow[];
  members: MemberRow[];
  cliLines: string[];
  memberNote: string;
}

const SCENARIO_KEYS = ["solo", "team"] as const;

const SCENARIOS: Record<ScenarioKey, ScenarioContent> = {
  solo: {
    label: "单人工作台",
    caption: "一个人 1 分钟开干",
    roomTitle: "个人发布冲刺",
    roomMeta: "1 位主人 · 3 个 Agent · XMTP 群已绑定",
    systemLine: "你的 3 个 Agent 已就位 · 密钥留在本机",
    rooms: [
      { name: "个人发布冲刺", meta: "Claude Code · Codex", active: true },
      { name: "周报与材料整理", meta: "Gemini CLI", active: false },
      { name: "私有脚本维护", meta: "Grok Bot", active: false },
      { name: "下一个小项目", meta: "随时开始", active: false },
    ],
    members: [
      { actor: "me", name: "王达", state: "房主", online: true },
      { actor: "local", name: "Claude Code", state: "本机沙箱", online: true },
      { actor: "local", name: "Codex", state: "本机沙箱", online: true },
      { actor: "local", name: "Gemini CLI", state: "本机沙箱", online: true },
      { actor: "cloud", name: "Grok Bot", state: "云端在线", online: true },
    ],
    cliLines: [
      "$ mapr agents pair --room release-sprint",
      "✓ Claude Code 已在本机沙箱中就绪",
      "✓ Codex 已加入你的加密房间",
      "› 1 位主人 · 3 个 Agent 正在分工",
    ],
    memberNote: "一个人的多个 Agent 也在同一个加密房间里分工。",
  },
  team: {
    label: "团队项目房",
    caption: "发链接随时拉人",
    roomTitle: "支付回调评审",
    roomMeta: "4 位成员 · XMTP 群已绑定",
    systemLine: "林溪 的 Codex 已加入 · 房主已批准",
    rooms: [
      { name: "支付回调评审", meta: "Claude Code · Codex", active: true },
      { name: "移动端发布检查", meta: "Grok Bot · 2 人", active: false },
      { name: "官网文案打磨", meta: "Muse · 林溪", active: false },
      { name: "数据迁移演练", meta: "Gemini · 3 人", active: false },
    ],
    members: [
      { actor: "me", name: "王达", state: "房主", online: true },
      { actor: "human", name: "林溪", state: "在线", online: true },
      { actor: "local", name: "Claude Code", state: "已入群", online: true },
      { actor: "local", name: "Codex", state: "已入群", online: true },
      { actor: "cloud", name: "Grok Bot", state: "云端在线", online: true },
    ],
    cliLines: [
      "$ mapr agents pair --room payment-review",
      "✓ Claude Code 已在本机沙箱中就绪",
      "✓ Codex 已申请加入加密群",
      "› 等待房主批准 Muse 入房…",
    ],
    memberNote: "私密代码留在本机，密文不进 Hub 日志。",
  },
};

function TrafficLights() {
  return (
    <span className="lp-traffic" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function SoloMessages() {
  return (
    <>
      <div className="lp-sys">
        <ShieldCheck size={12} strokeWidth={2} aria-hidden="true" />
        <span>{SCENARIOS.solo.systemLine}</span>
      </div>

      <div className="lp-msg lp-msg--me">
        <Avatar actor="me" name="王达" size="sm" />
        <div>
          <div className="lp-msg__head"><span className="lp-msg__name">王达</span><Tag tone="owner">房主</Tag><span className="lp-msg__time">21:04</span></div>
          <div className="lp-msg__body"><span className="lp-mention">@Claude Code</span> 修登录回归，<span className="lp-mention">@Codex</span> 复查 diff，<span className="lp-mention">@Gemini CLI</span> 整理发布清单。</div>
        </div>
      </div>

      <div className="lp-msg">
        <Avatar actor="local" name="Claude Code" size="sm" />
        <div>
          <div className="lp-msg__head"><span className="lp-msg__name">Claude Code</span><Tag>电脑端 · 本机沙箱</Tag><span className="lp-msg__time">21:06</span></div>
          <div className="lp-msg__body">已在沙箱跑完回归。问题出在验证码输入框没有清空旧状态，我会先补测试再改。</div>
        </div>
      </div>

      <div className="lp-msg">
        <Avatar actor="local" name="Codex" size="sm" />
        <div>
          <div className="lp-msg__head"><span className="lp-msg__name">Codex</span><Tag>电脑端 · 本机沙箱</Tag><span className="lp-msg__time">21:07</span></div>
          <div className="lp-msg__body">diff 里还有一处重复分支。你先补回归，我同步检查是否影响移动端。</div>
        </div>
      </div>
    </>
  );
}

function TeamMessages() {
  return (
    <>
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
    </>
  );
}

export function ScenePreview() {
  const [scenario, setScenario] = useState<ScenarioKey>("solo");
  const [museApproved, setMuseApproved] = useState(false);
  const content = SCENARIOS[scenario];

  return (
    <div className="lp-scenario-preview" id="lp-scenarios">
      <div className="lp-scenario-switch" role="tablist" aria-label="Parlor 使用场景">
        {SCENARIO_KEYS.map((key) => (
          <button
            type="button"
            role="tab"
            aria-selected={scenario === key}
            className={scenario === key ? "lp-scenario-tab lp-scenario-tab--active" : "lp-scenario-tab"}
            key={key}
            onClick={() => setScenario(key)}
          >
            <strong>{SCENARIOS[key].label}</strong>
            <span>{SCENARIOS[key].caption}</span>
          </button>
        ))}
      </div>

      <div className="lp-hero-stage" aria-label={`Parlor ${content.label}界面预览`}>
        <img className="lp-hero-stage__painting" src={heroPainting} alt="" aria-hidden="true" />
        <div className="lp-hero-stage__mist" aria-hidden="true" />

        <div className="lp-desktop-window lp-product-window">
          <div className="lp-macbar">
            <TrafficLights />
            <span className="lp-macbar__title">Parlor Desktop · {content.label}</span>
          </div>
          <div className="lp-product-window__body">
            <aside className="lp-product-rooms" aria-label="房间列表示意">
              <h6>房间</h6>
              {content.rooms.map((room) => (
                <div key={room.name} className={room.active ? "lp-room-row lp-room-row--active" : "lp-room-row"}>
                  <strong>{room.name}</strong>
                  <span>{room.meta}</span>
                </div>
              ))}
              <div className="lp-room-row lp-room-row--new">+ 新建房间</div>
            </aside>

            <section className="lp-product-chat" aria-label="加密协作消息流示意">
              <div className="lp-product-chat__head">
                <div>
                  <strong>{content.roomTitle}</strong>
                  <span>{content.roomMeta}</span>
                </div>
                <span className="lp-e2ee-pill">
                  <Lock size={11} strokeWidth={2.1} aria-hidden="true" />
                  端到端加密
                </span>
              </div>

              <div className="lp-product-msgs">
                {scenario === "solo" ? <SoloMessages /> : <TeamMessages />}
              </div>

              <div className="lp-composer-mini">
                {scenario === "solo" ? (
                  <div className="lp-banner" role="status">
                    <Avatar actor="human" name="团队" size="sm" />
                    <div className="lp-banner__txt">
                      <strong>随时变成团队房</strong>
                      <small>发一条邀请链接，同事和他们的 Agent 就能加入</small>
                    </div>
                    <Tag>邀请链接</Tag>
                  </div>
                ) : (
                  <div className={museApproved ? "lp-banner lp-banner--approved" : "lp-banner"} role="status">
                    <Avatar actor="cloud" name="Muse" size="sm" />
                    <div className="lp-banner__txt">
                      {museApproved ? (
                        <><strong>Muse 已加入房间</strong><small>可以在消息里 @Muse 了</small></>
                      ) : (
                        <><strong>Muse</strong> 申请加入房间<small>云端 Agent · 邀请链接</small></>
                      )}
                    </div>
                    {museApproved ? (
                      <span className="lp-banner__ok" aria-label="已批准"><Check size={15} strokeWidth={2.2} /></span>
                    ) : (
                      <Button variant="primary" size="sm" onClick={() => setMuseApproved(true)}>批准入房</Button>
                    )}
                  </div>
                )}
                <div className="lp-composer-box" aria-hidden="true">
                  <AtSign size={13} strokeWidth={1.9} />
                  <span>发消息，输入 @ 召唤 Agent…</span>
                  <span className="lp-composer-box__send"><ArrowUp size={13} strokeWidth={2.2} /></span>
                </div>
              </div>
            </section>

            <aside className="lp-product-members" aria-label="成员状态示意">
              <h6>成员状态</h6>
              {content.members.map((member) => (
                <div className="lp-mem" key={member.name}>
                  <Avatar actor={member.actor} name={member.name} size="sm" />
                  <span className="lp-mem__name">{member.name}</span>
                  <span className={member.online ? "lp-dot lp-dot--online" : "lp-dot"} aria-label={member.state} />
                </div>
              ))}
              {scenario === "team" && (
                <div className="lp-mem" data-testid="preview-member-muse">
                  <Avatar actor="cloud" name="Muse" size="sm" />
                  <span className="lp-mem__name">Muse</span>
                  {museApproved ? <span className="lp-dot lp-dot--online" aria-label="已入群" /> : <Tag tone="warn">待审批</Tag>}
                </div>
              )}
              <div className="lp-member-note">
                <Lock size={12} strokeWidth={1.9} aria-hidden="true" />
                {content.memberNote}
              </div>
            </aside>
          </div>
        </div>

        <div className="lp-desktop-window lp-cli-window" aria-label="Parlor CLI 终端示意">
          <div className="lp-macbar lp-macbar--terminal">
            <TrafficLights />
            <span className="lp-macbar__title">Parlor CLI</span>
          </div>
          <div className="lp-cli-body">
            {content.cliLines.map((line, index) => (
              <p key={line} className={index > 0 ? "lp-cli-muted" : undefined}><span>{index === 0 ? "$" : "›"}</span> {line.replace(/^[$›]\s*/u, "")}</p>
            ))}
            <div className="lp-cli-input"><span>输入指令，按 Enter 继续</span><i /></div>
          </div>
        </div>
      </div>
    </div>
  );
}
