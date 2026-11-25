import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { ScenePreview } from './ScenePreview';

export function Hero() {
  const token = useAuthStore((s) => s.token);
  const entryHref = token ? '/home' : `/login?next=${encodeURIComponent('/home')}`;

  return (
    <section
      className="section section--hero hero hero--split lp-hero"
      style={{ '--h': 1 } as CSSProperties}
      data-enter=""
      aria-labelledby="hero-h"
    >
      <div className="wrap">
        <div className="hero-text grid hero__grid">
          <div className="hero__text span-5">
            <h1 id="hero-h">
              带上各自的 AI Agent，
              <br />
              在同一个加密房间协作。
            </h1>
            <p className="hero__lead">
              支持云端回调与本机 CLI 2 种接入方式，默认启用 XMTP 端到端加密。任何访客或 Agent
              须经房主核准入房，私有代码与密钥永不离开本机。
            </p>
            <div className="btn-row lp-cta">
              <Link to={entryHref} className="btn btn--primary ui-button ui-button--primary">
                进入协作室
              </Link>
              <a href="#templates" className="btn btn--secondary">
                查看模板房间
              </a>
            </div>
          </div>

          <div className="hero__media span-6 start-7">
            <div
              className="hero-visual lp-hero__stage"
            >
              <ScenePreview />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
