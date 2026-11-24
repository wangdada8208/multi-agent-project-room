import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "@xmtp/browser-sdk";
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Cpu,
  FolderGit2,
  Handshake,
  Info,
  Layers,
  Lock,
  MessageSquare,
  User,
  XCircle,
} from "lucide-react";
import {
  apiFetch,
  bindXmtpGroup,
  createRoom,
  createRoomFromTemplate,
  fetchTemplates,
} from "../lib/api";
import { TemplatePreview } from "../components/TemplatePreview";
import {
  TRUST_TIER_LABEL,
  trustTierOf,
  listRoomSeats,
  markSeatGroupAdded,
  type HubSeatView,
} from "../lib/localHelper";
import {
  hasEncryptedVault,
  inboxAddress,
  unlockOrCreateInboxKey,
  createLocalXmtpClient,
} from "../lib/xmtpLocalIdentity";
import { syncPendingSeatsToGroup } from "../lib/seatGroupSync";
import { CopyButton } from "../components/CopyButton";
import { AgentJoinSection } from "./AgentsPage";
import { useAuthStore } from "../stores/authStore";
import { useAnalytics } from "../hooks/useAnalytics";
import type { Room } from "../types/chat";

type SubState = "idle" | "running" | "done" | "failed";

function renderSetupTemplateIcon(key: string, name: string): ReactNode {
  const k = `${key} ${name}`.toLowerCase();
  if (k.includes("arch") || k.includes("code") || k.includes("dev") || k.includes("架构") || k.includes("研发") || k.includes("代码")) {
    return <Blocks size={17} strokeWidth={1.85} />;
  }
  if (k.includes("plan") || k.includes("task") || k.includes("review") || k.includes("评审") || k.includes("规划") || k.includes("需求")) {
    return <ClipboardList size={17} strokeWidth={1.85} />;
  }
  if (k.includes("negot") || k.includes("sync") || k.includes("partner") || k.includes("对齐") || k.includes("协同") || k.includes("谈判")) {
    return <Handshake size={17} strokeWidth={1.85} />;
  }
  if (k.includes("repo") || k.includes("git") || k.includes("仓库")) {
    return <FolderGit2 size={17} strokeWidth={1.85} />;
  }
  return <MessageSquare size={17} strokeWidth={1.85} />;
}

function CheckRow({ label, state }: { label: string; state: SubState }) {
  return (
    <div className={`check-row ${state === "done" ? "done" : state === "failed" ? "failed" : ""}`}>
      {state === "running" && <span className="spinner" />}
      {state === "done" && <CheckCircle2 size={16} strokeWidth={2} />}
      {state === "failed" && <XCircle size={16} strokeWidth={2} />}
      {state === "idle" && (
        <span style={{ width: 16, textAlign: "center", color: "var(--text-3)" }}>·</span>
      )}
      <span>{label}</span>
    </div>
  );
}

const STEP_LABELS = ["选场景", "建加密房间", "接入智能体", "完成"];

const GROUP_STATUS_LABEL: Record<HubSeatView["group_status"], string> = {
  pending: "等待入群",
  added: "已入群",
  removed: "已移除",
};

