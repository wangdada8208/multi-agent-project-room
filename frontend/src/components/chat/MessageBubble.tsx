import type { ChatMessage } from "../../types/chat";
import { Avatar } from "../ui/Avatar";

interface MessageBubbleProps {
  message: ChatMessage;
}

/** 检测消息内容中的共识标记 */
function detectConsensus(content: string): boolean {
  const upper = content.toUpperCase();
  return (
    upper.includes("[CONSENSUS]") ||
    content.includes("共识已达成") ||
    content.includes("达成一致")
  );
}

/** 检测消息内容中的冲突点 */
function detectConflicts(content: string): string[] {
  const conflicts: string[] = [];
  const patterns = [
    /(?:但是|不过|然而|问题在于)(.{5,100})/g,
    /(?:不同意|反对|有异议)(.{5,80})/g,
    /\[CONFLICT\]\s*(.+)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      conflicts.push(match[1].trim());
    }
  }
  return conflicts.slice(0, 3);
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const hasConsensus = message.msg_type === "consensus" || detectConsensus(message.content);
  const conflicts = message.msg_type === "conflict" ? [message.content] : detectConflicts(message.content);

  const bubbleClass = [
    "message-bubble",
    message.sender_type,
    hasConsensus ? "message-bubble--consensus" : "",
    conflicts.length > 0 ? "message-bubble--conflict" : "",
  ].filter(Boolean).join(" ");

  return (
    <article className={bubbleClass}>
      <div className="message-row">
        <Avatar type={message.sender_type} />
        <div className="message-body">
          <div className="message-meta">
            <span className="message-meta__name">{message.sender_name || message.sender_id}</span>
            <span className="message-meta__type">{message.msg_type}</span>
          </div>

          {/* 共识标记 */}
          {hasConsensus && (
            <div className="consensus-badge" role="status">
              ✅ 已达成共识
            </div>
          )}

          <p className="message-content">{message.content}</p>

          {/* 冲突高亮 */}
          {conflicts.length > 0 && !hasConsensus && (
            <div className="conflict-list" role="alert">
              <span className="conflict-list__label">⚠️ 发现冲突</span>
              <ul>
                {conflicts.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
