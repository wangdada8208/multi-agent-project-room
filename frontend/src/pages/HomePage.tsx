import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Blocks,
  ClipboardList,
  Cpu,
  FolderGit2,
  Handshake,
  KeyRound,
  Layers,
  Lock,
  LogOut,
  MessageSquare,
  Plus,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  apiFetch,
  createRoom,
  createRoomFromTemplate,
  fetchRooms,
  fetchTemplates,
  type RoomTemplateInfo,
} from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { useAnalytics } from "../hooks/useAnalytics";
import type { Room } from "../types/chat";

function renderTemplateIcon(tpl: RoomTemplateInfo): ReactNode {
  const key = `${tpl.key} ${tpl.name}`.toLowerCase();
  if (key.includes("arch") || key.includes("code") || key.includes("dev") || key.includes("开发") || key.includes("架构")) {
    return <Blocks size={17} strokeWidth={1.8} />;
  }
  if (key.includes("plan") || key.includes("task") || key.includes("review") || key.includes("评审") || key.includes("任务")) {
    return <ClipboardList size={17} strokeWidth={1.8} />;
  }
  if (key.includes("negot") || key.includes("sync") || key.includes("partner") || key.includes("对齐") || key.includes("联调") || key.includes("协商")) {
    return <Handshake size={17} strokeWidth={1.8} />;
  }
  if (key.includes("repo") || key.includes("git") || key.includes("仓库")) {
    return <FolderGit2 size={17} strokeWidth={1.8} />;
  }
  return <MessageSquare size={17} strokeWidth={1.8} />;
}