export function SetupPage() {
  const { roomId: routeRoomId } = useParams();
  const navigate = useNavigate();
  const { track } = useAnalytics();
  const user = useAuthStore((s) => s.user);

  const [step, setStep] = useState(0);
  const [room, setRoom] = useState<Room | null>(null);

  // ── Step 0: 建房 ──
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState("");
  const [blankName, setBlankName] = useState("");
  const [previewTplKey, setPreviewTplKey] = useState<string | null>(null);

  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: fetchTemplates });
  const templates = templatesQuery.data ?? [];

  // 带了 roomId 参数时直接跳到第二步
  const roomQuery = useQuery({
    queryKey: ["setup-room", routeRoomId],
    queryFn: async () => {
      const res = await apiFetch(`/api/v1/rooms/${routeRoomId}`);
      if (!res.ok) throw new Error("房间不存在或无权限");
      return (await res.json()).room as Room;
    },
    enabled: Boolean(routeRoomId),
    retry: false,
  });

  useEffect(() => {
    if (routeRoomId && roomQuery.data) {
      setRoom(roomQuery.data);
      setStep((s) => Math.max(s, 1));
    }
  }, [routeRoomId, roomQuery.data]);

  async function pickTemplate(key: string | null, name: string) {
    setCreating(key ?? "blank");
    setCreateError("");
    try {
      const created = key
        ? await createRoomFromTemplate(key, name)
        : await createRoom(name);
      track("room_create", created.id, { via: "setup_wizard" });
      setRoom(created);
      setStep(1);
    } catch {
      setCreateError("创建失败，请重试。");
    } finally {
      setCreating(null);
    }
  }

  // ── Step 1: 解锁身份 + 建群绑定 ──
  const [password, setPassword] = useState("");
  const creatingVault = !hasEncryptedVault();
  const [myAddress, setMyAddress] = useState("");
  const [groupId, setGroupId] = useState("");
  const [cryptoError, setCryptoError] = useState("");
  const [cryptoBusy, setCryptoBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; state: SubState }[]>([
    { label: "解锁本机加密身份", state: "idle" },
    { label: "创建端到端加密群", state: "idle" },
    { label: "绑定加密群到房间", state: "idle" },
  ]);

  const clientRef = useRef<Client<any> | null>(null);
  useEffect(
    () => () => {
      clientRef.current?.close();
      clientRef.current = null;
    },
    [],
  );

  const setStage = (index: number, state: SubState) =>
    setProgress((prev) => prev.map((p, i) => (i === index ? { ...p, state } : p)));

  async function configureEncryption() {
    if (!room || !password) return;
    setCryptoBusy(true);
    setCryptoError("");
    let client: Client<any> | null = null;
    try {
      setStage(0, "running");
      const key = await unlockOrCreateInboxKey(password);
      const address = inboxAddress(key);
      setMyAddress(address);
      client = await createLocalXmtpClient(key);
      setStage(0, "done");

      let boundGroupId = room.xmtp_group_id ?? "";
      if (!boundGroupId) {
        setStage(1, "running");
        const group = await client.conversations.createGroup([]);
        boundGroupId = group.id;
        setStage(1, "done");

        setStage(2, "running");
        await bindXmtpGroup(room.id, boundGroupId);
        setStage(2, "done");
        setRoom({ ...room, xmtp_group_id: boundGroupId });
      } else {
        setStage(1, "done");
        setStage(2, "done");
      }
      setGroupId(boundGroupId);
      clientRef.current = client;
      client = null;
      setStep(2);
    } catch (err) {
      setCryptoError(err instanceof Error ? err.message : "配置失败，请重试");
      setProgress((prev) => prev.map((p) => (p.state === "running" ? { ...p, state: "failed" } : p)));
    } finally {
      client?.close();
      setCryptoBusy(false);
    }
  }

  // ── Step 2: 接入 Agent ──
  const [joinedCount, setJoinedCount] = useState(0);

  // ── Step 3: 看席位状态 + 补拉入群 ──
  const [seats, setSeats] = useState<HubSeatView[]>([]);
  const [seatPollFailed, setSeatPollFailed] = useState(false);

  useEffect(() => {
    if (step !== 3 || !room) return;
    let cancelled = false;
    const roomId = room.id;
    const myId = user?.id;
    const tick = async () => {
      try {
        const list = await listRoomSeats(roomId);
        if (cancelled) return;
        setSeats(list.filter((s) => s.group_status !== "removed"));
        setSeatPollFailed(false);
        const client = clientRef.current;
        if (!client || !groupId || !myId) return;
        await syncPendingSeatsToGroup({
          client,
          roomId,
          groupId,
          currentUserId: myId,
          // 走配置向导建房的人就是房主：同时负责把受邀入群的云端席位拉进群。
          isRoomOwner: room.created_by === myId,
          deps: { listSeats: async () => list, markAdded: markSeatGroupAdded },
        });
      } catch {
        if (!cancelled) setSeatPollFailed(true);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [step, room, groupId, user?.id]);

  const myLiveSeats = seats.filter((s) => s.owner_user_id === user?.id);
  const allMineIn = myLiveSeats.length > 0 && myLiveSeats.every((s) => s.group_status === "added");

  const dot = (i: number) => `setup-step-dot ${i < step ? "done" : i === step ? "current" : ""}`;

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

      <div className="setup-page" style={{ maxWidth: step === 2 ? 920 : 720 }}>
        <div className="setup-head">
          <h1>一键创建加密协作房间</h1>
          <p>四步向导：选择场景 → 建加密房间 → 接入智能体 → 完成同步。</p>
        </div>

        <div className="setup-steps" role="list" aria-label="创建加密房间步骤">
          {STEP_LABELS.map((label, i) => (
            <div key={label} role="listitem" style={{ display: "flex", alignItems: "center" }}>
              {i > 0 && <div className={`setup-step-line ${i <= step ? "done" : ""}`} />}
              <div className="setup-step-item">
                <div className={dot(i)} aria-current={i === step ? "step" : undefined}>
                  {i < step ? <Check size={15} strokeWidth={2.4} /> : i + 1}
                </div>
                <span className={`setup-step-label ${i === step ? "current" : i < step ? "done" : ""}`}>
                  {label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {routeRoomId && roomQuery.isError && (
          <div className="page-error card">
            <p>房间不存在或没有访问权限。</p>
            <Link to="/setup" className="btn btn-ghost" style={{ marginTop: 12, display: "inline-flex" }}>
              重新开始配置向导
            </Link>
          </div>
        )}

        {/* ── Step 0 选场景 ── */}
        {!routeRoomId && step === 0 && (
          <div className="card setup-card">
            <h2>
              <Layers size={19} strokeWidth={1.9} style={{ color: "var(--accent)" }} />
              <span>选择房间协作场景</span>
            </h2>
            <p className="setup-desc">选择一个预设分工模板立即建房，或直接创建空白房间。</p>
            <div className="setup-body">
              {templatesQuery.isLoading && (
                <div className="loading-center">
                  <span className="spinner" />
                  <span>加载模板…</span>
                </div>
              )}
              <div className="tpl-grid">
                {templates.map((t) => (
                  <div key={t.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button
                      type="button"
                      className="tpl-card"
                      disabled={creating !== null}
                      onClick={() =>
                        void pickTemplate(t.key, `${t.name} · ${new Date().toLocaleDateString("zh-CN")}`)
                      }
                    >
                      <span className="tpl-icon" style={{ color: "var(--accent)" }}>
                        {renderSetupTemplateIcon(t.key, t.name)}
                      </span>
                      <strong>{creating === t.key ? "创建中…" : t.name}</strong>
                      <small>{t.description}</small>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ alignSelf: "flex-start", fontSize: 11, padding: "1px 8px" }}
                      onClick={() =>
                        setPreviewTplKey((prev) => (prev === t.key ? null : t.key))
                      }
                    >
                      {previewTplKey === t.key ? "收起预置内容" : "预览预置内容"}
                    </button>
                    {previewTplKey === t.key && <TemplatePreview template={t} />}
                  </div>
                ))}
              </div>
              <div className="field">
                <label>或者创建一个自定义房间</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input"
                    value={blankName}
                    onChange={(e) => setBlankName(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && blankName.trim() && void pickTemplate(null, blankName.trim())
                    }
                    placeholder="房间名称，例如：架构设计与代码评审"
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={creating !== null || !blankName.trim()}
                    onClick={() => void pickTemplate(null, blankName.trim())}
                  >
                    {creating === "blank" ? "创建中…" : "创建"}
                  </button>
                </div>
              </div>
              {createError && <p className="error-text">{createError}</p>}
            </div>
          </div>
        )}

        {/* ── Step 1 建加密房间 ── */}
        {step === 1 && room && (
          <div className="card setup-card">
            <h2>
              <Lock size={19} strokeWidth={1.9} style={{ color: "var(--accent)" }} />
              <span>{creatingVault ? "设置本机加密口令" : "解锁本机加密身份"}</span>
            </h2>
            <p className="setup-desc">
              房间 <strong>「{room.name}」</strong> 已就绪。
              {creatingVault
                ? "首次在这台浏览器使用，请设置至少 10 位本地口令，系统将在浏览器本地生成端到端加密密钥并创建加密群（无需安装数字钱包插件）。"
                : "输入你之前设置的本地加密口令，系统将自动创建端到端加密群并绑定到此房间。"}
            </p>
            <div className="setup-body">
              <div className="field">
                <label>本机加密口令</label>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void configureEncryption()}
                  placeholder={creatingVault ? "至少 10 位，仅保存在当前浏览器" : "输入本机加密口令"}
                  autoComplete={creatingVault ? "new-password" : "current-password"}
                  minLength={creatingVault ? 10 : undefined}
                  autoFocus
                />
                <p className="hint">口令与私钥仅保存在这台设备的浏览器本地存储中，平台服务器无法读取。</p>
              </div>
              {progress.some((p) => p.state !== "idle") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {progress.map((p) => (
                    <CheckRow key={p.label} label={p.label} state={p.state} />
                  ))}
                </div>
              )}
              {cryptoError && <p className="error-text">{cryptoError}</p>}
            </div>
            <div className="setup-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void configureEncryption()}
                disabled={cryptoBusy || !password || (creatingVault && password.length < 10)}
              >
                <span>{cryptoBusy ? "配置中…" : "自动配置端到端加密"}</span>
                {!cryptoBusy && <ArrowRight size={15} strokeWidth={2} />}
              </button>
              {!routeRoomId && (
                <button type="button" className="btn btn-ghost" onClick={() => setStep(0)}>
                  <ArrowLeft size={15} strokeWidth={2} />
                  <span>返回</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Step 2 接入智能体 ── */}
        {step === 2 && room && (
          <div className="card setup-card">
            <h2>
              <Cpu size={19} strokeWidth={1.9} style={{ color: "var(--accent)" }} />
              <span>接入你的智能体</span>
            </h2>
            <p className="setup-desc">
              端到端加密群已绑定。你可以邀请 Grok Bot、Muse 从云端加入，也可以接入电脑上的 Agent 或模型服务。
            </p>
            <div className="setup-body">
              {myAddress && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    flexWrap: "wrap",
                    padding: "8px 12px",
                    borderRadius: 10,
                    background: "var(--bg-subtle)",
                  }}
                >
                  <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    我的加密身份：<code style={{ color: "var(--text-primary)" }}>{myAddress}</code>
                  </span>
                  <CopyButton text={myAddress} label="复制地址" />
                </div>
              )}
              <AgentJoinSection
                roomId={room.id}
                roomName={room.name}
                ownerXmtpAddress={myAddress}
                onJoined={() => setJoinedCount((n) => n + 1)}
              />
            </div>
            <div className="setup-actions">
              <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>
                <span>{joinedCount > 0 ? "下一步 · 确认入群状态" : "暂不接入，直接下一步"}</span>
                <ArrowRight size={15} strokeWidth={2} />
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>
                <ArrowLeft size={15} strokeWidth={2} />
                <span>返回</span>
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3 席位状态与完成 ── */}
        {step === 3 && room && (
          <div className="card setup-card">
            <h2>
              {allMineIn ? (
                <CheckCircle2 size={19} strokeWidth={2} style={{ color: "var(--success)" }} />
              ) : (
                <Clock size={19} strokeWidth={1.9} style={{ color: "var(--accent)" }} />
              )}
              <span>{allMineIn ? "配置完成 · 席位已全部入群" : "正在同步席位入群状态"}</span>
            </h2>
            <p className="setup-desc">
              {allMineIn
                ? "你的智能体席位已自动拉入端到端加密群，现在可以进入房间 @智能体 开始协作。"
                : "每 4 秒自动刷新席位状态；新启动的席位在完成加密身份注册后会被自动拉进加密群（进入房间页后同样会自动完成）。"}
            </p>
            <div className="setup-body">
              {seats.length === 0 && !seatPollFailed && (
                <p className="hint">
                  当前房间暂无席位。你可以先进入房间，随时点右上角「接入 Agent」添加智能体。
                </p>
              )}
              {seatPollFailed && <p className="error-text">席位状态刷新失败，正在自动重试…</p>}
              {seats.map((seat) => {
                const tier = seat.trust_tier ?? trustTierOf(seat.kind);
                return (
                  <div key={seat.seat_id} className="agent-row">
                    <Cpu size={18} strokeWidth={1.8} style={{ color: "#1d1d1f", flexShrink: 0 }} />
                    <div className="agent-row__info">
                      <strong>
                        <span>{seat.agent_display_name}</span>
                        <span className={`trust-badge trust-badge--${tier} tier-badge tier-badge--${tier}`}>
                          {TRUST_TIER_LABEL[tier]}
                        </span>
                        <span
                          className={`task-badge ${
                            seat.group_status === "added"
                              ? "task-badge--completed"
                              : seat.group_status === "pending"
                                ? "task-badge--working"
                                : ""
                          }`}
                        >
                          {GROUP_STATUS_LABEL[seat.group_status]}
                        </span>
                      </strong>
                      <small>
                        {seat.xmtp_address.slice(0, 10)}…{seat.xmtp_address.slice(-4)}
                        {seat.owner_user_id !== user?.id ? " · 协作者的 Agent" : ""}
                      </small>
                    </div>
                  </div>
                );
              })}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "12px 14px",
                  borderRadius: 10,
                  background: "#f5f5f7",
                  fontSize: 13,
                  color: "#6e6e73",
                  lineHeight: 1.55,
                }}
              >
                <Info size={16} strokeWidth={1.9} style={{ color: "#0071e3", flexShrink: 0, marginTop: 2 }} />
                <span>
                  如需邀请同事带着自己的 Agent 一起进入此加密房间，进入房间后打开右侧「权限」面板，即可一键生成加密入群邀请链接。
                </span>
              </div>
            </div>
            <div className="setup-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => {
                  clientRef.current?.close();
                  clientRef.current = null;
                  navigate(`/rooms/${room.id}`);
                }}
              >
                <span>{allMineIn ? "进入协作房间" : "先进入协作房间"}</span>
                <ArrowRight size={17} strokeWidth={2} />
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>
                <ArrowLeft size={15} strokeWidth={2} />
                <span>返回继续接入</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
