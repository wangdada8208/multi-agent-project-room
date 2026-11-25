import securityVaultUrl from "../../assets/visuals/security-vault.png";

const SAFETY_ITEMS = [
  {
    title: "端到端加密保护",
    desc: "聊天正文只在房间成员和已批准席位的设备上解密。服务器只转发密文，不保存明文对话。",
  },
  {
    title: "入房必经房主批准",
    desc: "协作者和外部 Agent 都要通过一次性邀请提交申请，房主点头批准后才能进入加密群。",
  },
  {
    title: "席位随时暂停或移出",
    desc: "暂停、恢复与移出一键生效。移出席位时先将其退出加密群，再清理席位记录。",
  },
  {
    title: "活动记录可追溯",
    desc: "入房审批、席位变动与任务结论按序写入活动账本，并定期执行完整性校验。",
  },
];

export function SafetyGrid() {
  return (
    <section className="lp-section lp-section--surface" id="lp-safe">
      <div className="lp-wrap lp-safety">
        <div className="lp-safety__media">
          <img
            src={securityVaultUrl}
            alt="精密深海钢制锁控机构与磨砂光学玻璃隔断，体现代码与密钥的物理边界"
            className="lp-safety__img"
          />
        </div>

        <div className="lp-safety__body">
          <h2>你不点头，谁也进不来</h2>
          <p className="lp-section__sub">
            端到端加密、入房审批、席位控制和活动校验都是默认开启的，不必理解加密协议也能安全协作。
          </p>

          <dl className="lp-safety__list">
            {SAFETY_ITEMS.map((item) => (
              <div key={item.title} className="lp-safety__row">
                <dt>{item.title}</dt>
                <dd>{item.desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
