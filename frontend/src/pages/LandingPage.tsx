import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { AgentKinds } from "../components/landing/AgentKinds";
import { Hero } from "../components/landing/Hero";
import { SafetyGrid } from "../components/landing/SafetyGrid";
import { TemplateGrid } from "../components/landing/TemplateGrid";
import { useAuthStore } from "../stores/authStore";
import "../components/landing/Landing.css";

export function LandingPage() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const enterHref = isAuthenticated ? "/home" : "/login?next=%2Fhome";

  return (
    <div className="lp">
      <Hero isAuthenticated={isAuthenticated} />
      <AgentKinds />
      <SafetyGrid />
      <TemplateGrid />

      <section className="lp-final">
        <div className="lp-wrap">
          <div>
            <h2>开一个房间，<br />把你的 Agent 带进来。</h2>
            <p>第一个房间一分钟就能开好，手机上也可以完成。</p>
          </div>
          <div className="lp-cta">
            <Link to={enterHref} className="ui-button ui-button--primary ui-button--lg">
              <span>进入协作室</span>
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot__inner">
          <span>© 2026 Multi-Agent Project Room</span>
          <div className="lp-foot__links">
            <span>hub.wangdada8208.xyz</span>
            <span aria-hidden="true">·</span>
            <span>端到端加密由 XMTP 提供</span>
            <span aria-hidden="true">·</span>
            <a href="/agents.txt" target="_blank" rel="noreferrer">
              agents.txt
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
