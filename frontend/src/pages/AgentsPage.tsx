import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  ExternalLink,
  Globe,
  Laptop,
  Layers,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  User,
  Webhook,
} from "lucide-react";
import { apiUrl, createRoom, fetchRooms } from "../lib/api";
import { AGENT_PRESETS, type AgentPresetItem } from "../lib/agentPresets";
import {
  HELPER_ORIGIN,
  createJoinTicket,
  createPairingCode,
  helperHandoffUrl,
  joinViaTicket,
  listLocalAgents,
  listLocalSeats,
  listMyHelpers,
  openHelperPage,
  powershellInstallCommand,
  probeHelper,
  removeRoomSeat,
  revokeHelper,
  TRUST_TIER_LABEL,
  trustTierOf,
  type AgentKind,
  type HelperDevice,
  type HelperProbe,
  type LocalAgentView,
  type SeatViewLocal,
} from "../lib/localHelper";
import { inboxAddress } from "../lib/xmtpLocalIdentity";
import { CopyButton } from "../components/CopyButton";
import { HelperIntroDemo } from "../components/HelperIntroDemo";
import { XmtpUnlock } from "../components/XmtpUnlock";
import { useAuthStore } from "../stores/authStore";
import type { Room } from "../types/chat";

const KIND_LABEL: Record<AgentKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  "openai-compatible": "云端接口",
  webhook: "Webhook",
  "http-model": "HTTP 模型",
};

const SEAT_STATUS_LABEL: Record<SeatViewLocal["status"], string> = {
  starting: "启动中",
  running: "运行中",
  crashed: "已异常退出",
  stopped: "已停止",
  revoked: "已吊销",
};

const SEAT_STATUS_CLASS: Record<SeatViewLocal["status"], string> = {
  starting: "task-badge--working",
  running: "task-badge--completed",
  crashed: "task-badge--failed",
  stopped: "",
  revoked: "",
};

function AgentKindIcon({ kind }: { kind: AgentKind }) {
  if (kind === "claude-code" || kind === "codex" || kind === "gemini-cli") {
    return <Terminal size={17} strokeWidth={1.8} />;
  }
  if (kind === "webhook") {
    return <Webhook size={17} strokeWidth={1.8} />;
  }
  return <Globe size={17} strokeWidth={1.8} />;
}

function PresetIcon({ item }: { item: AgentPresetItem }) {
  if (item.mode === "local-cli") return <Terminal size={18} strokeWidth={1.8} />;
  if (item.trustTier === "custom-webhook") return <Webhook size={18} strokeWidth={1.8} />;
  return <Cpu size={18} strokeWidth={1.8} />;
}

function loginHint(agent: LocalAgentView): string | null {
  if (agent.loginState === "needs-login") return "需先在本机完成 CLI 登录";
  return null;
}

