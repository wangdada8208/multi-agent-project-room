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
    // 分享凭据在网址里，只按当前网址取一次；换链接时重新取。
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
        // 404 是链接失效；其余（含网络错误）统一提示加载失败，避免把“过期”错报给用户。
        if (err instanceof SharedLinkError) {
          setError(err.message);
        } else {
          setError("网络错误");
        }
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
    <div className="shared-room-page">
      <header className="shared-room-header">
        <span className="brand-mini">🤖 Multi-Agent Project Room</span>
        {roomName && <span className="shared-room-name">{roomName}</span>}
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
