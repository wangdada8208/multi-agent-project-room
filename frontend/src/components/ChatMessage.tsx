import { memo } from "react";
import { AlertCircle, Bot, CheckCircle2, Cpu, User } from "lucide-react";
import { TRUST_TIER_LABEL, type TrustTier } from "../lib/localHelper";
import type { ChatMessage } from "../types/chat";

export interface ChatMessageWithTrust extends ChatMessage {
  trustTier?: TrustTier;
}

export interface ChatMessageProps {
  message: ChatMessageWithTrust;
  isOwn: boolean;
}

function detectConsensus(content: string): boolean {
  const upper = content.toUpperCase();
  return upper.includes("[CONSENSUS]") || content.includes("共识已达成") || content.includes("达成一致");
}

/**
 * 仅匹配显式冲突标记行（[CONFLICT] 或 【冲突】），绝不误判日常连词（但是/不过/然而/问题在于）。
 */
export function detectConflicts(content: string): string[] {
  const conflicts: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:\[CONFLICT\]|【冲突】)\s*[:：]?\s*(.+)$/i);
    if (match && match[1].trim()) {
      conflicts.push(match[1].trim());
    }
  }
  return conflicts.slice(0, 3);
}

function renderContent(content: string) {
  return content.split("\n").map((line, i) => {
    if (line.startsWith("### ")) return <h4 key={i}>{line.slice(4)}</h4>;
    if (line.startsWith("## ")) return <h3 key={i}>{line.slice(3)}</h3>;
    if (line.startsWith("# ")) {
      return <strong key={i} style={{ display: "block", marginBottom: 4 }}>{line.slice(2)}</strong>;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      return <li key={i} style={{ marginLeft: 16 }}>{line.slice(2)}</li>;
    }
    if (line.trim() === "") return <div key={i} style={{ height: 6 }} />;
    return <p key={i}>{line}</p>;
  });
}

export const ChatMessageItem = memo(function ChatMessageItem({ message, isOwn: rawIsOwn }: ChatMessageProps) {
  const isSystem = message.msg_type === "system";
  const isAgent = message.sender_type === "agent";
  const isOwn = !isAgent && rawIsOwn;
  const hasConsensus = message.msg_type === "consensus" || detectConsensus(message.content);
  const conflicts = message.msg_type === "conflict" ? [message.content] : detectConflicts(message.content);

  if (isSystem) {
    return (
      <div className="msg-sys">
        <span>{message.content}</span>
      </div>
    );
  }

  return (
    <div className={`msg ${isOwn ? "msg--own" : ""}`}>
      {!isOwn && (
        <div className={`msg__avatar ${isAgent ? "msg__avatar--agent" : ""}`}>
          {isAgent ? (
            message.trustTier === "local-cli" ? (
              <Cpu size={15} strokeWidth={1.8} />
            ) : (
              <Bot size={15} strokeWidth={1.8} />
            )
          ) : (
            <User size={15} strokeWidth={1.8} />
          )}
        </div>
      )}
      <div
        className={[
          "msg__bubble",
          isAgent ? "msg__bubble--agent" : "",
          hasConsensus ? "msg__bubble--consensus" : "",
          conflicts.length > 0 && !hasConsensus ? "msg__bubble--conflict" : "",
        ].filter(Boolean).join(" ")}
      >
        <div className="msg__meta">
          <span className="msg__name">
            <span>
              {isAgent
                ? message.sender_name || "Agent"
                : isOwn
                  ? "我"
                  : message.sender_name || message.sender_id.slice(0, 8)}
            </span>
            {isAgent && message.trustTier && (
              <span className={`trust-badge trust-badge--${message.trustTier} tier-badge tier-badge--${message.trustTier}`}>
                {TRUST_TIER_LABEL[message.trustTier]}
              </span>
            )}
            {isAgent && message.msg_type !== "text" && (
              <span className="msg__tag">{message.msg_type}</span>
            )}
          </span>
          <span className="msg__time">
            {message.created_at &&
              new Date(message.created_at).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
          </span>
        </div>

        {hasConsensus && (
          <div className="badge-consensus">
            <CheckCircle2 size={13} strokeWidth={2} />
            <span>已达成共识</span>
          </div>
        )}

        <div className="msg__content">{renderContent(message.content)}</div>

        {conflicts.length > 0 && !hasConsensus && (
          <div className="conflict-box">
            <strong style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <AlertCircle size={14} strokeWidth={2} />
              <span>显式分歧标记</span>
            </strong>
            <ul>
              {conflicts.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
});