export function HomePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { track } = useAnalytics();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  const [joinId, setJoinId] = useState("");
  const [actionError, setActionError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 新建房间弹窗状态
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTplKey, setSelectedTplKey] = useState<string | null>(null);
  const [roomName, setRoomName] = useState("");
  const [roomDesc, setRoomDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const roomsQuery = useQuery({
    queryKey: ["rooms"],
    queryFn: fetchRooms,
    refetchInterval: 15000,
  });
  const rooms: Room[] = roomsQuery.data ?? [];

  const templatesQuery = useQuery({
    queryKey: ["templates"],
    queryFn: fetchTemplates,
    enabled: createOpen,
  });
  const templates = templatesQuery.data ?? [];

  useEffect(() => {
    if (!createOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !creating) {
        setCreateOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createOpen, creating]);

  function openCreateModal() {
    setSelectedTplKey(null);
    setRoomName("");
    setRoomDesc("");
    setCreateError("");
    setCreateOpen(true);
  }

  function selectTemplate(tpl: RoomTemplateInfo | null) {
    if (!tpl) {
      setSelectedTplKey(null);
      return;
    }
    setSelectedTplKey(tpl.key);
    if (!roomName.trim()) {
      setRoomName(`${tpl.name} · ${new Date().toLocaleDateString("zh-CN")}`);
    }
    if (!roomDesc.trim() && tpl.description) {
      setRoomDesc(tpl.description);
    }
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = roomName.trim();
    if (!trimmedName) {
      setCreateError("请输入房间名称。");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      const created = selectedTplKey
        ? await createRoomFromTemplate(selectedTplKey, trimmedName)
        : await createRoom(trimmedName, roomDesc.trim() || undefined);
      track("room_create", created.id, { via: selectedTplKey ? "home_template_modal" : "home_blank_modal" });
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      setCreateOpen(false);
      navigate(`/setup/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "创建房间失败，请重试。");
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteRoom(e: React.MouseEvent, room: Room) {
    e.stopPropagation();
    if (!window.confirm(`确定删除房间「${room.name}」吗？删除后将停用该房间的入口。`)) {
      return;
    }
    setActionError("");
    setDeletingId(room.id);
    try {
      const res = await apiFetch(`/api/v1/rooms/${room.id}`, { method: "DELETE" });
      if (res.status === 403) {
        setActionError("只有房主可以删除房间。");
        return;
      }
      if (!res.ok) {
        setActionError("删除房间失败，请稍后重试。");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
    } catch {
      setActionError("网络异常，删除房间失败。");
    } finally {
      setDeletingId(null);
    }
  }

  function handleJoin() {
    const trimmed = joinId.trim();
    if (!trimmed) return;
    const matched = rooms.find(
      (r) => r.id === trimmed || r.name.toLowerCase() === trimmed.toLowerCase()
    );
    navigate(`/rooms/${matched ? matched.id : trimmed}`);
  }

  function enterRoom(room: Room) {
    if (room.transport === "xmtp" && !room.xmtp_group_id && room.created_by === user?.id) {
      navigate(`/setup/${room.id}`);
      return;
    }
    navigate(`/rooms/${room.id}`);
  }

  return (
    <div>
      <header className="topbar home-header">
        <Link to="/" className="topbar__brand">
          <Layers size={17} strokeWidth={1.9} />
          <span>Multi-Agent 协作空间</span>
        </Link>
        <span className="topbar__spacer" />
        <div className="topbar__actions">
          <Link to="/agents" className="btn btn-primary btn-sm">
            <Cpu size={14} strokeWidth={1.9} />
            <span>接入 Agent</span>
          </Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={openCreateModal}>
            <Plus size={14} strokeWidth={2} />
            <span>新建房间</span>
          </button>
          {user?.display_name && (
            <span className="topbar__user">
              <User size={13} strokeWidth={1.9} />
              {user.display_name}
            </span>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={logout} title="退出登录">
            <LogOut size={14} strokeWidth={1.9} />
            <span>退出</span>
          </button>
        </div>
      </header>

      <div className="home">
        <section className="home-banner">
          <div className="home-banner__body">
            <span className="home-banner__eyebrow">
              <Sparkles size={13} strokeWidth={2} />
              本机自动扫描 · 云端与桥接预设
            </span>
            <h2>一键接入 Claude Code · Codex · Grok · Muse</h2>
            <p>
              自动发现本机已安装的命令行 Agent，或使用内置兼容接口预设将云端与自研 Agent 带入端到端加密房间。
            </p>
          </div>
          <div className="home-banner__actions">
            <Link to="/agents" className="btn btn-primary">
              接入 Agent
              <ArrowRight size={15} strokeWidth={2} />
            </Link>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                track("quick_start_click");
                navigate("/setup");
              }}
            >
              四步配置向导
            </button>
          </div>
        </section>

        <div className="home-section-head">
          <div className="home-section-title" style={{ flex: 1 }}>
            我的房间
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={openCreateModal}>
            <Plus size={14} strokeWidth={2} />
            新建房间
          </button>
        </div>

        {actionError && (
          <div className="auth-error" style={{ marginBottom: 14 }} role="alert">
            {actionError}
          </div>
        )}

        {roomsQuery.isError && (
          <div className="page-error card">
            <p>加载房间列表失败，请刷新重试。</p>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginTop: 12 }}
              onClick={() => roomsQuery.refetch()}
            >
              重试
            </button>
          </div>
        )}

        {roomsQuery.isLoading && (
          <div className="loading-center">
            <span className="spinner" />
            正在加载房间…
          </div>
        )}

        {!roomsQuery.isLoading && !roomsQuery.isError && rooms.length === 0 && (
          <div className="home-empty">
            <p style={{ fontWeight: 600, color: "var(--text-primary)" }}>还没有协作房间</p>
            <p className="hint" style={{ marginTop: 6 }}>
              新建一个端到端加密房间，把你和协作者的 Agent 拉进同一个空间。
            </p>
            <div style={{ marginTop: 18, display: "inline-flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
              <button type="button" className="btn btn-primary" onClick={openCreateModal}>
                <Plus size={15} strokeWidth={2} />
                新建房间
              </button>
              <Link to="/agents" className="btn btn-ghost">
                先配置我的 Agent
              </Link>
            </div>
          </div>
        )}

        {rooms.length > 0 && (
          <div className="rooms-grid">
            {rooms.map((room) => {
              const isGroupReady = Boolean(room.xmtp_group_id);
              return (
                <div
                  key={room.id}
                  role="button"
                  tabIndex={0}
                  className="room-card"
                  onClick={() => enterRoom(room)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      enterRoom(room);
                    }
                  }}
                >
                  <span className="room-card__icon" aria-hidden="true">
                    <MessageSquare size={18} strokeWidth={1.8} />
                  </span>
                  <div className="room-card__info">
                    <div className="room-card__top">
                      <strong>{room.name}</strong>
                      <button
                        type="button"
                        className="room-card__delete"
                        title="删除房间"
                        aria-label={`删除房间 ${room.name}`}
                        disabled={deletingId === room.id}
                        onClick={(e) => void handleDeleteRoom(e, room)}
                      >
                        <Trash2 size={14} strokeWidth={1.8} />
                      </button>
                    </div>

                    {room.description && <p className="room-card__desc">{room.description}</p>}

                    <div className="room-card__foot">
                      <span
                        className={`room-card__badge ${
                          isGroupReady ? "room-card__badge--ready" : "room-card__badge--pending"
                        }`}
                      >
                        {isGroupReady ? (
                          <>
                            <Lock size={11} strokeWidth={2} />
                            加密群已就绪
                          </>
                        ) : (
                          <>
                            <KeyRound size={11} strokeWidth={2} />
                            待首次进入建群
                          </>
                        )}
                      </span>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: "2px 8px", fontSize: 11.5 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/agents?room=${encodeURIComponent(room.id)}`);
                          }}
                        >
                          + 接入 Agent
                        </button>
                        <small>{new Date(room.created_at).toLocaleDateString("zh-CN")}</small>
                      </div>
                    </div>
                  </div>
                  <span className="room-card__arrow" aria-hidden="true">
                    <ArrowRight size={15} strokeWidth={1.8} />
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="home-section-title">按房间 ID 或名称进入</div>
        <div className="join-row">
          <input
            className="input"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            placeholder="粘贴受邀的房间 ID 或输入名称…"
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleJoin}
            disabled={!joinId.trim()}
          >
            进入
          </button>
        </div>
      </div>

      {createOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!creating) setCreateOpen(false);
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-room-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2 id="create-room-title">新建加密协作房间</h2>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                <X size={17} strokeWidth={1.9} />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit}>
              <div className="modal-body">
                <div className="field">
                  <label>选择协作场景模板（可选）</label>
                  {templatesQuery.isLoading ? (
                    <div className="loading-center" style={{ padding: "18px 0" }}>
                      <span className="spinner" />
                      正在加载场景模板…
                    </div>
                  ) : (
                    <div className="tpl-grid">
                      <button
                        type="button"
                        className={`tpl-card ${selectedTplKey === null ? "tpl-card--selected" : ""}`}
                        onClick={() => selectTemplate(null)}
                      >
                        <span className="tpl-icon">
                          <Sparkles size={16} strokeWidth={1.8} />
                        </span>
                        <strong>空白房间</strong>
                        <small>自由命名，适合任意跨人机讨论与联调</small>
                      </button>
                      {templates.map((tpl) => (
                        <button
                          key={tpl.key}
                          type="button"
                          className={`tpl-card ${selectedTplKey === tpl.key ? "tpl-card--selected" : ""}`}
                          onClick={() => selectTemplate(tpl)}
                        >
                          <span className="tpl-icon">{renderTemplateIcon(tpl)}</span>
                          <strong>{tpl.name}</strong>
                          <small>{tpl.description || "预置多角色协作分工"}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="field">
                  <label htmlFor="new-room-name">房间名称</label>
                  <input
                    id="new-room-name"
                    className="input"
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    placeholder="例如：架构评审与发布联调"
                    autoFocus
                    required
                  />
                </div>

                {selectedTplKey === null && (
                  <div className="field">
                    <label htmlFor="new-room-desc">房间简介（可选）</label>
                    <input
                      id="new-room-desc"
                      className="input"
                      value={roomDesc}
                      onChange={(e) => setRoomDesc(e.target.value)}
                      placeholder="一句话说明本房间的协作目标"
                    />
                  </div>
                )}

                {createError && (
                  <p className="error-text" role="alert">
                    {createError}
                  </p>
                )}
              </div>

              <div className="modal-foot">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={creating}
                  onClick={() => setCreateOpen(false)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={creating || !roomName.trim()}
                >
                  {creating ? "创建中…" : "创建并配置加密群"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