/** 区块 B：第 1 步英雄级配对命令面板 */
function PairingGuidePanel({
  isUnpairedRunning,
  isSecondaryDevice,
  pairing,
  pairingError,
  hubOrigin,
  guideNotice,
  highlighted,
  onGenerate,
}: {
  isUnpairedRunning: boolean;
  isSecondaryDevice?: boolean;
  pairing: { code: string; install_command: string; expires_at: string } | null;
  pairingError: string;
  hubOrigin: string;
  guideNotice: string;
  highlighted?: boolean;
  onGenerate: () => void;
}) {
  const [osTab, setOsTab] = useState<"unix" | "windows">(() =>
    typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent)
      ? "windows"
      : "unix",
  );
  const [copiedHero, setCopiedHero] = useState(false);

  const commandText = useMemo(() => {
    if (!pairing) return "";
    return osTab === "windows"
      ? powershellInstallCommand(pairing.code, hubOrigin)
      : pairing.install_command;
  }, [pairing, osTab, hubOrigin]);

  async function handleCopyHero() {
    if (!commandText) return;
    try {
      await navigator.clipboard.writeText(commandText);
      setCopiedHero(true);
      window.setTimeout(() => setCopiedHero(false), 1800);
    } catch {
      /* 忽略剪贴板权限异常 */
    }
  }

  return (
    <div
      className={`card ${highlighted ? "step-one-highlight" : ""}`}
      style={{
        padding: "24px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Terminal size={18} strokeWidth={1.9} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <strong style={{ fontSize: 16, color: "var(--text-primary)", letterSpacing: "-0.015em" }}>
              {isUnpairedRunning
                ? "本机助手已在运行 · 完成当前账号配对"
                : isSecondaryDevice
                  ? "在另一台电脑的「终端」粘贴并回车（只需一次）"
                  : "第 1 步：复制下面这一行命令，到电脑「终端」粘贴并回车（只需一次）"}
            </strong>
          </div>
          <p style={{ fontSize: 13.5, color: "var(--text-secondary)", marginTop: 5, lineHeight: 1.55 }}>
            运行后会自动启动本机助手并识别你电脑上的 Claude Code、Codex、Gemini CLI，同时支持一键配置 Grok 与 Muse。所有密钥只保存在你的电脑本地。
          </p>
        </div>

        {/* 双系统 Segmented Switcher */}
        <div
          role="tablist"
          aria-label="操作系统命令切换"
          className="segmented"
          style={{ width: "auto", flexShrink: 0 }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={osTab === "unix"}
            className={`segmented__btn ${osTab === "unix" ? "segmented__btn--active" : ""}`}
            onClick={() => setOsTab("unix")}
            style={{ flex: "none", padding: "6px 12px", fontSize: 12.5 }}
          >
            macOS / Linux
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={osTab === "windows"}
            className={`segmented__btn ${osTab === "windows" ? "segmented__btn--active" : ""}`}
            onClick={() => setOsTab("windows")}
            style={{ flex: "none", padding: "6px 12px", fontSize: 12.5 }}
          >
            Windows PowerShell
          </button>
        </div>
      </div>

      {guideNotice && <div className="setup-info">{guideNotice}</div>}

      {pairing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="code-block">
            <CopyButton text={commandText} label="复制命令" />
            {commandText}
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleCopyHero()}
              >
                {copiedHero ? <Check size={14} strokeWidth={2.2} /> : <Copy size={14} strokeWidth={2} />}
                <span>{copiedHero ? "已复制命令，去终端粘贴回车" : "一键复制终端配对命令"}</span>
              </button>

              {isUnpairedRunning && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => openHelperPage({ pair: pairing.code })}
                >
                  <span>本机已在运行 · 一键跳转完成配对</span>
                  <ArrowUpRight size={14} strokeWidth={2} />
                </button>
              )}

              <button type="button" className="btn btn-ghost btn-sm" onClick={onGenerate}>
                <RefreshCw size={13} strokeWidth={2} />
                <span>重新生成命令</span>
              </button>
            </div>

            <span className="live-wait-status">
              <span className="pulse-dot" aria-hidden="true" />
              <span>正在等待本机助手连接… 终端运行成功后此页面会自动刷新</span>
            </span>
          </div>
        </div>
      ) : pairingError ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <p className="error-text">{pairingError}</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onGenerate}>
            <RefreshCw size={13} strokeWidth={2} />
            <span>重试生成配对命令</span>
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13.5 }}>
          <span className="spinner" />
          <span>正在生成专属一次性配对命令…</span>
        </div>
      )}

      {/* Safari / 本地控制台单行轻量兜底入口 */}
      <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
        <span>已在终端运行过命令但页面没反应？</span>
        <button
          type="button"
          className="agent-link"
          onClick={() => openHelperPage(pairing?.code ? { pair: pairing.code } : undefined)}
        >
          点此直接打开本机控制台 (127.0.0.1:8790) →
        </button>
      </div>

      {/* 折叠式 20 秒终端配对动画演示 */}
      <details className="helper-demo-disclosure">
        <summary>查看 20 秒终端配对动画演示</summary>
        <div className="helper-demo-disclosure__body">
          <HelperIntroDemo />
        </div>
      </details>
    </div>
  );
}

export interface AgentJoinSectionProps {
  /** 固定房间（向导场景）：隐藏房间选择，直接加入这个房间。 */
  roomId?: string;
  roomName?: string;
  /** 默认预选房间（例如来自 /agents?room=<roomId>）。 */
  defaultRoomId?: string;
  /** 已解锁的本机加密地址；没传时加入流程会内联要求解锁。 */
  ownerXmtpAddress?: string;
  /** 加入成功后的回调（例如向导推进到下一步）。 */
  onJoined?: (seat: SeatViewLocal) => void;
}

/**
 * 「接入 Agent」全流程核心组件：
 * - 区块 A：本机已就绪的 Agent（一键入房 + 当前房间席位管理）
 * - 区块 B：首次连接本机助手 / 双系统配对引导（已配对后自动折叠至底部）
 * - 区块 C：主流 Agent 一键接入目录（Claude Code · Codex · Grok / Grokbot · Muse · Gemini CLI · Ollama · 自定义 Webhook）
 */
