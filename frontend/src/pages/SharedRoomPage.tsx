import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Bot, Eye, Infinity as InfinityIcon, User } from "lucide-react";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { SharedLinkError, fetchSharedRoomMessages } from "../lib/api";
import type { ChatMessage } from "../types/chat";

export function SharedRoomPage() {
  const { token } = useParams<{ token: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [roomName, setRoomName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useDocumentTitle(roomName ? `${roomName} 分享 · Parlor` : "分享的房间 · Parlor");

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
          <InfinityIcon size={17} strokeWidth={2} />
          <span>Parlor</span>
        </Link>
        <span className="topbar__spacer" />
        <Link to="/login" className="ui-button ui-button--ghost ui-button--sm">
          登录参与
        </Link>
      </header>

      <div className="shared-page__body">
        <div className="shared-banner">
          <Eye size={15} strokeWidth={1.9} />
          <span>
            {roomName ? `「${roomName}」` : ""}只读分享视图 — 仅可浏览工作记录，无法发言
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
          <div className="shared-page__list">
            {messages.length === 0 && (
              <div className="shared-page__empty">
                <p>暂无公开消息</p>
              </div>
            )}
            {messages.map((msg) => {
              const isAgent = msg.sender_type === "agent";
              return (
                <div key={msg.id} className="shared-msg">
                  <div className={`shared-msg__avatar ${isAgent ? "shared-msg__avatar--agent" : ""}`}>
                    {isAgent ? (
                      <Bot size={15} strokeWidth={1.9} />
                    ) : msg.sender_name ? (
                      msg.sender_name.charAt(0).toUpperCase()
                    ) : (
                      <User size={15} strokeWidth={1.9} />
                    )}
                  </div>
                  <div className="shared-msg__body">
                    <div className="shared-msg__meta">
                      <span className="shared-msg__name">{msg.sender_name ?? msg.sender_id}</span>
                      <span className="shared-msg__time">
                        {new Date(msg.created_at).toLocaleString("zh-CN")}
                      </span>
                    </div>
                    <p className="shared-msg__content">{msg.content}</p>
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
