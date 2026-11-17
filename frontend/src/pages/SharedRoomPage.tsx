import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
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
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="shared-page">
      <header className="topbar" style={{ margin: "-28px -20px 0" }}>
        <span className="topbar__brand">🤖 Multi-Agent Project Room</span>
        <span className="topbar__spacer" />
        <Link to="/login" className="btn btn-ghost btn-sm">登录参与</Link>
      </header>

      <div style={{ marginTop: 28 }}>
        <div className="shared-banner">
          👁 {roomName ? `「${roomName}」` : ""} 只读分享 — 只能查看，不能发言
        </div>

        {loading && <div className="loading-center"><span className="spinner" />加载中...</div>}
        {error && <div className="page-error card"><p>{error}</p></div>}

        {!loading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {messages.length === 0 && <div className="home-empty"><p>暂无消息</p></div>}
            {messages.map((msg) => (
              <div key={msg.id} className="msg">
                <div className={`msg__avatar ${msg.sender_type === "agent" ? "msg__avatar--agent" : ""}`}>
                  {(msg.sender_name ?? "A").charAt(0).toUpperCase()}
                </div>
                <div className={`msg__bubble ${msg.sender_type === "agent" ? "msg__bubble--agent" : ""}`}>
                  <div className="msg__meta">
                    <span className="msg__name">{msg.sender_name ?? msg.sender_id}</span>
                    <span className="msg__time">{new Date(msg.created_at).toLocaleString("zh-CN")}</span>
                  </div>
                  <div className="msg__content"><p>{msg.content}</p></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
