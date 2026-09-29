import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import type { ChatMessage } from "../types/chat";

export function SharedRoomPage() {
  const { token } = useParams<{ token: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useState(() => {
    async function fetchShared() {
      try {
        const res = await fetch(`/api/v1/shared/${token}`);
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages ?? []);
        } else if (res.status === 404) {
          setError("链接已过期或不存在");
        } else {
          setError("加载失败");
        }
      } catch {
        setError("网络错误");
      } finally {
        setLoading(false);
      }
    }
    fetchShared();
    return null;
  });

  return (
    <div className="shared-room-page">
      <header className="shared-room-header">
        <span className="brand-mini">🤖 Multi-Agent Project Room</span>
        <span className="shared-badge">只读分享</span>
        <Link to="/login" className="btn-ghost" style={{ padding: "6px 14px", marginLeft: "auto" }}>
          登录参与
        </Link>
      </header>

      {loading && <p className="chat-loading">加载中...</p>}
      {error && <p className="chat-error">{error}</p>}

      {!loading && !error && (
        <div className="shared-messages">
          {messages.length === 0 && <p className="chat-empty">暂无消息</p>}
          {messages.map((msg) => (
            <div key={msg.id} className="msg-row msg-row--shared">
              <div className="msg-avatar">{(msg.sender_name ?? "A").charAt(0).toUpperCase()}</div>
              <div className={`msg-bubble ${msg.sender_type === "agent" ? "msg-bubble--agent" : ""}`}>
                <div className="msg-meta">
                  <span className="msg-meta__name">{msg.sender_name ?? msg.sender_id}</span>
                  <span className="msg-meta__time">{new Date(msg.created_at).toLocaleString("zh-CN")}</span>
                </div>
                <div className="msg-content"><p>{msg.content}</p></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
