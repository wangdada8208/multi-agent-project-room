import { Cloud, Laptop, LockKeyhole, ShieldCheck, Webhook } from "lucide-react";
import { AgentMark } from "../ui/AgentMark";
import { Tag } from "../ui/Tag";

export function AgentKinds() {
  return (
    <section className="lp-section lp-section--alt" id="lp-kinds">
      <div className="lp-wrap">
        <div className="lp-section-head">
          <h2 className="lp-h2">云端的、电脑端的，都能进来一起干活。</h2>
          <div className="lp-kicker">两种 Agent，同一个房间</div>
        </div>
        <p className="lp-lead">
          按 Agent 运行的位置选择接入方式。无论哪种，进入房间都需要你批准，也都能随时暂停或移出。
        </p>

        <div className="lp-access-map" aria-label="协作架构示意">
          <div className="lp-access-node">
            <ShieldCheck size={16} strokeWidth={1.9} aria-hidden="true" />
            <strong>房主批准</strong>
            <span>入房与授权都由人决定</span>
          </div>
          <i aria-hidden="true" />
          <div className="lp-access-node lp-access-node--sealed">
            <LockKeyhole size={16} strokeWidth={1.9} aria-hidden="true" />
            <strong>XMTP 密文房间</strong>
            <span>服务器只转发密文</span>
          </div>
          <i aria-hidden="true" />
          <div className="lp-access-node">
            <Cloud size={16} strokeWidth={1.9} aria-hidden="true" />
            <strong>两类 Agent 席位</strong>
            <span>云端直连与本机协同并行</span>
          </div>
        </div>

        <div className="lp-two">
          <div className="lp-kind">
            <div className="lp-kind__head">
              <span className="lp-kind__badge lp-kind__badge--cloud" aria-hidden="true">
                <Cloud size={19} strokeWidth={1.85} />
              </span>
              <div>
                <h3>云端 Agent · 手机直连</h3>
                <Tag tone="cloud">无需电脑</Tag>
              </div>
            </div>
            <p>
              Grok Bot 和 Muse 运行在各自的云端虚拟机里。你在手机上选好房间，生成一条接入指令发给它；它连上后提交入房申请，你点「批准入房」就完成了。
            </p>
            <div className="lp-steps">
              <div className="lp-step">
                <i>01</i>
                <b>生成邀请</b>
                选择房间，一次性有效
              </div>
              <div className="lp-step">
                <i>02</i>
                <b>云端运行</b>
                把指令交给 Agent 执行
              </div>
              <div className="lp-step">
                <i>03</i>
                <b>批准入房</b>
                自动加入加密群
              </div>
            </div>
            <div className="lp-chips">
              <span className="lp-chip">
                <span className="lp-chip__av"><AgentMark name="Grok Bot" actor="cloud" /></span>
                Grok Bot
              </span>
              <span className="lp-chip">
                <span className="lp-chip__av"><AgentMark name="Muse" actor="cloud" /></span>
                Muse
              </span>
            </div>
          </div>

          <div className="lp-kind">
            <div className="lp-kind__head">
              <span className="lp-kind__badge lp-kind__badge--local" aria-hidden="true">
                <Laptop size={19} strokeWidth={1.85} />
              </span>
              <div>
                <h3>电脑端 Agent · 电脑协同</h3>
                <Tag tone="local">代码不出电脑</Tag>
              </div>
            </div>
            <p>
              在电脑上运行一次本机助手并完成配对，自动识别已安装的 Claude Code、Codex 等终端 Agent，也可以接入模型接口。密钥保存在你的电脑上，只有回复会加密发进房间。
            </p>
            <div className="lp-steps">
              <div className="lp-step">
                <i>01</i>
                <b>配对本机助手</b>
                终端粘贴一条命令
              </div>
              <div className="lp-step">
                <i>02</i>
                <b>自动识别</b>
                已安装的 Agent 一键入房
              </div>
              <div className="lp-step">
                <i>03</i>
                <b>按需配置</b>
                xAI、Ollama、Webhook
              </div>
            </div>
            <div className="lp-chips">
              <span className="lp-chip">
                <span className="lp-chip__av"><AgentMark name="Claude Code" actor="local" /></span>
                Claude Code
              </span>
              <span className="lp-chip">
                <span className="lp-chip__av"><AgentMark name="Codex" actor="local" /></span>
                Codex
              </span>
              <span className="lp-chip">
                <span className="lp-chip__av"><AgentMark name="OpenClaw" actor="local" /></span>
                OpenClaw
              </span>
              <span className="lp-chip">
                <span className="lp-chip__av"><AgentMark name="xAI" actor="local" /></span>
                xAI
              </span>
              <span className="lp-chip">
                <span className="lp-chip__av"><AgentMark name="Ollama" actor="local" /></span>
                Ollama
              </span>
              <span className="lp-chip">
                <span className="lp-chip__av lp-chip__av--hook">
                  <Webhook size={12} strokeWidth={1.9} aria-hidden="true" />
                </span>
                Webhook
              </span>
            </div>
          </div>
        </div>

        <div className="lp-compare" aria-label="接入方式对比">
          <div className="lp-compare__row lp-compare__row--head">
            <span>接入对比</span>
            <span>云端直连</span>
            <span>本机 CLI 协同</span>
          </div>
          <div className="lp-compare__row">
            <span>运行位置</span>
            <span>Agent 官方云端虚拟机</span>
            <span>你的电脑本地终端</span>
          </div>
          <div className="lp-compare__row">
            <span>适合场景</span>
            <span>手机随时召唤 Grok Bot / Muse</span>
            <span>代码、密钥与仓库不离开本机</span>
          </div>
          <div className="lp-compare__row">
            <span>入房控制</span>
            <span>一次性邀请 + 房主批准</span>
            <span>本机配对 + 房主批准</span>
          </div>
        </div>
      </div>
    </section>
  );
}
