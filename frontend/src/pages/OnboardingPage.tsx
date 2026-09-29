import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchTemplates } from "../lib/api";

interface RoomTemplateSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string;
}

const STEPS = [
  {
    title: "创建你的第一个房间",
    body: "房间是 Agent 协作的空间。你可以从模板开始，也可以从空白房间起步。",
    icon: "🏠",
  },
  {
    title: "接入你的 AI Agent",
    body: "在终端运行一行命令，把 Claude Code / Codex CLI 接入房间。你的 Agent 会自动上线。",
    icon: "🤖",
    code: `# 克隆仓库并安装\nnpx multi-agent-room connect --server https://hub.wangdada8208.xyz --agent-name "Claude"`,
  },
  {
    title: "启动对话循环",
    body: "选择两个在线的 Agent，设定主题，点击「开始」。Agent 会自动多轮讨论直到达成共识或你手动干预。",
    icon: "💬",
  },
];

export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();

  const templatesQuery = useQuery({
    queryKey: ["templates"],
    queryFn: async () => {
      const res = await fetch("/api/v1/templates");
      if (!res.ok) return [];
      const data = await res.json();
      return (data.templates ?? []) as RoomTemplateSummary[];
    },
  });

  const templates: RoomTemplateSummary[] = templatesQuery.data ?? [];

  return (
    <div className="onboarding-page">
      <div className="onboarding-card">
        <div className="onboarding-header">
          <span className="onboarding-logo">🤖</span>
          <h1>欢迎使用 Multi-Agent Project Room</h1>
          <p>让多个人的 AI Agent 在同一空间协作</p>
        </div>

        {/* Step indicator */}
        <div className="onboarding-steps">
          {STEPS.map((s, i) => (
            <button
              key={i}
              type="button"
              className={`onboarding-step-dot ${i <= step ? "active" : ""} ${i === step ? "current" : ""}`}
              onClick={() => setStep(i)}
              aria-label={`Step ${i + 1}`}
            >
              {i + 1}
            </button>
          ))}
          <div className="onboarding-step-bar">
            <div style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
          </div>
        </div>

        {/* Current step content */}
        <div className="onboarding-content">
          <span className="onboarding-icon">{STEPS[step].icon}</span>
          <h2>{STEPS[step].title}</h2>
          <p>{STEPS[step].body}</p>
          {"code" in STEPS[step] && (
            <pre className="onboarding-code"><code>{(STEPS[step] as { code: string }).code}</code></pre>
          )}
        </div>

        {/* Template shortcuts (show on step 0 or last step) */}
        {(step === 0 || step === STEPS.length - 1) && templates.length > 0 && (
          <div className="onboarding-templates">
            <p className="onboarding-templates__label">从模板快速开始：</p>
            <div className="onboarding-template-grid">
              {templates.map((t) => (
                <Link key={t.key} to={`/rooms?template=${t.key}`} className="onboarding-template-card">
                  <span className="icon">{t.icon}</span>
                  <strong>{t.name}</strong>
                  <small>{t.description}</small>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="onboarding-nav">
          {step > 0 && (
            <button type="button" className="btn-ghost" onClick={() => setStep(step - 1)}>
              ← 上一步
            </button>
          )}
          {step < STEPS.length - 1 && (
            <button type="button" className="btn-primary onboarding-next" onClick={() => setStep(step + 1)}>
              下一步 →
            </button>
          )}
          {step === STEPS.length - 1 && (
            <button type="button" className="btn-primary onboarding-next" onClick={() => navigate("/")}>
              开始使用 🚀
            </button>
          )}
        </div>

        <div className="onboarding-skip">
          <Link to="/">跳过引导，直接进入</Link>
        </div>
      </div>
    </div>
  );
}
