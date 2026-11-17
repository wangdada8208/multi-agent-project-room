import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Bot, Eye, Layers, User } from "lucide-react";
import { SharedLinkError, fetchSharedRoomMessages } from "../lib/api";
import type { ChatMessage } from "../types/chat";

export function SharedRoomPage() {
  const { token } = useParams<{ token: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [roomName, setRoomName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function fetchShared() {
      setLoading(true);
      setError("");
      try {
        const view = await fetchSharedRoomMessages(token ?? "");
        if (cancelled) return;
        setMessages(view.messages);
        setRoomName(view.roomName);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof SharedLinkError ? err.message : "网络错误");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchShared();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="shared-page">
      <header className="topbar">
        <Link to="/" className="topbar__brand">
          <Layers size={17} strokeWidth={1.9} />
          <span>Multi-Agent 协作空间</span>
        </Link>
        <span className="topbar__spacer" />
        <Link to="/login" className="btn btn-ghost btn-sm">
          登录参与
        </Link>
      </header>

      <div className="shared-page__body">
        <div className="shared-banner">
          <Eye size={15} strokeWidth={1.9} color="var(--accent)" />
          <span>
            {roomName ? `「${roomName}」` : ""}只读分享视图 — 仅可浏览协作记录，无法发言
          </span>
        </div>

        {loading && (
          <div className="loading-center">
            <span className="spinner" />
            加载中…
          </div>
        )}
        {error && (
          <div className="page-error card">
            <p>{error}</p>
          </div>
        )}

        {!loading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {messages.length === 0 && (
              <div className="home-empty">
                <p>暂无公开消息</p>
              </div>
            )}
            {messages.map((msg) => {
              const isAgent = msg.sender_type === "agent";
              return (
                <div key={msg.id} className="msg">
                  <div className={`msg__avatar ${isAgent ? "msg__avatar--agent" : ""}`}>
                    {isAgent ? (
                      <Bot size={15} strokeWidth={1.9} />
                    ) : msg.sender_name ? (
                      msg.sender_name.charAt(0).toUpperCase()
                    ) : (
                      <User size={15} strokeWidth={1.9} />
                    )}
                  </div>
                  <div className={`msg__bubble ${isAgent ? "msg__bubble--agent" : ""}`}>
                    <div className="msg__meta">
                      <span className="msg__name">{msg.sender_name ?? msg.sender_id}</span>
                      <span className="msg__time">
                        {new Date(msg.created_at).toLocaleString("zh-CN")}
                      </span>
                    </div>
                    <div className="msg__content">
                      <p>{msg.content}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
