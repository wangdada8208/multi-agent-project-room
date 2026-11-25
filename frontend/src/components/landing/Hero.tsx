import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Moon, Sun } from "lucide-react";
import heroChamberUrl from "../../assets/visuals/hero-chamber.png";
import { getThemePreference, setThemePreference } from "../../lib/theme";
import { ProjectRoomMark } from "../icons/BrandIcons";
import { ScenePreview } from "./ScenePreview";

export interface HeroProps {
  isAuthenticated: boolean;
}

function isDarkCurrently(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.theme) {
    return document.documentElement.dataset.theme === "dark";
  }
  const pref = getThemePreference();
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
}

export function Hero({ isAuthenticated }: HeroProps) {
  const enterHref = isAuthenticated ? "/home" : "/login?next=%2Fhome";
  const loginHref = isAuthenticated ? "/home" : "/login";
  const [scrolled, setScrolled] = useState(false);
  const [dark, setDark] = useState(isDarkCurrently);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 24);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function toggleTheme() {
    const nextDark = !dark;
    setThemePreference(nextDark ? "dark" : "light");
    setDark(nextDark);
  }

  return (
    <>
      <nav className={scrolled ? "lp-nav lp-nav--scrolled" : "lp-nav"} aria-label="主导航">
        <div className="lp-wrap lp-nav__inner">
          <Link to="/" className="lp-brand">
            <span className="lp-brand__mark" aria-hidden="true">
              <ProjectRoomMark size={18} />
            </span>
            <span>Project Room</span>
          </Link>

          <div className="lp-nav__links">
            <a href="#lp-kinds">Agent 接入</a>
            <a href="#lp-safe">安全边界</a>
            <a href="#lp-tpl">协作模板</a>
          </div>

          <div className="lp-nav__actions">
            <button
              type="button"
              className="lp-theme-btn"
              onClick={toggleTheme}
              aria-label={dark ? "切换至浅色主题" : "切换至深色主题"}
              title={dark ? "切换浅色" : "切换深色"}
            >
              {dark ? <Sun size={16} strokeWidth={1.9} /> : <Moon size={16} strokeWidth={1.9} />}
            </button>
            <Link to={loginHref} className="lp-nav__login lp-hide-mobile">
              登录
            </Link>
            <Link to={enterHref} className="ui-button ui-button--primary lp-nav__cta">
              进入协作室
            </Link>
          </div>
        </div>
      </nav>

      <header className="lp-hero">
        <div className="lp-hero__backdrop" aria-hidden="true">
          <img src={heroChamberUrl} alt="" className="lp-hero__image" />
          <div className="lp-hero__fade" />
        </div>

        <div className="lp-wrap lp-hero__content">
          <div className="lp-hero__head">
            <h1>带上各自的 AI Agent，在同一间密室协作</h1>
            <p className="lp-hero__sub">
              你与同事各带云端或本机智能体入房分工，正文只在成员设备上解密，每次进门都须房主点头。
            </p>
            <div className="lp-cta">
              <Link to={enterHref} className="ui-button ui-button--primary ui-button--lg lp-cta__primary">
                <span>进入协作室</span>
                <ArrowRight size={17} strokeWidth={2} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="lp-hero__stage">
            <ScenePreview />
          </div>
        </div>
      </header>
    </>
  );
}
