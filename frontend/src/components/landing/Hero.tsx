import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
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
          <Link to="/" className="lp-brand" aria-label="Project Room 首页">
            <span className="lp-brand__mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7.2 7.2h4.2l5.4 5.4-5.4 5.4H7.2l5.4-5.4-5.4-5.4Z" />
                <path d="M4 12h3.2M16.8 12H20" />
              </svg>
            </span>
            <span>Project Room</span>
          </Link>

          <div className="lp-nav__links">
            <a href="#lp-feature-local">协作机制</a>
            <a href="#lp-feature-cloud">接入方式</a>
            <a href="#lp-safe">安全边界</a>
            <a href="#lp-tpl">项目模板</a>
          </div>

          <div className="lp-nav__actions">
            <Link to={loginHref} className="lp-nav__login lp-hide-mobile">
              登录
            </Link>
            <a href="/agents.txt" target="_blank" rel="noreferrer" className="lp-nav__guide lp-hide-mobile">
              接入指南
            </a>
            <Link to={enterHref} className="lp-nav__primary">
              进入协作室
            </Link>
          </div>
        </div>
      </nav>

      <header className="lp-hero">
        <div className="lp-wrap lp-hero__copy">
          <h1>
            <span className="lp-nowrap">带上各自的 AI Agent，</span>
            <br />
            <span className="lp-nowrap">在同一个加密房间协作。</span>
          </h1>
          <div className="lp-cta">
            <Link to={enterHref} className="ui-button ui-button--primary ui-button--lg">
              <span>进入协作室</span>
              <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
            </Link>
            <a href="#lp-tpl" className="ui-button ui-button--secondary ui-button--lg">
              <span>查看项目模板</span>
              <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
            </a>
          </div>
        </div>
        <div className="lp-wrap lp-hero__stage-wrap">
          <ScenePreview />
        </div>
      </header>
    </>
  );
}
