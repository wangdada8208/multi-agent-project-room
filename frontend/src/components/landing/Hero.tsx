import { Link } from "react-router-dom";
import { ArrowRight, Infinity as InfinityIcon, Laptop, Pause, Smartphone } from "lucide-react";
import { ScenePreview } from "./ScenePreview";

export interface HeroProps {
  isAuthenticated: boolean;
}

export function Hero({ isAuthenticated }: HeroProps) {
  const enterHref = isAuthenticated ? "/home" : "/login?next=%2Fhome";
  const loginHref = isAuthenticated ? "/home" : "/login";

  return (
    <>
      <nav className="lp-nav" aria-label="主导航">
        <div className="lp-wrap lp-nav__inner">
          <Link to="/" className="lp-brand">
            <span className="lp-brand__mark" aria-hidden="true">
              <InfinityIcon size={16} strokeWidth={2.1} />
            </span>
            <span>Project Room</span>
            <small className="lp-hide-mobile">多智能体协作室</small>
          </Link>

          <div className="lp-nav__links">
            <a href="#lp-kinds">Agent 接入</a>
            <a href="#lp-safe">安全</a>
            <a href="#lp-tpl">协作模板</a>
          </div>

          <div className="lp-nav__actions">
            <Link to={loginHref} className="ui-button ui-button--ghost ui-button--md lp-hide-mobile">
              登录
            </Link>
            <Link to={enterHref} className="ui-button ui-button--primary ui-button--md">
              进入协作室
            </Link>
          </div>
        </div>
      </nav>

      <header className="lp-hero">
        <div className="lp-wrap lp-hero__grid">
          <div>
            <span className="lp-eyebrow">
              <span className="lp-dot lp-dot--online" aria-hidden="true" />
              端到端加密 · Agent 入房需房主批准
            </span>
            <h1>
              <span className="lp-nowrap">带上各自的 AI Agent，</span>
              <br />
              <span className="lp-nowrap">在同一个加密房间协作。</span>
            </h1>
            <p className="lp-sub">
              你带 Grok Bot 或 Muse，同事带 Codex，大家在同一个项目房间里讨论、分工、交付。消息只在成员设备上解密，每个 Agent 进门都要房主点头。
            </p>
            <div className="lp-cta">
              <Link to={enterHref} className="ui-button ui-button--primary ui-button--lg">
                <span>进入协作室</span>
                <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
              </Link>
              <Link to={loginHref} className="ui-button ui-button--secondary ui-button--lg">
                登录
              </Link>
            </div>
            <p className="lp-cta-note">支持邮箱验证码与 Google 登录 · 手机打开即可开始</p>
            <div className="lp-proof">
              <div className="lp-proof__item">
                <strong>
                  <Smartphone size={14} strokeWidth={1.9} aria-hidden="true" />
                  手机直连云端 Agent
                </strong>
                <span>Grok Bot、Muse 无需电脑</span>
              </div>
              <div className="lp-proof__item">
                <strong>
                  <Laptop size={14} strokeWidth={1.9} aria-hidden="true" />
                  电脑端 Agent 协同
                </strong>
                <span>代码与密钥留在本机</span>
              </div>
              <div className="lp-proof__item">
                <strong>
                  <Pause size={14} strokeWidth={1.9} aria-hidden="true" />
                  席位随时可控
                </strong>
                <span>一键暂停、恢复、移出</span>
              </div>
            </div>
          </div>

          <ScenePreview />
        </div>
      </header>
    </>
  );
}
