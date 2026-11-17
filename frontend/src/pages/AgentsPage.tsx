import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiUrl, fetchRooms } from "../lib/api";
import {
  createJoinTicket,
  createPairingCode,
  joinViaTicket,
  listLocalAgents,
  listLocalSeats,
  listMyHelpers,
  openHelperPage,
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

const KIND_ICON: Record<AgentKind, string> = {
  "claude-code": "🟣",
  codex: "🟦",
  "gemini-cli": "🔷",
  "openai-compatible": "☁️",
  webhook: "🔗",
  "http-model": "🧠",
};

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
  crashed: "已崩溃",
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

function loginHint(agent: LocalAgentView): string | null {
  if (agent.loginState === "needs-login") return "可能需要先在本机登录";
  return null;
}

/** 配对码与安装命令（Hub 下发，10 分钟有效）。 */
function InstallPanel({
  pairing,
  pairingError,
  onGenerate,
}: {
  pairing: { code: string; install_command: string; expires_at: string } | null;
  pairingError: string;
  onGenerate: () => void;
}) {
  return (
    <div className="agent-panel">
      <p className="agent-panel__title">第一步 · 在这台电脑上安装本机助手</p>
      <p className="hint">
        你的 Agent 跑在你自己的电脑上，密钥不出本机。把下面这条命令粘进终端运行一次即可，之后开机自动启动。
      </p>
      <HelperIntroDemo />
      {pairing ? (
        <>
          <div className="code-block">
            <CopyButton text={pairing.install_command} label="复制命令" />
            {pairing.install_command}
          </div>
          <p className="hint">命令里已带配对码（{new Date(pairing.expires_at).toLocaleTimeString("zh-CN")} 前有效）。</p>
        </>
      ) : pairingError ? (
        <p className="error-text">{pairingError}</p>
      ) : (
        <p className="hint">正在生成安装命令…</p>
      )}
      <div className="agent-panel__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onGenerate}>
          {pairing ? "重新生成命令" : "生成安装命令"}
        </button>
        <span className="hint">安装完成后此页会自动检测到，无需刷新。</span>
      </div>
    </div>
  );
}

export interface AgentJoinSectionProps {
  /** 固定房间（向导场景）：隐藏房间选择，直接加入这个房间。 */
  roomId?: string;
  roomName?: string;
  /** 已解锁的本机加密地址；没传时加入流程会内联要求解锁。 */
  ownerXmtpAddress?: string;
  /** 加入成功后的回调（例如向导推进到下一步）。 */
  onJoined?: (seat: SeatViewLocal) => void;
}

/**
 * 「接入 Agent」主流程：探测本机助手 → 安装 / 解除拦截 / 列出 Agent → 选房间加入。
 * AgentsPage 与一键配置向导第 3 步共用。
 */
export function AgentJoinSection({ roomId, roomName, ownerXmtpAddress, onJoined }: AgentJoinSectionProps) {
  const user = useAuthStore((s) => s.user);

  const [probe, setProbe] = useState<HelperProbe | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; install_command: string; expires_at: string } | null>(null);
  const [pairingError, setPairingError] = useState("");
  const pairingFetched = useRef(false);

  const [agents, setAgents] = useState<LocalAgentView[]>([]);
  const [seats, setSeats] = useState<SeatViewLocal[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [helpers, setHelpers] = useState<HelperDevice[]>([]);
  const [helperPick, setHelperPick] = useState("");
  const [roomPick, setRoomPick] = useState(roomId ?? "");

  const [unlockedAddress, setUnlockedAddress] = useState("");
  const [pendingJoin, setPendingJoin] = useState<{ agentKey: string; roomId: string } | null>(null);
  const [joiningKey, setJoiningKey] = useState<string | null>(null);
  const [joinError, setJoinError] = useState("");
  const [joinedSeat, setJoinedSeat] = useState<SeatViewLocal | null>(null);
  const [listError, setListError] = useState("");

  const hubOrigin = useMemo(() => apiUrl("").replace(/\/$/, "") || window.location.origin, []);

  // ── 探测循环：未 running 时每 3 秒重试；running 时每 5 秒刷新列表 ──
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

  // running 后拉设备列表与房间列表（加入流程要用 helperId；无固定房间时要房间选择器）
  useEffect(() => {
    if (probe?.state !== "running" || !probe.hello.paired) return;
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
    if (!roomId) {
      fetchRooms()
        .then((list) => {
          if (cancelled) return;
          setRooms(list);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [probe, roomId]);

  // 三处需要配对码：未运行（安装命令）、手动展开安装面板、助手在跑但未配对
  const needInstall = probe?.state === "not-running" || showInstall;
  const needPairingCode =
    needInstall || (probe?.state === "running" && !probe.hello.paired);
  useEffect(() => {
    if (!needPairingCode || pairingFetched.current) return;
    pairingFetched.current = true;
    createPairingCode()
      .then(setPairing)
      .catch((err) => setPairingError(err instanceof Error ? err.message : "生成配对码失败"));
  }, [needPairingCode]);

  function regeneratePairing() {
    pairingFetched.current = false;
    setPairing(null);
    setPairingError("");
    createPairingCode()
      .then((p) => {
        pairingFetched.current = true;
        setPairing(p);
      })
      .catch((err) => {
        setPairingError(err instanceof Error ? err.message : "生成配对码失败");
      });
  }

  // ── 加入流程（5.2）：解锁地址 → Hub 发票据 → 本机助手入座；被拦则跳转交接 ──
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
        setJoinError("本机助手没有绑定到你的账号。请打开本机页面完成配对后再加入。");
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
          // 浏览器拦住了请求：票据已发，交给本机页面继续完成加入。
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
    const target = roomId ?? roomPick;
    if (!target) {
      setJoinError("请先选择要加入的房间。");
      return;
    }
    setJoinError("");
    setJoinedSeat(null);
    if (myAddress) {
      void runJoin(agentKey, target, myAddress);
    } else {
      // 票据里要带主人的加密地址；未解锁身份时先解锁。
      setPendingJoin({ agentKey, roomId: target });
    }
  }

  async function leaveSeat(seat: SeatViewLocal) {
    try {
      await removeRoomSeat(seat.roomId, seat.seatId);
      await refreshLocal();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "移除席位失败");
    }
  }

  // ── 渲染 ──

  if (probe === null) {
    return (
      <div className="loading-center">
        <span className="spinner" />正在检测这台电脑上的本机助手…
      </div>
    );
  }

  if (probe.state !== "running") {
    // not-running 一定进安装面板；blocked 时用户可手动展开安装面板
    if (needInstall) {
      return (
        <div className="agent-panel-stack">
          {probe.state === "blocked" && (
            <div className="setup-info">浏览器可能拦住了对本机助手的访问。如果已经装过，先点下面的「打开本机助手」。</div>
          )}
          <InstallPanel pairing={pairing} pairingError={pairingError} onGenerate={regeneratePairing} />
          <div className="agent-panel__actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => openHelperPage()}>
              打开本机助手 ↗
            </button>
            {probe.state === "blocked" && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowInstall(false)}>
                返回检测
              </button>
            )}
          </div>
        </div>
      );
    }
    // probe.state === "blocked" 且未展开安装面板
    return (
      <div className="agent-panel">
        <p className="agent-panel__title">浏览器拦住了对本机助手的访问</p>
        <p className="hint">
          网页直接调用本机助手需要浏览器允许「本地网络访问」。如果被拦，可以跳到本机页面完成同样的操作。
        </p>
        <HelperIntroDemo />
        <div className="agent-panel__actions">
          <button type="button" className="btn btn-primary" onClick={() => openHelperPage()}>
            打开本机助手 ↗
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowInstall(true)}>
            电脑上还没装？查看安装方法
          </button>
        </div>
      </div>
    );
  }

  // running
  const hello = probe.hello;
  return (
    <div className="agent-panel-stack">
      {!hello.paired ? (
        <UnpairedPanel pairing={pairing} pairingError={pairingError} onGenerate={regeneratePairing} />
      ) : (
        <>
          {hello.hub_origin && hello.hub_origin !== hubOrigin && (
            <div className="setup-note">
              本机助手配对的是 {hello.hub_origin}，与当前网站（{hubOrigin}）不一致，加入会写到另一边。
            </div>
          )}
          {pendingJoin && (
            <div>
              <XmtpUnlock
                onUnlock={(key) => {
                  const address = inboxAddress(key);
                  setUnlockedAddress(address);
                  const pending = pendingJoin;
                  setPendingJoin(null);
                  void runJoin(pending.agentKey, pending.roomId, address);
                }}
              />
              <div className="agent-panel__actions" style={{ justifyContent: "center" }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPendingJoin(null)}>
                  取消
                </button>
              </div>
            </div>
          )}

          <div className="agent-panel">
            <p className="agent-panel__title">这台电脑上的 Agent</p>
            {!roomId && (
              <div className="field">
                <label>加入哪个房间</label>
                <select
                  className="input"
                  value={roomPick}
                  onChange={(e) => setRoomPick(e.target.value)}
                >
                  <option value="">选择房间…</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {roomId && roomName && <p className="hint">加入房间：「{roomName}」</p>}
            {helpers.length > 1 && (
              <div className="field">
                <label>通过哪台电脑加入</label>
                <select className="input" value={helperPick} onChange={(e) => setHelperPick(e.target.value)}>
                  {helpers.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.device_name}（{h.platform}
                      {h.last_seen_at ? `，最近在线 ${new Date(h.last_seen_at).toLocaleString("zh-CN")}` : ""}）
                    </option>
                  ))}
                </select>
              </div>
            )}
            {agents.length === 0 && (
              <p className="hint">
                没有探测到可用的 Agent。安装 Claude Code / Codex / Gemini CLI，或
                <button type="button" className="agent-link" onClick={() => openHelperPage()}>
                  打开本机页面
                </button>
                添加云端 Agent。
              </p>
            )}
            <div className="agent-list">
              {agents.map((agent) => (
                <div key={agent.key} className="agent-row">
                  <span className="agent-row__icon">{KIND_ICON[agent.kind] ?? "🤖"}</span>
                  <div className="agent-row__info">
                    <strong>
                      {agent.displayName}
                      <span className="agent-tag">{KIND_LABEL[agent.kind] ?? agent.kind}</span>
                      {agent.source === "manual" && <span className="agent-tag">手动添加</span>}
                      {loginHint(agent) && <span className="agent-tag agent-tag--warn">{loginHint(agent)}</span>}
                    </strong>
                    <small>
                      {agent.version ? `${agent.version} · ` : ""}
                      {agent.key}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={joiningKey !== null || (!roomId && !roomPick)}
                    onClick={() => startJoin(agent.key)}
                  >
                    {joiningKey === agent.key ? "加入中…" : "加入"}
                  </button>
                </div>
              ))}
            </div>
            {joinError && <p className="error-text">{joinError}</p>}
            {joinedSeat && (
              <p className="ok-text">
                ✓ 已创建席位，加入加密群的动作在房间页自动完成。
                <Link to={`/rooms/${joinedSeat.roomId}`}>去房间页 →</Link>
              </p>
            )}
          </div>

          {seats.length > 0 && (
            <div className="agent-panel">
              <p className="agent-panel__title">运行中的席位</p>
              <div className="agent-list">
                {seats.map((seat) => (
                  <div key={seat.seatId} className="agent-row">
                    <span className="agent-row__icon">💺</span>
                    <div className="agent-row__info">
                      <strong>
                        {seat.agentKey} · {seat.roomName}
                        <span className={`task-badge ${SEAT_STATUS_CLASS[seat.status]}`}>
                          {SEAT_STATUS_LABEL[seat.status]}
                        </span>
                        {(() => {
                          const kind = agents.find((a) => a.key === seat.agentKey)?.kind;
                          const tier = kind ? trustTierOf(kind) : "custom-webhook";
                          return (
                            <span className={`tier-badge tier-badge--${tier}`}>
                              {TRUST_TIER_LABEL[tier]}
                            </span>
                          );
                        })()}
                      </strong>
                      <small>
                        {seat.xmtpAddress.slice(0, 10)}…{seat.xmtpAddress.slice(-4)}
                        {seat.lastError ? ` · ${seat.lastError}` : ""}
                      </small>
                    </div>
                    <a
                      className="btn btn-ghost btn-sm"
                      href={`http://127.0.0.1:${seat.consolePort}/`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      控制台 ↗
                    </a>
                    {(seat.status === "running" || seat.status === "starting" || seat.status === "crashed") && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => void leaveSeat(seat)}
                      >
                        退出房间
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <p className="hint">「退出房间」会把席位移出房间，本机助手随后停止对应进程。</p>
            </div>
          )}
          {listError && <p className="error-text">{listError}</p>}
        </>
      )}
      {!myAddress && !pendingJoin && hello.paired && (
        <p className="hint">加入时会要求输入你的加密口令，用来在票据里登记你的加密地址。</p>
      )}
      {user && hello.paired && hello.owner_display_name && hello.owner_display_name !== user.display_name && (
        <p className="hint">本机助手配对显示的名字是「{hello.owner_display_name}」。</p>
      )}
    </div>
  );
}

/** running && !paired：网页不能替用户配对，给码 + 交接跳转。 */
function UnpairedPanel({
  pairing,
  pairingError,
  onGenerate,
}: {
  pairing: { code: string; install_command: string; expires_at: string } | null;
  pairingError: string;
  onGenerate: () => void;
}) {
  return (
    <div className="agent-panel">
      <p className="agent-panel__title">本机助手在运行，但还没和你的账号配对</p>
      <p className="hint">打开本机页面，把这个配对码填进去即可完成绑定（10 分钟内有效）。</p>
      {pairing ? (
        <div className="pair-code-row">
          <code className="pair-code">{pairing.code}</code>
          <CopyButton text={pairing.code} label="复制配对码" />
        </div>
      ) : pairingError ? (
        <p className="error-text">{pairingError}</p>
      ) : (
        <p className="hint">正在生成配对码…</p>
      )}
      <div className="agent-panel__actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!pairing}
          onClick={() => pairing && openHelperPage({ pair: pairing.code })}
        >
          打开本机页面完成配对 ↗
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onGenerate}>
          重新生成
        </button>
      </div>
    </div>
  );
}

// ── /agents 页面 ──

export function AgentsPage() {
  const user = useAuthStore((s) => s.user);
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
    if (!window.confirm(`吊销「${device.device_name}」？它在 Hub 侧的席位会一并移除，本机助手下次心跳后停止。`)) {
      return;
    }
    try {
      await revokeHelper(device.id);
      loadHelpers();
    } catch (err) {
      setHelperError(err instanceof Error ? err.message : "吊销失败，请重试");
    }
  }

  return (
    <div>
      <header className="topbar">
        <Link to="/" className="topbar__brand">🤖 协作空间</Link>
        <span className="topbar__spacer" />
        <span className="topbar__user">{user?.display_name}</span>
      </header>

      <div className="agents-page">
        <div className="setup-head">
          <h1>我的 Agent</h1>
          <p>把你电脑上的 Agent 接进加密房间。第一次需要先装一次本机助手，之后每个 Agent 都是一键加入。</p>
        </div>

        <div className="card setup-card">
          <h2>⚡ 接入 Agent</h2>
          <div className="setup-body" style={{ marginTop: 12 }}>
            <AgentJoinSection />
          </div>
        </div>

        <div className="card setup-card" style={{ marginTop: 16 }}>
          <h2>💻 我的电脑</h2>
          <p className="setup-desc">配对过的本机助手。吊销后它会停止全部席位并退出。</p>
          <div className="setup-body" style={{ marginTop: 12 }}>
            {helpers === null && !helperError && (
              <div className="loading-center"><span className="spinner" />加载中…</div>
            )}
            {helperError && <p className="error-text">{helperError}</p>}
            {helpers !== null && helpers.length === 0 && (
              <p className="hint">还没有配对过电脑。装一次本机助手后这里会显示。</p>
            )}
            {helpers?.map((h) => (
              <div key={h.id} className="agent-row">
                <span className="agent-row__icon">💻</span>
                <div className="agent-row__info">
                  <strong>
                    {h.device_name}
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
      </div>
    </div>
  );
}
