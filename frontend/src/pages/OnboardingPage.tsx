import { useQueries, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Check, Infinity as InfinityIcon, LayoutGrid, Link2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import type { RoomPermissionMember } from "../hubContracts.generated";
import { fetchRooms } from "../lib/api";
import { apiJson } from "../lib/apiError";
import { listRoomSeats } from "../lib/localHelper";
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

export interface OnboardingProgress {
  roomCount: number;
  hasAgentSeat: boolean;
  hasInvitedMember: boolean;
  isLoading: boolean;
  allComplete: boolean;
  firstRoomId: string | null;
}

export interface OnboardingStep {
  key: "room" | "agent" | "invite";
  index: 1 | 2 | 3;
  label: string;
  done: boolean;
}

const emptyProgress: OnboardingProgress = {
  roomCount: 0,
  hasAgentSeat: false,
  hasInvitedMember: false,
  isLoading: false,
  allComplete: false,
  firstRoomId: null,
};

const ONBOARDING_DISMISSED_KEY = "mapr-onboarding-dismissed";

export function isOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingDismissed(): void {
  try {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
  } catch {
    return;
  }
}

type RoomPermissionsResponse = {
  members?: Array<Pick<RoomPermissionMember, "user_id" | "user_type">>;
};

export function useOnboardingProgress(enabled = true): OnboardingProgress {
  const roomsQuery = useQuery({
    queryKey: ["rooms"],
    queryFn: fetchRooms,
    enabled,
  });
  const rooms = roomsQuery.data ?? [];

  const seatQueries = useQueries({
    queries: rooms.map((room) => ({
      queryKey: ["rooms", room.id, "seats"],
      queryFn: () => listRoomSeats(room.id),
      staleTime: 30_000,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });

  const permissionQueries = useQueries({
    queries: rooms.map((room) => ({
      queryKey: ["rooms", room.id, "permissions"],
      queryFn: () => apiJson<RoomPermissionsResponse>(`/api/v1/rooms/${encodeURIComponent(room.id)}/permissions`),
      staleTime: 30_000,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });

  const hasAgentSeat = seatQueries.some((query) =>
    (query.data ?? []).some((seat) => seat.group_status !== "removed"),
  );
  const hasInvitedMember = permissionQueries.some((query) => {
    const humans = (query.data?.members ?? []).filter((member) => member.user_type !== "agent");
    return humans.length > 1;
  });
  const detailLoading = rooms.length > 0 && (
    seatQueries.some((query) => query.isPending) || permissionQueries.some((query) => query.isPending)
  );
  const roomCount = rooms.length;
  const allComplete = roomCount > 0 && hasAgentSeat && hasInvitedMember;

  return {
    roomCount,
    hasAgentSeat,
    hasInvitedMember,
    isLoading: roomsQuery.isLoading || detailLoading,
    allComplete,
    firstRoomId: rooms[0]?.id ?? null,
  };
}

export function onboardingSteps(progress: Pick<OnboardingProgress, "roomCount" | "hasAgentSeat" | "hasInvitedMember">): OnboardingStep[] {
  return [
    { key: "room", index: 1, label: "开第一个房间", done: progress.roomCount > 0 },
    { key: "agent", index: 2, label: "接入一个智能助手", done: progress.hasAgentSeat },
    { key: "invite", index: 3, label: "邀请一位同事", done: progress.hasInvitedMember },
  ];
}

function ProgressSteps({ steps }: { steps: OnboardingStep[] }) {
  const currentKey = steps.find((step) => !step.done)?.key;
  return (
    <ol className="wb-onb-progress" aria-label="新手进度">
      {steps.map((step) => (
        <li
          key={step.key}
          className={`wb-onb-progress__step${step.done ? " wb-onb-progress__step--done" : ""}${step.key === currentKey ? " wb-onb-progress__step--active" : ""}`}
          aria-label={`第 ${step.index} 步：${step.label}，${step.done ? "已完成" : "未完成"}`}
        >
          <span className="wb-onb-progress__index" aria-hidden="true">
            {step.done ? <Check size={11} strokeWidth={2.4} /> : step.index}
          </span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

function DismissButton({ onDismiss }: { onDismiss?: () => void }) {
  if (!onDismiss) return null;
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
      我知道了，收起引导
    </Button>
  );
}

export interface OnboardingViewProps {
  embedded?: boolean;
  onStartTemplate?: () => void;
  onDismiss?: () => void;
  progress?: OnboardingProgress;
}

export function OnboardingView({ embedded = false, onStartTemplate, onDismiss, progress = emptyProgress }: OnboardingViewProps) {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const userName = user?.display_name || user?.username || "你";
  const [inviteInput, setInviteInput] = useState("");
  const [inviteError, setInviteError] = useState("");
  const steps = onboardingSteps(progress);
  const nextStep = steps.find((step) => !step.done);

  function handleTemplateClick() {
    if (onStartTemplate) {
      onStartTemplate();
    } else {
      navigate("/home?create=1");
    }
  }

  function handleInviteSubmit(event: FormEvent) {
    event.preventDefault();
    const target = parseInviteLinkTarget(inviteInput);
    if (!target) {
      setInviteError("请粘贴有效的房间邀请链接（直接粘贴同事发给你的完整链接）");
      return;
    }
    setInviteError("");
    navigate(target);
  }

  if (progress.allComplete) {
    return (
      <section className="wb-onb-next wb-onb-next--done" aria-label="新手进度">
        <div className="wb-onb-next__copy">
          <h2>新手设置已完成</h2>
          <p>房间、智能助手和同事都已经准备好了。</p>
          <ProgressSteps steps={steps} />
        </div>
        <div className="wb-onb-next__actions">
          <Link to="/home" className="ui-button ui-button--secondary ui-button--sm">返回房间</Link>
          <DismissButton onDismiss={onDismiss} />
        </div>
      </section>
    );
  }

  if (progress.roomCount > 0) {
    const nextHref = nextStep?.key === "agent"
      ? "/agents"
      : nextStep?.key === "invite" && progress.firstRoomId
        ? `/rooms/${encodeURIComponent(progress.firstRoomId)}?panel=invite`
        : "/home";
    const nextLabel = nextStep?.key === "agent" ? "去接入智能助手" : nextStep?.key === "invite" ? "去邀请一位同事" : "查看房间";
    return (
      <section className="wb-onb-next" aria-label="新手进度">
        <div className="wb-onb-next__copy">
          <h2>继续完成新手设置</h2>
          <p>完成后，你就能和智能助手、同事在同一个房间里协作。</p>
          <ProgressSteps steps={steps} />
        </div>
        <div className="wb-onb-next__actions">
          <Link to={nextHref} className="ui-button ui-button--primary ui-button--sm">
            {nextLabel}
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </Link>
          <DismissButton onDismiss={onDismiss} />
        </div>
      </section>
    );
  }

  const HeadingTag = embedded ? "h2" : "h1";

  return (
    <div className={embedded ? "wb-onb wb-onb--embedded" : "wb-onb"}>
      <div className="wb-onb__title-row">
        <div>
          <HeadingTag>欢迎，{userName}。先做一件事就能开始。</HeadingTag>
          <p className="wb-onb__lead">先用模板开一个房间。接入智能助手和邀请同事，可以随后完成。</p>
        </div>
        <DismissButton onDismiss={onDismiss} />
      </div>

      <ProgressSteps steps={steps} />

      <div className="wb-onb-primary-action">
        <Button type="button" variant="primary" size="lg" onClick={handleTemplateClick}>
          <LayoutGrid size={17} strokeWidth={1.9} aria-hidden="true" />
          用模板开第一个房间
        </Button>
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
          粘贴邀请链接加入
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
  const progress = useOnboardingProgress();
  return (
    <div className="wb-onb-shell">
      <header className="wb-onb-shell__top">
        <Link to="/home" className="wb-onb-shell__brand">
          <span className="wb-onb-shell__mark" aria-hidden="true">
            <InfinityIcon size={16} strokeWidth={2} />
          </span>
          <span>Parlor</span>
        </Link>
        <Link to="/home" className="ui-button ui-button--ghost ui-button--sm">
          返回房间
        </Link>
      </header>
      <main className="wb-onb-shell__center">
        <OnboardingView progress={progress} />
      </main>
    </div>
  );
}