export function AgentJoinSection({
  roomId,
  roomName,
  defaultRoomId,
  ownerXmtpAddress,
  onJoined,
}: AgentJoinSectionProps) {
  const user = useAuthStore((s) => s.user);

  const [probe, setProbe] = useState<HelperProbe | null>(null);
  const [pairing, setPairing] = useState<{ code: string; install_command: string; expires_at: string } | null>(null);
  const [pairingError, setPairingError] = useState("");
  const [guideNotice, setGuideNotice] = useState("");
  const [highlightStepOne, setHighlightStepOne] = useState(false);
  const [expandAnotherComputer, setExpandAnotherComputer] = useState(false);
  const pairingFetched = useRef(false);
  const pairingSectionRef = useRef<HTMLDivElement>(null);
  const highlightTimerRef = useRef<number>(0);

  const [agents, setAgents] = useState<LocalAgentView[]>([]);
  const [seats, setSeats] = useState<SeatViewLocal[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [helpers, setHelpers] = useState<HelperDevice[]>([]);
  const [helperPick, setHelperPick] = useState("");
  const [roomPick, setRoomPick] = useState(roomId ?? defaultRoomId ?? "");

  // 快速新建房间内联表单
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [quickRoomName, setQuickRoomName] = useState("");
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [createRoomError, setCreateRoomError] = useState("");

  const [unlockedAddress, setUnlockedAddress] = useState("");
  const [pendingJoin, setPendingJoin] = useState<{ agentKey: string; roomId: string } | null>(null);
  const [joiningKey, setJoiningKey] = useState<string | null>(null);
  const [joinError, setJoinError] = useState("");
  const [joinedSeat, setJoinedSeat] = useState<SeatViewLocal | null>(null);
  const [listError, setListError] = useState("");
  const [rescanning, setRescanning] = useState(false);

  const hubOrigin = useMemo(() => apiUrl("").replace(/\/$/, "") || window.location.origin, []);

  useEffect(() => {
    if (roomId) {
      setRoomPick(roomId);
    } else if (defaultRoomId) {
      setRoomPick((prev) => prev || defaultRoomId);
    }
  }, [roomId, defaultRoomId]);

  const effectiveRoomId = roomId ?? roomPick;

  // 立即加载用户房间列表，支持 ?room= 预选与 0 房间内联创建
  const loadRooms = useCallback(async () => {
    if (roomId) {
      setRoomsLoaded(true);
      return;
    }
    try {
      const list = await fetchRooms();
      setRooms(list);
      setRoomPick((prev) => {
        if (prev && list.some((r) => r.id === prev)) return prev;
        if (defaultRoomId && list.some((r) => r.id === defaultRoomId)) return defaultRoomId;
        return list[0]?.id ?? "";
      });
    } catch {
      /* 忽略房间拉取瞬时异常 */
    } finally {
      setRoomsLoaded(true);
    }
  }, [roomId, defaultRoomId]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  // 探测循环：未 running 时每 3 秒重试；running 时每 5 秒刷新列表
  const refreshLocal = useCallback(async () => {
    const [agentList, seatList] = await Promise.all([listLocalAgents(), listLocalSeats()]);
    setAgents(agentList);
    setSeats(seatList);
    setListError("");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const result = await probeHelper();
      if (cancelled) return;
      setProbe(result);
      if (result.state === "running") {
        try {
          await refreshLocal();
        } catch (err) {
          if (cancelled) return;
          if (err instanceof TypeError) {
            setProbe({ state: "blocked" });
          } else {
            setListError(err instanceof Error ? err.message : "读取本机助手失败");
          }
        }
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, result.state === "running" ? 5000 : 3000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshLocal]);

  const isHelperReadyAndPaired = probe?.state === "running" && probe.hello.paired;

  useEffect(() => {
    if (isHelperReadyAndPaired) {
      setGuideNotice("");
    }
  }, [isHelperReadyAndPaired]);

  // 已配对后拉取设备列表供签发票据
  useEffect(() => {
    if (!isHelperReadyAndPaired) return;
    let cancelled = false;
    listMyHelpers()
      .then((list) => {
        if (cancelled) return;
        const active = list.filter((h) => !h.revoked);
        setHelpers(active);
        const freshest = [...active].sort(
          (a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""),
        )[0];
        if (freshest) setHelperPick((prev) => prev || freshest.id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isHelperReadyAndPaired]);

  const needPairingCode =
    (probe !== null && !isHelperReadyAndPaired) || expandAnotherComputer;

  const ensurePairing = useCallback((forceRefresh = false) => {
    if (!forceRefresh && pairingFetched.current) return;
    pairingFetched.current = true;
    setPairingError("");
    if (forceRefresh) setPairing(null);
    createPairingCode()
      .then(setPairing)
      .catch((err) => {
        pairingFetched.current = false;
        setPairingError(err instanceof Error ? err.message : "生成配对码失败");
      });
  }, []);

  useEffect(() => {
    if (needPairingCode) {
      ensurePairing(false);
    }
  }, [needPairingCode, ensurePairing]);

  async function handleQuickCreateRoom() {
    const trimmed = quickRoomName.trim();
    if (!trimmed || creatingRoom) return;
    setCreatingRoom(true);
    setCreateRoomError("");
    try {
      const created = await createRoom(trimmed);
      setRooms((prev) => [created, ...prev]);
      setRoomPick(created.id);
      setQuickRoomName("");
      setShowQuickCreate(false);
      setJoinError("");
    } catch (err) {
      setCreateRoomError(err instanceof Error ? err.message : "创建房间失败，请重试");
    } finally {
      setCreatingRoom(false);
    }
  }

  async function handleManualRescan() {
    setRescanning(true);
    try {
      const p = await probeHelper();
      setProbe(p);
      if (p.state === "running") {
        await refreshLocal();
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : "扫描失败");
    } finally {
      setRescanning(false);
    }
  }

  const myAddress = ownerXmtpAddress || unlockedAddress;

  async function runJoin(agentKey: string, targetRoomId: string, address: string) {
    setJoiningKey(agentKey);
    setJoinError("");
    try {
      let helperId = helperPick;
      if (!helperId) {
        const list = (await listMyHelpers()).filter((h) => !h.revoked);
        setHelpers(list);
        helperId =
          [...list].sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""))[0]?.id ?? "";
        if (helperId) setHelperPick(helperId);
      }
      if (!helperId) {
        setJoinError("本机助手尚未绑定到当前账号，请先完成配对后再加入。");
        return;
      }
      const { ticket } = await createJoinTicket(helperId, {
        room_id: targetRoomId,
        agent_key: agentKey,
        owner_xmtp_address: address,
      });
      try {
        const seat = await joinViaTicket(ticket, agentKey);
        setJoinedSeat(seat);
        onJoined?.(seat);
        await refreshLocal();
      } catch (err) {
        if (err instanceof TypeError) {
          openHelperPage({ ticket, agentKey });
          return;
        }
        throw err;
      }
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : "加入失败，请重试");
    } finally {
      setJoiningKey(null);
    }
  }

  function startJoin(agentKey: string) {
    const target = effectiveRoomId;
    if (!target) {
      setJoinError("请先选择或创建一个要加入的协作房间。");
      return;
    }
    setJoinError("");
    setJoinedSeat(null);
    if (myAddress) {
      void runJoin(agentKey, target, myAddress);
    } else {
      setPendingJoin({ agentKey, roomId: target });
    }
  }

  async function leaveSeat(seat: SeatViewLocal) {
    try {
      await removeRoomSeat(seat.roomId, seat.seatId);
      await refreshLocal();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "移出席位失败");
    }
  }

  useEffect(() => () => window.clearTimeout(highlightTimerRef.current), []);

  function openPresetConfig(presetId: string) {
    if (isHelperReadyAndPaired) {
      const action = { preset: presetId, roomId: effectiveRoomId || undefined };
      const win = window.open(helperHandoffUrl(action), "_blank", "noopener,noreferrer");
      if (!win) {
        openHelperPage(action);
      }
      return;
    }

    if (probe?.state === "blocked" || (probe?.state === "running" && !probe.hello.paired)) {
      const action = {
        preset: presetId,
        roomId: effectiveRoomId || undefined,
        pairCode: pairing?.code,
      };
      const win = window.open(helperHandoffUrl(action), "_blank", "noopener,noreferrer");
      if (!win) {
        openHelperPage(action);
      }
      return;
    }

    ensurePairing(false);
    setGuideNotice("请先完成第 1 步：复制下方命令到电脑「终端」粘贴并回车，启动本机助手后即可一键配置并接入。");
    setHighlightStepOne(true);
    window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlightStepOne(false), 2400);
    window.requestAnimationFrame(() => {
      pairingSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  const activeSeatKeysInSelectedRoom = useMemo(() => {
    const keys = new Set<string>();
    if (!effectiveRoomId) return keys;
    for (const s of seats) {
      if (
        s.roomId === effectiveRoomId &&
        (s.status === "running" || s.status === "starting")
      ) {
        keys.add(s.agentKey);
      }
    }
    return keys;
  }, [seats, effectiveRoomId]);

  const activeSeatsForDisplay = useMemo(
    () => seats.filter((s) => s.status !== "revoked" && s.status !== "stopped"),
    [seats],
  );

  const selectedRoomObj = rooms.find((r) => r.id === effectiveRoomId);

  return (
    <div className="agent-panel-stack">
      {/* ── 0 房间时的快捷建房横幅（无论是否配对，永不让新用户死胡同） ── */}
      {!roomId && roomsLoaded && rooms.length === 0 && (
        <div
          className="card"
          style={{
            padding: "18px 20px",
            background: "var(--bg-subtle)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Layers size={16} strokeWidth={1.9} style={{ color: "var(--accent)" }} />
            <strong style={{ fontSize: 14.5, color: "var(--text-primary)" }}>先创建一个协作房间</strong>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            你还没有协作房间。输入名称一键创建，随后即可把 Claude Code、Codex、Grok、Muse 等智能体拉入房间。
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 220 }}
              value={quickRoomName}
              onChange={(e) => setQuickRoomName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleQuickCreateRoom()}
              placeholder="例如：核心架构评审室 / 产品迭代协作间"
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={creatingRoom || !quickRoomName.trim()}
              onClick={() => void handleQuickCreateRoom()}
            >
              <Plus size={15} strokeWidth={2} />
              <span>{creatingRoom ? "创建中…" : "先创建一个协作房间"}</span>
            </button>
          </div>
          {createRoomError && <p className="error-text">{createRoomError}</p>}
        </div>
      )}

      {/* ── 探测加载态 ── */}
      {probe === null && (
        <div
          className="card"
          style={{
            padding: "20px 24px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "var(--text-secondary)",
            fontSize: 14,
          }}
        >
          <span className="spinner" />
          <span>正在检测这台电脑上的本机助手 (127.0.0.1:8790)…</span>
        </div>
      )}

      {/* ── 区块 B（置顶模式）：本机助手未运行 / 被拦截 / 未配对时置顶展示 ── */}
      {probe !== null && !isHelperReadyAndPaired && (
        <div id="install-pair-section" ref={pairingSectionRef}>
          <PairingGuidePanel
            isUnpairedRunning={probe.state === "running" && !probe.hello.paired}
            pairing={pairing}
            pairingError={pairingError}
            hubOrigin={hubOrigin}
            guideNotice={guideNotice}
            highlighted={highlightStepOne}
            onGenerate={() => ensurePairing(true)}
          />
        </div>
      )}

      {/* ── 区块 A：本机已就绪的 Agent（一键入房） ── */}
      {isHelperReadyAndPaired && probe.state === "running" && (
        <div
          className="card"
          style={{
            padding: "22px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            background: "#ffffff",
            border: "1px solid rgba(0, 0, 0, 0.08)",
          }}
        >
          {probe.hello.hub_origin && probe.hello.hub_origin !== hubOrigin && (
            <div className="setup-note">
              本机助手当前配对的服务器为 {probe.hello.hub_origin}，与当前站点（{hubOrigin}）不一致。
            </div>
          )}

          {pendingJoin && (
            <div
              style={{
                padding: "16px",
                borderRadius: 12,
                background: "#f5f5f7",
                border: "1px solid rgba(0, 0, 0, 0.08)",
              }}
            >
              <XmtpUnlock
                onUnlock={(key) => {
                  const address = inboxAddress(key);
                  setUnlockedAddress(address);
                  const pending = pendingJoin;
                  setPendingJoin(null);
                  void runJoin(pending.agentKey, pending.roomId, address);
                }}
              />
              <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPendingJoin(null)}>
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 顶栏：标题 + 操作按钮 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#1d7a3c",
                    display: "inline-block",
                  }}
                />
                <strong style={{ fontSize: 16, color: "#1d1d1f" }}>本机已就绪的 Agent（一键入房）</strong>
              </div>
              <p style={{ fontSize: 13, color: "#6e6e73", marginTop: 2 }}>
                已连接本机助手 v{probe.hello.version}
                {probe.hello.owner_display_name ? ` · 账号「${probe.hello.owner_display_name}」` : ""}
              </p>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void handleManualRescan()}
                disabled={rescanning}
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                <RefreshCw size={13} strokeWidth={2} />
                <span>{rescanning ? "扫描中…" : "重新扫描"}</span>
              </button>
              <a
                className="btn btn-ghost btn-sm"
                href={`${HELPER_ORIGIN}/`}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none" }}
              >
                <span>打开本机控制台 (127.0.0.1:8790)</span>
                <ExternalLink size={13} strokeWidth={2} />
              </a>
            </div>
          </div>

          {/* 房间选择器 + 快速新建房间切换 */}
          {!roomId ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "12px 14px",
                borderRadius: 12,
                background: "#f5f5f7",
                border: "1px solid rgba(0, 0, 0, 0.06)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: "#1d1d1f", whiteSpace: "nowrap" }}>
                  目标协作房间
                </label>
                <select
                  className="input"
                  style={{ flex: 1, minWidth: 200, background: "#ffffff" }}
                  value={roomPick}
                  onChange={(e) => setRoomPick(e.target.value)}
                >
                  <option value="">选择要加入的房间…</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowQuickCreate((v) => !v)}
                >
                  <Plus size={14} strokeWidth={2} />
                  <span>快速新建房间</span>
                </button>
                {effectiveRoomId && (
                  <Link
                    to={`/rooms/${effectiveRoomId}`}
                    className="btn btn-primary btn-sm"
                  >
                    <span>进入房间开始 @Agent 协作</span>
                    <ArrowRight size={14} strokeWidth={2} />
                  </Link>
                )}
              </div>

              {showQuickCreate && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 200 }}
                    value={quickRoomName}
                    onChange={(e) => setQuickRoomName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void handleQuickCreateRoom()}
                    placeholder="输入新房间名称，回车即可创建…"
                    autoFocus
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={creatingRoom || !quickRoomName.trim()}
                    onClick={() => void handleQuickCreateRoom()}
                  >
                    {creatingRoom ? "创建中…" : "确认创建"}
                  </button>
                  {createRoomError && <span className="error-text">{createRoomError}</span>}
                </div>
              )}
            </div>
          ) : (
            roomName && (
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "var(--bg-subtle)",
                  fontSize: 13,
                  color: "var(--text-primary)",
                }}
              >
                当前配置房间：<strong>「{roomName}」</strong>
              </div>
            )
          )}

          {helpers.length > 1 && (
            <div className="field">
              <label>选择执行席位的已配对电脑</label>
              <select className="input" value={helperPick} onChange={(e) => setHelperPick(e.target.value)}>
                {helpers.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.device_name}（{h.platform}
                    {h.last_seen_at ? ` · 最近在线 ${new Date(h.last_seen_at).toLocaleString("zh-CN")}` : ""}）
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 本机扫描到的 Agent 列表 */}
          {agents.length === 0 ? (
            <div
              style={{
                padding: "16px",
                borderRadius: 12,
                background: "var(--bg-subtle)",
                color: "var(--text-secondary)",
                fontSize: 13.5,
              }}
            >
              暂未在本机扫描到已安装的命令行智能体。你可以直接在下方「接入更多主流智能体」一键配置 Grok、Muse、Ollama，或展开查看安装命令。
            </div>
          ) : (
            <div className="agent-list">
              {agents.map((agent) => {
                const alreadySeated = activeSeatKeysInSelectedRoom.has(agent.key);
                const tier = trustTierOf(agent.kind);
                return (
                  <div key={agent.key} className="agent-row">
                    <span className="agent-row__icon">
                      <AgentKindIcon kind={agent.kind} />
                    </span>
                    <div className="agent-row__info">
                      <strong>
                        <span>{agent.displayName}</span>
                        <span className={`trust-badge trust-badge--${tier} tier-badge tier-badge--${tier}`}>
                          {TRUST_TIER_LABEL[tier]}
                        </span>
                        <span className="agent-tag">{KIND_LABEL[agent.kind] ?? agent.kind}</span>
                        {loginHint(agent) && <span className="agent-tag agent-tag--warn">{loginHint(agent)}</span>}
                      </strong>
                      <small>
                        {agent.version ? `${agent.version} · ` : ""}
                        {agent.source === "detected" ? "本机自动发现" : "本机预设配置"}
                      </small>
                    </div>

                    {alreadySeated ? (
                      <span className="trust-badge trust-badge--local-cli" style={{ padding: "5px 12px", fontSize: 12.5 }}>
                        <Check size={13} strokeWidth={2.2} />
                        <span>已在房间中</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={joiningKey !== null || !effectiveRoomId}
                        onClick={() => startJoin(agent.key)}
                      >
                        {joiningKey === agent.key ? "正在加入…" : "加入房间"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {joinError && <p className="error-text">{joinError}</p>}
          {listError && <p className="error-text">{listError}</p>}

          {joinedSeat && (
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 12,
                background: "var(--success-bg)",
                border: "1px solid var(--success-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
                fontSize: 13.5,
                color: "var(--success)",
                fontWeight: 500,
              }}
            >
              <span>席位已创建并启动，进入房间后将自动同步拉入端到端加密群。</span>
              <Link
                to={`/rooms/${joinedSeat.roomId}`}
                className="btn btn-primary btn-sm"
              >
                <span>进入房间开始 @Agent 协作</span>
                <ArrowRight size={14} strokeWidth={2} />
              </Link>
            </div>
          )}

          {/* 当前运行中的席位列表 */}
          {activeSeatsForDisplay.length > 0 && (
            <div
              style={{
                paddingTop: 14,
                borderTop: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 14, color: "var(--text-primary)" }}>
                  本机运行中的房间席位 ({activeSeatsForDisplay.length})
                </strong>
                {effectiveRoomId && (
                  <Link
                    to={`/rooms/${effectiveRoomId}`}
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--accent)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <span>进入「{selectedRoomObj?.name ?? roomName ?? "当前房间"}」开始 @Agent 协作</span>
                    <ArrowRight size={14} strokeWidth={2} />
                  </Link>
                )}
              </div>

              <div className="agent-list">
                {activeSeatsForDisplay.map((seat) => {
                  const matchedAgent = agents.find((a) => a.key === seat.agentKey);
                  const tier = matchedAgent ? trustTierOf(matchedAgent.kind) : "custom-webhook";
                  return (
                    <div key={seat.seatId} className="agent-row">
                      <Cpu size={17} strokeWidth={1.8} style={{ color: "var(--text-primary)", flexShrink: 0 }} />
                      <div className="agent-row__info">
                        <strong>
                          <span>{matchedAgent?.displayName ?? seat.agentKey}</span>
                          <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>· {seat.roomName}</span>
                          <span className={`task-badge ${SEAT_STATUS_CLASS[seat.status]}`}>
                            {SEAT_STATUS_LABEL[seat.status]}
                          </span>
                          <span className={`trust-badge trust-badge--${tier} tier-badge tier-badge--${tier}`}>
                            {TRUST_TIER_LABEL[tier]}
                          </span>
                        </strong>
                        <small>
                          加密地址 {seat.xmtpAddress.slice(0, 8)}…{seat.xmtpAddress.slice(-4)}
                          {seat.lastError ? ` · ${seat.lastError}` : ""}
                        </small>
                      </div>
                      <Link
                        to={`/rooms/${seat.roomId}`}
                        className="btn btn-ghost btn-sm"
                        style={{ textDecoration: "none" }}
                      >
                        进入房间
                      </Link>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => void leaveSeat(seat)}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                      >
                        <Trash2 size={13} strokeWidth={1.8} />
                        <span>移出</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!myAddress && !pendingJoin && (
            <p className="hint">首次点击「加入房间」时会验证一次你的本机加密口令，用于将席位绑定至你的加密身份。</p>
          )}
          {user && probe.hello.owner_display_name && probe.hello.owner_display_name !== user.display_name && (
            <p className="hint">提示：本机助手配对账号显示为「{probe.hello.owner_display_name}」。</p>
          )}
        </div>
      )}

      {/* ── 区块 C：主流智能体一键接入目录（始终展示） ── */}
      <div
        className="card"
        style={{
          padding: "22px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <strong style={{ fontSize: 16, color: "var(--text-primary)", display: "block" }}>
            {!isHelperReadyAndPaired ? "第 2 步：一键接入主流智能体" : "接入更多主流智能体"}
          </strong>
          <p style={{ fontSize: 13.5, color: "var(--text-secondary)", marginTop: 4 }}>
            支持本机终端智能体自动识别，也支持一键接入 Grok / Grokbot、Muse、Ollama 本机开源模型与自定义智能体服务。
          </p>
        </div>

        <div className="agents-preset-grid">
          {AGENT_PRESETS.map((item) => {
            const detectedLocal =
              item.mode === "local-cli" && item.cliKey
                ? agents.find((a) => a.key === item.cliKey)
                : undefined;
            const alreadyInRoom =
              detectedLocal ? activeSeatKeysInSelectedRoom.has(detectedLocal.key) : false;

            return (
              <div key={item.id} className="agents-preset-card">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="agents-preset-card__head">
                    <span className="agents-preset-card__icon">
                      <PresetIcon item={item} />
                    </span>
                    <span className={`trust-badge trust-badge--${item.trustTier} tier-badge tier-badge--${item.trustTier}`}>
                      {TRUST_TIER_LABEL[item.trustTier]}
                    </span>
                  </div>

                  <div>
                    <strong className="agents-preset-card__title" style={{ display: "block" }}>
                      {item.title}
                    </strong>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{item.subtitle}</span>
                  </div>

                  <p className="agents-preset-card__desc">{item.description}</p>
                </div>

                {/* 底部操作区 */}
                {item.mode === "local-cli" ? (
                  isHelperReadyAndPaired && detectedLocal ? (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <span
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: "var(--success)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <Check size={13} strokeWidth={2.2} />
                        <span>已在本机检测到</span>
                      </span>
                      {alreadyInRoom ? (
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>已在当前房间</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={joiningKey !== null || !effectiveRoomId}
                          onClick={() => startJoin(detectedLocal.key)}
                        >
                          {joiningKey === detectedLocal.key ? "加入中…" : "加入当前房间"}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>
                        {!isHelperReadyAndPaired
                          ? "完成第 1 步后将自动识别，已安装无需重装"
                          : "本机暂未检测到该命令行工具"}
                      </span>
                      {item.installCmd && (
                        <details className="helper-demo-disclosure helper-demo-disclosure--compact">
                          <summary>电脑上还没装？查看安装命令</summary>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 6,
                              marginTop: 6,
                              padding: "6px 8px",
                              borderRadius: 8,
                              background: "var(--bg-subtle)",
                              border: "1px solid var(--border)",
                            }}
                          >
                            <code
                              style={{
                                fontSize: 11,
                                color: "var(--text-primary)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={item.installCmd}
                            >
                              {item.installCmd}
                            </code>
                            <CopyButton text={item.installCmd} label="复制" />
                          </div>
                        </details>
                      )}
                    </div>
                  )
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => item.helperPreset && openPresetConfig(item.helperPreset)}
                      style={{ width: "100%", justifyContent: "center" }}
                    >
                      <span>一键配置并接入</span>
                      <ArrowUpRight size={14} strokeWidth={2} />
                    </button>
                    {item.altHelperPreset && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => openPresetConfig(item.altHelperPreset!)}
                        style={{ width: "100%", justifyContent: "center", fontSize: 12 }}
                      >
                        <span>使用 {item.altLabel ?? "Webhook"} 桥接接入</span>
                        <ArrowUpRight size={13} strokeWidth={1.9} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 区块 B（折叠模式）：当当前电脑已配对时，在底部提供连接另一台电脑折叠面板 ── */}
      {isHelperReadyAndPaired && (
        <div
          ref={pairingSectionRef}
          className="card"
          style={{
            padding: "16px 20px",
          }}
        >
          <button
            type="button"
            onClick={() => setExpandAnotherComputer((v) => !v)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
              color: "var(--text-primary)",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Laptop size={16} strokeWidth={1.8} style={{ color: "var(--text-secondary)" }} />
              <span>连接另一台电脑 / 获取新设备安装命令</span>
            </span>
            {expandAnotherComputer ? (
              <ChevronUp size={16} strokeWidth={1.9} style={{ color: "var(--text-secondary)" }} />
            ) : (
              <ChevronDown size={16} strokeWidth={1.9} style={{ color: "var(--text-secondary)" }} />
            )}
          </button>

          {expandAnotherComputer && (
            <div style={{ marginTop: 16 }}>
              <PairingGuidePanel
                isUnpairedRunning={false}
                isSecondaryDevice
                pairing={pairing}
                pairingError={pairingError}
                hubOrigin={hubOrigin}
                guideNotice=""
                onGenerate={() => ensurePairing(true)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── /agents 页面 ──

export function AgentsPage() {
  const user = useAuthStore((s) => s.user);
  const [searchParams] = useSearchParams();
  const roomFromQuery = searchParams.get("room") ?? undefined;

  const [helpers, setHelpers] = useState<HelperDevice[] | null>(null);
  const [helperError, setHelperError] = useState("");

  const loadHelpers = useCallback(() => {
    listMyHelpers()
      .then((list) => {
        setHelpers(list);
        setHelperError("");
      })
      .catch((err) => setHelperError(err instanceof Error ? err.message : "读取设备列表失败"));
  }, []);

  useEffect(loadHelpers, [loadHelpers]);

  async function revoke(device: HelperDevice) {
    if (!window.confirm(`吊销「${device.device_name}」？它在协作房间的席位会一并移出，本机助手下次心跳后停止。`)) {
      return;
    }
    try {
      await revokeHelper(device.id);
      loadHelpers();
    } catch (err) {
      setHelperError(err instanceof Error ? err.message : "吊销失败，请重试");
    }
  }

  const showPairedDevicesCard = Boolean(helperError) || (helpers !== null && helpers.length > 0);

  return (
    <div>
      <header className="topbar">
        <Link to="/home" className="topbar__brand">
          <Layers size={16} strokeWidth={1.9} />
          <span>Multi-Agent 协作空间</span>
        </Link>
        <span className="topbar__spacer" />
        <div className="topbar__actions">
          <Link to="/home" className="btn btn-ghost btn-sm">
            <ArrowLeft size={14} strokeWidth={1.9} />
            <span>返回房间列表</span>
          </Link>
          {user?.display_name && (
            <span className="topbar__user">
              <User size={13} strokeWidth={1.9} />
              {user.display_name}
            </span>
          )}
        </div>
      </header>

      <div className="agents-page" style={{ maxWidth: 920 }}>
        <div className="setup-head">
          <h1>接入我的智能体</h1>
          <p>
            把本机 Claude Code、Codex、Gemini CLI 或 Grok、Muse、Ollama 智能体一键拉进端到端加密协作房间。
          </p>
        </div>

        <AgentJoinSection defaultRoomId={roomFromQuery} />

        {showPairedDevicesCard && (
          <div className="card setup-card" style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 16 }}>
              <Laptop size={17} strokeWidth={1.9} style={{ color: "var(--text-secondary)" }} />
              <span>已配对的电脑设备</span>
            </h2>
            <p className="setup-desc">管理已绑定当前账号的本机助手设备；吊销后对应电脑上的全部席位将自动下线。</p>
            <div className="setup-body" style={{ marginTop: 12 }}>
              {helperError && <p className="error-text">{helperError}</p>}
              {helpers?.map((h) => (
                <div key={h.id} className="agent-row">
                  <Laptop size={18} strokeWidth={1.8} style={{ color: "var(--text-primary)", flexShrink: 0 }} />
                  <div className="agent-row__info">
                    <strong>
                      <span>{h.device_name}</span>
                      <span className="agent-tag">{h.platform}</span>
                      {h.revoked && <span className="agent-tag agent-tag--warn">已吊销</span>}
                    </strong>
                    <small>
                      {h.last_seen_at
                        ? `最近在线 ${new Date(h.last_seen_at).toLocaleString("zh-CN")}`
                        : "从未在线"}
                      {` · 配对于 ${new Date(h.created_at).toLocaleDateString("zh-CN")}`}
                    </small>
                  </div>
                  {!h.revoked && (
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => void revoke(h)}>
                      吊销
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
