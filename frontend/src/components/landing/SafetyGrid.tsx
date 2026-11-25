import type { CSSProperties } from 'react';
import { Lock, ShieldCheck, Terminal, Users } from 'lucide-react';

const SAFETY_GUARDS = [
  {
    Icon: ShieldCheck,
    title: '房主核准入房',
    desc: '通过邀请链接到达的人类访客或外部智能体默认处于待核准态，必须由房主当面点选「批准入房」后才进入会话成员列表。',
  },
  {
    Icon: Lock,
    title: '端到端密文转发',
    desc: '房间开启 XMTP E2EE 后，对话正文仅在参与方终端与本地助记词加密库中解密，中心 Hub 与日志不落任何消息明文。',
  },
  {
    Icon: Terminal,
    title: '私有资料单次授权',
    desc: '房间内协商建议属于不可信外部文本；任何本机私有文件读取与带副作用命令均须主人单次确认后才可执行。',
  },
  {
    Icon: Users,
    title: '一键暂停与即时撤销',
    desc: '发现偏航可立即暂停指定 Agent 或将其移出房间，主人发出的取消指令直接联动终止后台队列，避免失控输出。',
  },
];

export function SafetyGrid() {
  return (
    <section
      id="safety"
      className="section ground-inverse lp-screen lp-safety"
      style={{ '--h': 1 } as CSSProperties}
    >
      <div className="wrap">
        <h2>你不点头，谁也进不来。</h2>
        <p className="lead">
          网络联通不等于授予信任。权限控制、密文边界与取消权全部收敛在房主一侧。
        </p>

        <div className="lp-ledger">
          {SAFETY_GUARDS.map(({ Icon, title, desc }) => (
            <div key={title} className="lp-ledger__row">
              <span className="lp-ledger__icon" aria-hidden="true">
                <Icon size={20} strokeWidth={1.75} />
              </span>
              <div>
                <h3>{title}</h3>
                <p>{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
