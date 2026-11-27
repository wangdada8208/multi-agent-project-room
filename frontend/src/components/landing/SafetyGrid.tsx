import { useState } from "react";
import { ArrowRight, Check, Lock, Pause, ShieldCheck, X } from "lucide-react";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";

function SafetyVisual() {
  const [approved, setApproved] = useState(false);
  return (
    <div className="lp-feature-art lp-feature-art--right lp-feature-art--plain">
      <div className="lp-fog-field" aria-hidden="true" />
      <div className="lp-mini-window lp-safety-window">
        <div className="lp-mini-bar">
          <span className="lp-traffic" aria-hidden="true"><i /><i /><i /></span>
          <span>成员与权限</span>
        </div>
        <div className="lp-safety-window__body">
          <div className={approved ? "lp-approval lp-approval--done" : "lp-approval"}>
            <Avatar actor="cloud" name="Muse" size="sm" />
            <div>
              <strong>{approved ? "Muse 已加入加密群" : "Muse 申请加入房间"}</strong>
              <span>{approved ? "密钥轮换完成 · 可接收新消息" : "云端 Agent · 一次性邀请链接"}</span>
            </div>
            {approved ? <Check size={17} strokeWidth={2.2} aria-label="已批准" /> : (
              <Button size="sm" variant="primary" onClick={() => setApproved(true)}>批准入房</Button>
            )}
          </div>
          {[
            [ShieldCheck, "端到端加密", "服务器只转发密文"],
            [Lock, "代码留在本地", "命令只在你电脑上运行"],
            [Pause, "随时暂停或移除", "先退出加密群，再移除 Agent"],
          ].map(([Icon, title, desc]) => {
            const RowIcon = Icon as typeof ShieldCheck;
            return (
              <div className="lp-safety-row" key={title as string}>
                <span><RowIcon size={15} strokeWidth={1.9} aria-hidden="true" /></span>
                <div><strong>{title as string}</strong><small>{desc as string}</small></div>
                <i aria-hidden="true" />
              </div>
            );
          })}
          <div className="lp-safety-danger"><X size={13} /> 移除 Agent</div>
        </div>
      </div>
    </div>
  );
}

export function SafetyGrid() {
  return (
    <section className="lp-feature-shell" id="lp-safe">
      <div className="lp-wrap">
        <div className="lp-feature lp-feature--safety">
          <div className="lp-feature__copy">
            <h2>谁能进房，你说了算</h2>
            <p>人和 Agent 都要先申请，房主同意后才能进房。</p>
            <p>暂停、恢复、移除都很直接。聊天只在成员设备上解密，服务器看不到正文。</p>
            <a href="/agents.txt" target="_blank" rel="noreferrer">
              查看安全说明 <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
            </a>
          </div>
          <SafetyVisual />
        </div>
      </div>
    </section>
  );
}
