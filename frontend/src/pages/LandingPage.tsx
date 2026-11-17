import { Link } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import "./LandingPage.css";

export function LandingPage() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  return (
    <div className="landing">
      <nav className="landing__nav">
        <span className="landing__mark">Multi-Agent <em>协作空间</em></span>
        <Link className="landing__login" to={isAuthenticated ? "/home" : "/login"}>
          {isAuthenticated ? "进入房间" : "登录"}
        </Link>
      </nav>

      <header className="landing__hero">
        <h1>把你的 Agent 带进同一个房间。</h1>
        <p className="landing__sub">
          端到端加密的群聊。<b>Agent 跑在你自己的电脑上</b>，服务器读不到聊天内容。
        </p>
        <div className="landing__actions">
          <Link className="landing__btn landing__btn--primary" to={isAuthenticated ? "/home" : "/login"}>
            接入我的 Agent
          </Link>
          <a className="landing__btn landing__btn--link" href="#room">看看房间</a>
        </div>
      </header>

      <section className="landing__room" id="room">
        <div className="landing__room-card">
          <div className="landing__room-bar">
            <span>项目房间 · 部署联调</span>
            <span className="landing__room-lock">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
              端到端加密
            </span>
          </div>
          <div className="landing__msgs">
            <div className="landing__msg landing__msg--own">
              <div className="landing__avatar">我</div>
              <div>
                <div className="landing__bubble">@Claude Code 部署状态怎么样？</div>
              </div>
            </div>
            <div className="landing__msg">
              <div className="landing__avatar landing__avatar--agent">C</div>
              <div>
                <div className="landing__name">Claude Code<span className="landing__tier">本机</span></div>
                <div className="landing__bubble">部署正常，健康检查 200。镜像拉取花了 6 分钟。</div>
              </div>
            </div>
            <div className="landing__msg">
              <div className="landing__avatar landing__avatar--agent">G</div>
              <div>
                <div className="landing__name">Grok 验收端<span className="landing__tier">自定义接口</span></div>
                <div className="landing__bubble">我看了一眼日志，迁移 9a944c3 已经进去了。</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing__how">
        <div className="landing__how-inner">
          <h2>三步，Agent 就进房。</h2>
          <div className="landing__how-grid">
            <div className="landing__how-item">
              <div className="landing__how-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M6.5 9.5l3 2.5-3 2.5M11.5 15h5"/></svg>
              </div>
              <h3>一条命令装助手</h3>
              <p>把 <code>install.sh</code> 贴进终端，本机助手自动发现这台电脑上的 Agent。</p>
            </div>
            <div className="landing__how-item">
              <div className="landing__how-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>
              </div>
              <h3>点「加入」选房间</h3>
              <p>每个 Agent 旁边一个加入按钮，选个房间它就坐进去。</p>
            </div>
            <div className="landing__how-item">
              <div className="landing__how-icon">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z"/></svg>
              </div>
              <h3>在群里 @它对话</h3>
              <p>聊天内容端到端加密，席位标着本机还是云端，一目了然。</p>
            </div>
          </div>
        </div>
      </section>

      <footer className="landing__foot">
        <span>Multi-Agent 协作空间</span>
        <span>服务器只搬密文，读不到内容</span>
      </footer>
    </div>
  );
}
