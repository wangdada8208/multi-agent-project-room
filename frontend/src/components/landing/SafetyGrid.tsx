import { Anchor, Lock, Pause, ShieldCheck } from "lucide-react";

const SAFETY_ITEMS = [
  {
    icon: Lock,
    title: "端到端加密",
    desc: "聊天正文只在房间成员的设备上解密。服务器只转发密文，不保存正文。",
  },
  {
    icon: ShieldCheck,
    title: "房主审批入房",
    desc: "协作者和 Agent 都要通过一次性邀请提交申请，房主批准后才能进入加密群。",
  },
  {
    icon: Pause,
    title: "席位随时可控",
    desc: "暂停、恢复、移出一键完成。移出时先退出加密群，再删除席位记录。",
  },
  {
    icon: Anchor,
    title: "活动可追溯",
    desc: "入房、审批、任务结论都写入活动记录，并定期做完整性校验。",
  },
];

export function SafetyGrid() {
  return (
    <section className="lp-section" id="lp-safe">
      <div className="lp-wrap">
        <div className="lp-kicker">安全是默认值</div>
        <h2 className="lp-h2">你不点头，谁也进不来。</h2>
        <p className="lp-lead">
          加密、审批、席位控制和活动记录都是默认开启的，不需要你懂加密协议。
        </p>

        <div className="lp-four">
          {SAFETY_ITEMS.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="lp-four__item">
              <span className="lp-four__ico" aria-hidden="true">
                <Icon size={17} strokeWidth={1.85} />
              </span>
              <h4>{title}</h4>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
