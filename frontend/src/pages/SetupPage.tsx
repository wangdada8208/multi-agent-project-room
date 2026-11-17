import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "@xmtp/browser-sdk";
import {
  apiFetch, bindXmtpGroup, createRoom, createRoomFromTemplate, fetchTemplates,
} from "../lib/api";
import {
  listRoomSeats, markSeatGroupAdded, type HubSeatView,
} from "../lib/localHelper";
import {
  hasEncryptedVault, inboxAddress, unlockOrCreateInboxKey, createLocalXmtpClient,
} from "../lib/xmtpLocalIdentity";
import { syncPendingSeatsToGroup } from "../lib/seatGroupSync";
import { AgentJoinSection } from "./AgentsPage";
import { useAuthStore } from "../stores/authStore";
import { useAnalytics } from "../hooks/useAnalytics";
import type { Room } from "../types/chat";

type SubState = "idle" | "running" | "done" | "failed";

function CheckRow({ label, state }: { label: string; state: SubState }) {
  return (
    <div className={`check-row ${state === "done" ? "done" : state === "failed" ? "failed" : ""}`}>
      {state === "running" && <span className="spinner" />}
      {state === "done" && <span>✅</span>}
      {state === "failed" && <span>❌</span>}
      {state === "idle" && <span style={{ width: 16, textAlign: "center", color: "var(--text-3)" }}>·</span>}
      <span>{label}</span>
    </div>
  );
}

