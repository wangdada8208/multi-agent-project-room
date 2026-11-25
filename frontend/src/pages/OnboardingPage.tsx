import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Cloud, LayoutGrid, Link2 } from "lucide-react";
import { ProjectRoomMark } from "../components/icons/BrandIcons";
import { Button } from "../components/ui/Button";
import { useAuthStore } from "../stores/authStore";
import "../components/rooms/Rooms.css";

/** 解析用户粘贴的邀请链接（支持完整 URL 或 /rooms/:id?invite=... 路径），仅放行安全的站内房间路径。 */
export function parseInviteLinkTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let pathname = "";
  let search = "";
  if (trimmed.startsWith("/")) {
    const idx = trimmed.indexOf("?");
    pathname = idx >= 0 ? trimmed.slice(0, idx) : trimmed;
    search = idx >= 0 ? trimmed.slice(idx) : "";
  } else if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      pathname = parsed.pathname;
      search = parsed.search;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const match = pathname.match(/^\/rooms\/([^/?#]+)\/?$/);
  if (!match) return null;
  const roomId = match[1];
  const params = new URLSearchParams(search);
  const invite = params.get("invite")?.trim();
  const basePath = `/rooms/${encodeURIComponent(decodeURIComponent(roomId))}`;
  return invite ? `${basePath}?invite=${encodeURIComponent(invite)}` : basePath;
}

export interface OnboardingViewProps {
  embedded?: boolean;
  onStartTemplate?: () => void;
}

export function OnboardingView({ embedded = false, onStartTemplate }: OnboardingViewProps) {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const userName = user?.display_name || user?.username || "你";
  const [inviteInput, setInviteInput] = useState("");
  const [inviteError, setInviteError] = useState("");

  function markOnboarded() {
    try {
      localStorage.setItem("mapr-onboarded", "1");
    } catch {
      // Ignore storage errors.
    }
  }

  function handleTemplateClick() {
    markOnboarded();
    if (onStartTemplate) {
      onStartTemplate();
    } else {
      navigate("/home?create=1");
    }
  }

  function handleAgentClick() {
    markOnboarded();
    navigate("/agents");
  }

  function handleInviteSubmit(event: FormEvent) {
    event.preventDefault();
    const target = parseInviteLinkTarget(inviteInput);
    if (!target) {
      setInviteError("请粘贴有效的房间邀请链接（例如 https://…/rooms/房间ID?invite=…）");
      return;
    }
    setInviteError("");
    markOnboarded();
    navigate(target);
  }

  const HeadingTag = embedded ? "h2" : "h1";

  return (
    <div className={embedded ? "wb-onb wb-onb--embedded" : "wb-onb"}>
      <HeadingTag>欢迎，{userName}。先做一件事就能开始。</HeadingTag>
      <p className="wb-onb__lead">两条路都只需一分钟，之后随时可以补上另一步。</p>

      <div className="wb-onb-progress" aria-label="开始步骤">
        <span className="wb-onb-progress__step wb-onb-progress__step--active">
          开第一个房间
        </span>
        <span aria-hidden="true">/</span>
        <span className="wb-onb-progress__step">
          接入一个 Agent
        </span>
        <span aria-hidden="true">/</span>
        <span className="wb-onb-progress__step">
          邀请协作者
        </span>
      </div>

      <div className="wb-onb-choices">
        <button type="button" className="wb-onb-choice" onClick={handleTemplateClick}>
          <span className="wb-onb-choice__icon" aria-hidden="true">
            <LayoutGrid size={19} strokeWidth={1.8} />
          </span>
          <h3>用模板开第一个房间</h3>
          <p>选一个协作场景，预览分工和规则，一键建房。房间默认端到端加密。</p>
          <span className="wb-onb-choice__meta">
            代码评审 · 头脑风暴 · 技术辩论 · 开发团队
          </span>
          <span className="wb-onb-choice__go">
            选择模板
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </span>
        </button>

        <button type="button" className="wb-onb-choice" onClick={handleAgentClick}>
          <span className="wb-onb-choice__icon wb-onb-choice__icon--cloud" aria-hidden="true">
            <Cloud size={19} strokeWidth={1.8} />
          </span>
          <h3>先接入一个云端 Agent</h3>
          <p>把 Grok Bot 或 Muse 带进来。手机上就能完成，不需要电脑。我们会顺手帮你建一个房间。</p>
          <span className="wb-onb-choice__meta">
            Grok Bot · Muse · 手机可用
          </span>
          <span className="wb-onb-choice__go">
            开始接入
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </span>
        </button>
      </div>

      <form className="wb-onb-invite" onSubmit={handleInviteSubmit}>
        <Link2 size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className="wb-onb-invite__label">收到了邀请链接？</span>
        <input
          className="wb-onb-invite__input"
          value={inviteInput}
          onChange={(e) => {
            setInviteInput(e.target.value);
            if (inviteError) setInviteError("");
          }}
          placeholder="粘贴邀请链接，直接进入对应房间"
          aria-label="粘贴邀请链接"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={!inviteInput.trim()}>
          进入
        </Button>
      </form>
      {inviteError && (
        <p className="wb-onb-invite__error" role="alert">
          {inviteError}
        </p>
      )}
    </div>
  );
}

export function OnboardingPage() {
  return (
    <div className="wb-onb-shell">
      <header className="wb-onb-shell__top">
        <Link to="/home" className="wb-onb-shell__brand">
          <span className="wb-onb-shell__mark" aria-hidden="true">
            <ProjectRoomMark size={16} />
          </span>
          <span>Project Room</span>
        </Link>
        <Link to="/home" className="ui-button ui-button--ghost ui-button--sm">
          返回协作室
        </Link>
      </header>
      <main className="wb-onb-shell__center">
        <OnboardingView />
      </main>
    </div>
  );
}
