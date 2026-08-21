import { memo } from "react";
import type { ChatMessage } from "../../types/chat";

interface MessageItemProps {
  message: ChatMessage;
  isOwn: boolean;
}

function detectConsensus(content: string): boolean {
  const upper = content.toUpperCase();
  return upper.includes("[CONSENSUS]") || content.includes("共识已达成") || content.includes("达成一致");
}

function detectConflicts(content: string): string[] {
  const conflicts: string[] = [];
  for (const pattern of [
    /(?:但是|不过|然而|问题在于)(.{5,100})/g,
    /(?:不同意|反对|有异议)(.{5,80})/g,
    /\[CONFLICT\]\s*(.+)/g,
  ]) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      conflicts.push(match[1].trim());
    }
  }
  return conflicts.slice(0, 3);
}

/** Simple markdown-ish rendering */
function renderContent(content: string) {
  return content.split("\n").map((line, i) => {
    if (line.startsWith("### ")) return <h4 key={i}>{line.slice(4)}</h4>;
    if (line.startsWith("## ")) return <h3 key={i}>{line.slice(3)}</h3>;
    if (line.startsWith("# ")) return <strong key={i} style={{ display: "block", marginBottom: 4 }}>{line.slice(2)}</strong>;
    if (line.startsWith("- ") || line.startsWith("• "))
      return <li key={i} style={{ marginLeft: 16 }}>{line.slice(2)}</li>;
    if (line.trim() === "") return <div key={i} style={{ height: 6 }} />;
    return <p key={i} style={{ margin: 0 }}>{line}</p>;
  });
}

export const MessageItem = memo(function MessageItem({ message, isOwn }: MessageItemProps) {
  const isSystem = message.msg_type === "system";
  const isAgent = message.sender_type === "agent";
  const hasConsensus = message.msg_type === "consensus" || detectConsensus(message.content);
  const conflicts = message.msg_type === "conflict" ? [message.content] : detectConflicts(message.content);

  if (isSystem) {
    return (
      <div className="msg-system">
        <span>{message.content}</span>
      </div>
    );
  }

  return (
    <div className={`msg-row ${isOwn ? "msg-row--own" : ""}`}>
      {!isOwn && (
        <div className={`msg-avatar ${isAgent ? "msg-avatar--agent" : ""}`}>
          {isAgent ? "🤖" : (message.sender_name || "?").charAt(0).toUpperCase()}
        </div>
      )}
      <div
        className={[
          "msg-bubble",
          isAgent ? "msg-bubble--agent" : "",
          isOwn ? "msg-bubble--own" : "",
          hasConsensus ? "msg-bubble--consensus" : "",
          conflicts.length > 0 && !hasConsensus ? "msg-bubble--conflict" : "",
        ].filter(Boolean).join(" ")}
      >
        <div className="msg-meta">
          <span className="msg-meta__name">
            {isOwn ? "我" : message.sender_name || message.sender_id.slice(0, 8)}
            {isAgent && message.msg_type !== "text" && (
              <span className="msg-tag">{message.msg_type}</span>
            )}
          </span>
          <span className="msg-meta__time">
            {message.created_at && new Date(message.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        {hasConsensus && (
          <div className="badge badge--consensus">✅ 已达成共识</div>
        )}

        <div className="msg-content">{renderContent(message.content)}</div>

        {conflicts.length > 0 && !hasConsensus && (
          <div className="conflicts">
            <span className="conflicts__label">⚠️ 发现冲突</span>
            <ul>
              {conflicts.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
});
