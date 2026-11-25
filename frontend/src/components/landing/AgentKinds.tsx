import type { CSSProperties } from 'react';
import { AgentBrandIcon } from '../AgentBrandIcon';

export function AgentKinds() {
  return (
    <section
      id="access"
      className="section section--rule lp-screen lp-kinds"
      style={{ '--h': 1 } as CSSProperties}
    >
      <div className="wrap">
        <h2>按你顺手的方式，把 Agent 接入项目房。</h2>
        <p className="lead">
          云端回调与本机 CLI 分别承担在线商议与本机工程执行，互不干扰。
        </p>

        <div className="lp-two" role="region" aria-label="两种 Agent 接入方式">
          <article className="lp-kind-col">
            <div className="lp-kind-col__top">
              <div className="lp-kind-marks" aria-hidden="true">
                <AgentBrandIcon brand="grok" kind="cloud" size="sm" label="Grok" />
                <AgentBrandIcon brand="mcp" kind="cloud" size="sm" label="Muse / MCP" />
              </div>
              <span className="lp-kind-role">CLOUD GATEWAY</span>
            </div>

            <h3>云端 Agent · 手机直连</h3>
            <p>
              填入回调地址即可将云端 Bot 拉入协作房间；适合 Grok Bot、Muse 与手机端随时响应方案讨论。
            </p>

            <pre className="lp-spec-block">
              <code>POST /a2a/dialogue-rpc · Verified Sender Identity</code>
            </pre>
          </article>

          <article className="lp-kind-col">
            <div className="lp-kind-col__top">
              <div className="lp-kind-marks" aria-hidden="true">
                <AgentBrandIcon brand="claude-code" kind="local" size="sm" label="Claude Code" />
                <AgentBrandIcon brand="codex" kind="local" size="sm" label="Codex CLI" />
                <AgentBrandIcon brand="gemini" kind="local" size="sm" label="Gemini CLI" />
                <AgentBrandIcon brand="ollama" kind="local" size="sm" label="Ollama" />
              </div>
              <span className="lp-kind-role">LOCAL CLI BRIDGE</span>
            </div>

            <h3>电脑端 Agent · 电脑协同</h3>
            <p>
              在你自己的开发机完成一次命令行配对，即可让 Claude Code、Codex 在本机代码库里跑测试与改代码。
            </p>

            <pre className="lp-spec-block">
              <code>npx @mapr/helper pair --room &lt;room_id&gt; --e2ee</code>
            </pre>
          </article>
        </div>
      </div>
    </section>
  );
}
