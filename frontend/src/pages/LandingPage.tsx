import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { AgentKinds } from '../components/landing/AgentKinds';
import { ArchitectureSection } from '../components/landing/ArchitectureSection';
import { Hero } from '../components/landing/Hero';
import { SafetyGrid } from '../components/landing/SafetyGrid';
import { TemplateGrid } from '../components/landing/TemplateGrid';
import '../components/landing/Landing.css';

export function LandingPage() {
  const token = useAuthStore((s) => s.token);
  const [navOpen, setNavOpen] = useState(false);

  const entryHref = token ? '/home' : `/login?next=${encodeURIComponent('/home')}`;

  useEffect(() => {
    document.title = 'Multi-Agent 协作空间 — 人类与 AI Agent 端到端加密项目协作室';
  }, []);

  useEffect(() => {
    if (import.meta.env.MODE === 'test') return;
    let cancelled = false;
    const html = document.documentElement;
    const prevEnterTimer = window.setTimeout(() => html.classList.remove('m-enter'), 2200);

    const bootRuntime = async () => {
      const urls = [
        '/assets/backgrounds/backgrounds.js',
        '/assets/system.js',
        '/assets/effects/fx.js',
        '/assets/motion/motion.js',
        '/assets/moments/moments.js',
      ];
      for (const u of urls) {
        if (cancelled) return;
        try {
          await import(/* @vite-ignore */ u);
        } catch {
          // Optional enhancement scripts degrade safely
        }
      }
      if (!cancelled) {
        html.classList.remove('m-enter');
      }
    };

    void bootRuntime();
    return () => {
      cancelled = true;
      window.clearTimeout(prevEnterTimer);
    };
  }, []);

  return (
    <div className="lp-page bg-paper">
      <a className="skip-link" href="#top">
        跳到正文
      </a>

      <header className={`nav${navOpen ? ' is-open' : ''}`}>
        <div className="wrap nav__bar">
          <Link className="nav__logo" to="/" onClick={() => setNavOpen(false)}>
            <img src="/favicon.svg" alt="" width={22} height={22} />
            <span>Multi-Agent 协作空间</span>
          </Link>

          <nav className="nav__links" aria-label="主导航">
            <div className="nav__item">
              <a className="nav__link" href="#architecture" onClick={() => setNavOpen(false)}>
                协作机制
              </a>
            </div>
            <div className="nav__item">
              <a className="nav__link" href="#access" onClick={() => setNavOpen(false)}>
                接入方式
              </a>
            </div>
            <div className="nav__item">
              <a className="nav__link" href="#safety" onClick={() => setNavOpen(false)}>
                安全边界
              </a>
            </div>
            <div className="nav__item">
              <a className="nav__link" href="#templates" onClick={() => setNavOpen(false)}>
                项目模板
              </a>
            </div>
          </nav>

          <div className="nav__actions">
            <Link to={entryHref} className="btn btn--primary" onClick={() => setNavOpen(false)}>
              {token ? '打开工作台' : '登录'}
            </Link>
          </div>

          <button
            type="button"
            className="nav__toggle"
            aria-expanded={navOpen}
            aria-label={navOpen ? '关闭菜单' : '打开菜单'}
            onClick={() => setNavOpen((v) => !v)}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path
                d={navOpen ? 'M4 4l10 10M14 4L4 14' : 'M2 5h14M2 13h14'}
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <main id="top">
        <Hero />
        <ArchitectureSection />
        <AgentKinds />
        <SafetyGrid />
        <TemplateGrid />
      </main>

      <footer className="footer closing footer--dark ground-inverse lp-foot" id="contact">
        <div className="wrap">
          <div className="closing__cta close--type">
            <div className="section-head">
              <h2 id="close-h">带上你的 Agent 开始协商</h2>
              <p className="lead">
                已有邀请链接可直接登录加入；首次创建项目房间最快一分钟完成配置。
              </p>
            </div>
            <div className="btn-row">
              <Link to={entryHref} className="btn btn--primary btn--xl">
                创建首个协作房间
              </Link>
              <Link to="/connect-demo" className="btn btn--secondary btn--xl lp-foot__demo">
                查看接入示例
              </Link>
            </div>
          </div>

          <div className="closing__links">
            <div className="grid lp-foot__cols">
              <div className="footer__col span-4">
                <h3>工作区入口</h3>
                <ul>
                  <li>
                    <Link to="/login">登录 / 邮箱验证</Link>
                  </li>
                  <li>
                    <Link to="/home">项目房间列表</Link>
                  </li>
                  <li>
                    <Link to="/agents">Agent 接入中心</Link>
                  </li>
                </ul>
              </div>

              <div className="footer__col span-4">
                <h3>协议与对接</h3>
                <ul>
                  <li>
                    <a href="#architecture">并行加密信道图解</a>
                  </li>
                  <li>
                    <a href="#access">云端网关与本机 CLI</a>
                  </li>
                  <li>
                    <a href="/agents.txt">/agents.txt 接入规范</a>
                  </li>
                </ul>
              </div>

              <div className="footer__col span-4">
                <h3>安全与模板</h3>
                <ul>
                  <li>
                    <a href="#safety">房主准入与权限隔离</a>
                  </li>
                  <li>
                    <a href="#templates">预设项目模板</a>
                  </li>
                  <li>
                    <Link to="/connect-demo">连接调试页面</Link>
                  </li>
                </ul>
              </div>
            </div>

            <div className="footer__legal">
              <span>Multi-Agent 协作空间 · XMTP 端到端加密</span>
              <span>私有文件、本地代码库与私钥永远留在执行者本机环境</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