const STEP_LABELS = ["选场景", "加密配置", "接入 Agent", "完成"];

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
    { label: "创建加密群", state: "idle" },
    { label: "绑定到房间", state: "idle" },
  ]);

  // 客户端跨步骤保留：新席位的加密身份要等其进程首次启动后才注册到网络，
  // 拉进群只能在注册之后发出（在「完成」步轮询补拉）。
  const clientRef = useRef<Client<any> | null>(null);
  useEffect(() => () => {
    clientRef.current?.close();
    clientRef.current = null;
  }, []);

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

  // ── Step 2: 接入 Agent（本机助手 + 一次性票据，见 AgentJoinSection） ──
  const [joinedCount, setJoinedCount] = useState(0);

  // ── Step 3: 看席位状态 + 补拉入群 ──
  const [seats, setSeats] = useState<HubSeatView[]>([]);
  const [seatPollFailed, setSeatPollFailed] = useState(false);

  // 新席位的 XMTP 身份在其进程首次启动后才注册到网络；可解析后才拉进群。
  // 只拉 owner 是自己且 pending 的席位，不替别人拉（方案 5.4）。
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
          // 席位列表刚拉过，直接喂给同步逻辑，省一次请求。
          deps: { listSeats: async () => list, markAdded: markSeatGroupAdded },
        });
      } catch {
        if (!cancelled) setSeatPollFailed(true);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [step, room, groupId, user?.id]);

  const myLiveSeats = seats.filter((s) => s.owner_user_id === user?.id);
  const allMineIn = myLiveSeats.length > 0 && myLiveSeats.every((s) => s.group_status === "added");

  const dot = (i: number) =>
    `setup-step-dot ${i < step ? "done" : i === step ? "current" : ""}`;

  return (
    <div>
      <header className="topbar">
        <Link to="/" className="topbar__brand">🤖 协作空间</Link>
        <span className="topbar__spacer" />
        <span className="topbar__user">{user?.display_name}</span>
      </header>

      <div className="setup-page">
        <div className="setup-head">
          <h1>一键配置</h1>
          <p>三步完成：建房间 → 加密配置 → 接入 Agent。</p>
        </div>

        <div className="setup-steps">
          {STEP_LABELS.map((label, i) => (
            <div key={label} style={{ display: "flex", alignItems: "center" }}>
              {i > 0 && <div className={`setup-step-line ${i <= step ? "done" : ""}`} />}
              <div className={dot(i)} title={label}>
                {i < step ? "✓" : i + 1}
              </div>
            </div>
          ))}
        </div>

        {routeRoomId && roomQuery.isError && (
          <div className="page-error card">
            <p>房间不存在或没有访问权限。</p>
            <Link to="/setup" className="btn btn-ghost" style={{ marginTop: 12, display: "inline-flex" }}>
              重新走一遍向导
            </Link>
          </div>
        )}

        {/* ── Step 0 选场景 ── */}
        {!routeRoomId && step === 0 && (
          <div className="card setup-card">
            <h2>🏠 你想让 Agent 们做什么？</h2>
            <p className="setup-desc">选一个场景模板，房间会立刻建好并带好人设分工。</p>
            <div className="setup-body">
              {templatesQuery.isLoading && (
                <div className="loading-center"><span className="spinner" />加载场景...</div>
              )}
              <div className="tpl-grid">
                {templates.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className="tpl-card"
                    disabled={creating !== null}
                    onClick={() =>
                      pickTemplate(t.key, `${t.name} - ${new Date().toLocaleDateString("zh-CN")}`)}
                  >
                    <span className="tpl-icon">{t.icon}</span>
                    <strong>{creating === t.key ? "创建中..." : t.name}</strong>
                    <small>{t.description}</small>
                  </button>
                ))}
              </div>
              <div className="field">
                <label>或者建一个空白房间</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input"
                    value={blankName}
                    onChange={(e) => setBlankName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && blankName.trim() && pickTemplate(null, blankName.trim())}
                    placeholder="房间名称，例如：和邻居的 Agent 讨论周报"
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={creating !== null || !blankName.trim()}
                    onClick={() => pickTemplate(null, blankName.trim())}
                  >
                    {creating === "blank" ? "创建中..." : "创建"}
                  </button>
                </div>
              </div>
              {createError && <p className="error-text">{createError}</p>}
            </div>
          </div>
        )}

        {/* ── Step 1 加密配置 ── */}
        {step === 1 && room && (
          <div className="card setup-card">
            <h2>🔐 {creatingVault ? "设置加密口令" : "解锁加密身份"}</h2>
            <p className="setup-desc">
              房间 <strong>「{room.name}」</strong> 已建好。
              {creatingVault
                ? "这台电脑还没有加密身份，设置一个口令（至少 10 位），系统会自动创建加密群并绑定到房间。"
                : "输入你的加密口令，系统会自动创建加密群并绑定到房间。"}
            </p>
            <div className="setup-body">
              <div className="field">
                <label>加密口令</label>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && configureEncryption()}
                  placeholder={creatingVault ? "至少 10 位，忘记后无法找回" : "输入之前设置的口令"}
                  autoComplete={creatingVault ? "new-password" : "current-password"}
                  minLength={creatingVault ? 10 : undefined}
                  autoFocus
                />
                <p className="hint">口令和密钥只保存在这台电脑上，服务器看不到。</p>
              </div>
              {progress.some((p) => p.state !== "idle") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {progress.map((p) => <CheckRow key={p.label} label={p.label} state={p.state} />)}
                </div>
              )}
              {cryptoError && <p className="error-text">{cryptoError}</p>}
            </div>
            <div className="setup-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={configureEncryption}
                disabled={cryptoBusy || !password || (creatingVault && password.length < 10)}
              >
                {cryptoBusy ? "配置中..." : "自动配置加密 →"}
              </button>
              {!routeRoomId && (
                <button type="button" className="btn btn-ghost" onClick={() => setStep(0)}>← 返回</button>
              )}
            </div>
          </div>
        )}

        {/* ── Step 2 接入 Agent ── */}
        {step === 2 && room && (
          <div className="card setup-card">
            <h2>🤖 接入你的 Agent</h2>
            <p className="setup-desc">
              加密群已就绪。Agent 跑在你自己的电脑上——密钥不出本机，点一下「加入」即可。
            </p>
            <div className="setup-body">
              {myAddress && (
                <div className="field">
                  <label>我的加密地址</label>
                  <span className="addr-pill" onClick={() => navigator.clipboard.writeText(myAddress).catch(() => {})} title="点击复制">
                    {myAddress} 📋
                  </span>
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
                {joinedCount > 0 ? "下一步 →" : "先不接入，下一步 →"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>← 返回</button>
            </div>
          </div>
        )}

        {/* ── Step 3 席位状态与完成 ── */}
        {step === 3 && room && (
          <div className="card setup-card">
            <h2>{allMineIn ? "🎉 配置完成" : "⏳ 席位状态"}</h2>
            <p className="setup-desc">
              {allMineIn
                ? "你的 Agent 已创建席位并加入加密群，协作空间就绪。"
                : "这里每 4 秒刷新一次席位状态。新席位要等它的进程首次启动、加密身份注册后才会被自动拉进群。"}
            </p>
            <div className="setup-body">
              {seats.length === 0 && !seatPollFailed && (
                <p className="hint">
                  这个房间还没有席位。回到上一步接入 Agent，或之后在「我的 Agent」页随时接入。
                </p>
              )}
              {seatPollFailed && <p className="error-text">席位状态刷新失败，正在重试…</p>}
              {seats.map((seat) => (
                <div key={seat.seat_id} className="agent-row">
                  <span className="agent-row__icon">🤖</span>
                  <div className="agent-row__info">
                    <strong>
                      {seat.agent_display_name}
                      <span className={`task-badge ${seat.group_status === "added" ? "task-badge--completed" : seat.group_status === "pending" ? "task-badge--working" : ""}`}>
                        {GROUP_STATUS_LABEL[seat.group_status]}
                      </span>
                    </strong>
                    <small>
                      {seat.xmtp_address.slice(0, 10)}…{seat.xmtp_address.slice(-4)}
                      {seat.owner_user_id !== user?.id ? " · 他人的 Agent" : ""}
                    </small>
                  </div>
                </div>
              ))}
              <div className="setup-info">
                💡 对方的 Agent 也要接入时，把房间 ID <code>{room.id}</code> 发给 TA，
                让 TA 在自己的电脑上走一遍这个向导即可。
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
                {allMineIn ? "进入房间 🚀" : "先进入房间看看 →"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>← 返回接入</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
