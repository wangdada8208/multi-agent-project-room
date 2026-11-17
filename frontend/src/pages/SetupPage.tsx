import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "@xmtp/browser-sdk";
import {
  apiFetch, bindXmtpGroup, createRoom, createRoomFromTemplate, fetchTemplates,
} from "../lib/api";
import {
  buildMemberCommands, buildMemberEnv, getOrCreateWorkerCredentials, memberProcessAlive,
} from "../lib/setup";
import {
  hasEncryptedVault, inboxAddress, unlockOrCreateInboxKey, createLocalXmtpClient,
} from "../lib/xmtpLocalIdentity";
import { memberIdentifier } from "../lib/xmtpGroup";
import { useAuthStore } from "../stores/authStore";
import { useAnalytics } from "../hooks/useAnalytics";
import type { Room } from "../types/chat";

type SubState = "idle" | "running" | "done" | "failed";

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch { /* 剪贴板不可用时静默 */ }
      }}
    >
      {copied ? "✓ 已复制" : `📋 ${label}`}
    </button>
  );
}

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

export function SetupPage() {
  const { roomId: routeRoomId } = useParams();
  const navigate = useNavigate();
  const { track } = useAnalytics();
  const token = useAuthStore((s) => s.token);
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
  // 密钥按房间缓存在 sessionStorage，重跑向导不会换地址
  const credentials = useMemo(
    () => (room ? getOrCreateWorkerCredentials(room.id) : null),
    [room],
  );

  const [password, setPassword] = useState("");
  const creatingVault = !hasEncryptedVault();
  const [myAddress, setMyAddress] = useState("");
  const [groupId, setGroupId] = useState("");
  const [cryptoError, setCryptoError] = useState("");
  const [cryptoBusy, setCryptoBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; state: SubState }[]>([
    { label: "解锁本机加密身份", state: "idle" },
    { label: "创建加密群", state: "idle" },
    { label: "邀请成员进程入群", state: "idle" },
    { label: "绑定到房间", state: "idle" },
  ]);

  const setStage = (index: number, state: SubState) =>
    setProgress((prev) => prev.map((p, i) => (i === index ? { ...p, state } : p)));

  async function configureEncryption() {
    if (!room || !password || !credentials) return;
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
        await group.addMembersByIdentifiers([memberIdentifier(credentials.workerAddress)]);
        setStage(2, "done");

        setStage(3, "running");
        await bindXmtpGroup(room.id, boundGroupId);
        setStage(3, "done");
        setRoom({ ...room, xmtp_group_id: boundGroupId });
      } else {
        setStage(1, "done");
        // 群已绑定：尽量把本次生成的成员进程地址加进群
        setStage(2, "running");
        try {
          await client.conversations.syncAll();
          const group = await client.conversations.getConversationById(boundGroupId);
          await (group as any)?.addMembersByIdentifiers?.([memberIdentifier(credentials.workerAddress)]);
          setStage(2, "done");
        } catch {
          setStage(2, "done");
        }
        setStage(3, "done");
      }
      setGroupId(boundGroupId);
      setStep(2);
    } catch (err) {
      setCryptoError(err instanceof Error ? err.message : "配置失败，请重试");
      setProgress((prev) => prev.map((p) => (p.state === "running" ? { ...p, state: "failed" } : p)));
    } finally {
      client?.close();
      setCryptoBusy(false);
    }
  }

  // ── Step 2: 生成 .env 与命令 ──
  const [agentName, setAgentName] = useState("Claude");
  const hubBaseUrl = useMemo(() => {
    const base = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
    return base || window.location.origin;
  }, []);

  const envText = useMemo(() => {
    if (!room || !groupId || !myAddress || !token || !credentials) return "";
    return buildMemberEnv({
      agentName: agentName.trim() || "Claude",
      myAddress,
      roomId: room.id,
      groupId,
      hubBaseUrl,
      hubToken: token,
      credentials,
    });
  }, [room, groupId, myAddress, token, agentName, credentials]);

  const commandText = useMemo(
    () => [
      "# 1. 获取代码（已有代码可跳过）",
      "git clone https://github.com/wangdada8208/multi-agent-project-room.git",
      "",
      "# 2. 进入成员进程目录并安装依赖（需要 Node.js 22+）",
      ...buildMemberCommands(),
      "",
      "# 说明：先把上面下载的 .env 文件放进 workers/xmtp-member/ 目录，",
      "#       并在 MEMBER_MODEL_API_KEY= 后填上你的模型密钥。",
    ].join("\n"),
    []
  );

  function downloadEnv() {
    const blob = new Blob([envText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ".env";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Step 3: 检测成员进程 ──
  const [memberOnline, setMemberOnline] = useState(false);
  useEffect(() => {
    if (step !== 3 || memberOnline) return;
    let cancelled = false;
    const tick = async () => {
      if (await memberProcessAlive()) {
        if (!cancelled) setMemberOnline(true);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [step, memberOnline]);

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
          <p>三步完成：建房间 → 加密配置 → 拿到接入命令。</p>
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
                ? "这台电脑还没有加密身份，设置一个口令（至少 10 位），系统会自动创建加密群并邀请你的成员进程。"
                : "输入你的加密口令，系统会自动创建加密群并邀请你的成员进程。"}
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
              加密群已就绪。下面这个配置文件让 Agent 在你自己的电脑上运行——密钥不出本机。
            </p>
            <div className="setup-body">
              {myAddress && (
                <div className="field">
                  <label>我的加密地址（对方配置时需填进 TA 的白名单）</label>
                  <span className="addr-pill" onClick={() => navigator.clipboard.writeText(myAddress).catch(() => {})} title="点击复制">
                    {myAddress} 📋
                  </span>
                </div>
              )}
              <div className="field">
                <label>Agent 名称（群里的显示名）</label>
                <input
                  className="input"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="Claude"
                />
              </div>
              <div className="field">
                <label>第 1 步 · 下载配置文件 .env</label>
                <div className="code-block">
                  <CopyButton text={envText} label="复制内容" />
                  {envText}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={downloadEnv}>
                    ⬇ 下载 .env
                  </button>
                </div>
              </div>
              <div className="field">
                <label>第 2 步 · 在你的电脑上运行（需要 Node.js 22+）</label>
                <div className="code-block">
                  <CopyButton text={commandText} label="复制命令" />
                  {commandText}
                </div>
              </div>
              <div className="setup-note">
                ⚠️ .env 里有密钥，别发给任何人、别提交到 git。MEMBER_MODEL_API_KEY 需要你自己填一个模型服务的密钥。
              </div>
            </div>
            <div className="setup-actions">
              <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>
                我已启动成员进程 →
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>← 返回</button>
            </div>
          </div>
        )}

        {/* ── Step 3 检测与完成 ── */}
        {step === 3 && room && (
          <div className="card setup-card">
            <h2>{memberOnline ? "🎉 配置完成" : "⏳ 等待成员进程启动"}</h2>
            <p className="setup-desc">
              {memberOnline
                ? "已经检测到你电脑上的成员进程在运行。"
                : "正在检测本机成员进程（127.0.0.1:8787）。在你的终端里完成上一步命令后，这里会自动变绿。"}
            </p>
            <div className="setup-body">
              <CheckRow
                label={memberOnline ? "成员进程已连接" : "等待成员进程启动…"}
                state={memberOnline ? "done" : "running"}
              />
              <div className="setup-info">
                💡 对方的 Agent 也要接入时，把房间 ID <code>{room.id}</code> 发给 TA，
                让 TA 在自己的电脑上走一遍这个向导即可。记得互相把「我的加密地址」加进白名单。
              </div>
            </div>
            <div className="setup-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => navigate(`/rooms/${room.id}`)}
              >
                {memberOnline ? "进入房间 🚀" : "先进入房间看看 →"}
              </button>
              <Link to="/" className="hint setup-skip">回首页</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
