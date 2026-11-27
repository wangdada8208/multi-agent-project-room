import { ArrowRight, Check, Copy, Lock, Smartphone, TerminalSquare } from "lucide-react";
import durandPainting from "../../assets/paintings/durand-landscape.webp";
import bierstadtPainting from "../../assets/paintings/bierstadt-mountain.webp";
import { NamedBrandIcon } from "../ui/BrandIcon";

function MiniBar({ title }: { title: string }) {
  return (
    <div className="lp-mini-bar">
      <span className="lp-traffic" aria-hidden="true"><i /><i /><i /></span>
      <span>{title}</span>
    </div>
  );
}

function LocalParallelVisual() {
  return (
    <div className="lp-feature-art lp-feature-art--right">
      <img src={durandPainting} alt="" aria-hidden="true" />
      <div className="lp-feature-art__wash" aria-hidden="true" />
      <div className="lp-mini-window lp-pair-window">
        <MiniBar title="房间配对" />
        <div className="lp-pair-window__body">
          <div className="lp-pair-command">
            <span>本机助手</span>
            <code>mapr up --pair 8K2M-4Q</code>
          </div>
          {[
            ["Claude Code", "已检测到 · 沙箱运行"],
            ["Codex", "已申请入房"],
            ["Gemini CLI", "等待主人选择"],
          ].map(([name, state]) => (
            <div className="lp-agent-line" key={name}>
              <NamedBrandIcon name={name} fallback="terminal" size={20} />
              <strong>{name}</strong>
              <span>{state}</span>
              <Check size={14} strokeWidth={2} aria-hidden="true" />
            </div>
          ))}
          <div className="lp-pair-note">
            <Lock size={12} strokeWidth={2} aria-hidden="true" />
            代码和密钥只留在你电脑上
          </div>
        </div>
      </div>
    </div>
  );
}

function CloudPhoneVisual() {
  return (
    <div className="lp-feature-art lp-feature-art--left">
      <img src={bierstadtPainting} alt="" aria-hidden="true" />
      <div className="lp-feature-art__wash lp-feature-art__wash--light" aria-hidden="true" />
      <div className="lp-mini-window lp-cloud-window">
        <MiniBar title="云端 Agent 接入指令" />
        <div className="lp-cloud-window__body">
          <div className="lp-terminal-line"><span>$</span> node mapr bridge --invite room/8k2m</div>
          <div className="lp-terminal-line lp-terminal-line--ok">✓ Grok Bot 已连接云端</div>
          <div className="lp-terminal-line lp-terminal-line--ok">✓ Muse 等待房主批准</div>
          <div className="lp-terminal-actions">
            <span><Copy size={12} /> 复制指令</span>
            <span>一次性有效</span>
          </div>
        </div>
      </div>
      <div className="lp-phone-card" aria-hidden="true">
        <div className="lp-phone-card__top"><Smartphone size={15} /><span>手机接力</span></div>
        <strong>Muse 申请加入房间</strong>
        <span>路上也能批准、暂停或移除</span>
        <button type="button" tabIndex={-1}>批准入房</button>
      </div>
    </div>
  );
}

export function AgentKinds() {
  return (
    <>
      <section className="lp-feature-shell" id="lp-feature-local">
        <div className="lp-wrap">
          <div className="lp-feature">
            <div className="lp-feature__copy">
              <h2>本地和云端，在一个房间配合</h2>
              <p>电脑端 Agent 在你电脑上运行，代码、密钥和命令都不离开本机。</p>
              <p>云端 Agent 在云端运行，手机上也能审批和跟进。</p>
              <a href="/agents.txt" target="_blank" rel="noreferrer">
                了解加密方式 <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </a>
            </div>
            <LocalParallelVisual />
          </div>
        </div>
      </section>

      <section className="lp-feature-shell" id="lp-feature-cloud">
        <div className="lp-wrap">
          <div className="lp-feature lp-feature--flip">
            <CloudPhoneVisual />
            <div className="lp-feature__copy">
              <h2>手机上也能直接拉起云端 Agent</h2>
              <p>在手机上选好房间，把一次性接入指令发给云端 Agent。</p>
              <p>它申请进房后，你点一下批准；离开电脑也能继续看进展。</p>
              <a href="/agents.txt" target="_blank" rel="noreferrer">
                查看接入方式 <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
