import { useRef, useState } from "react";
import { ArrowUp, AtSign } from "lucide-react";
import type { SenderType } from "../types/chat";

interface ChatInputProps {
  disabled: boolean;
  onlineAgents: string[];
  onSend: (content: string, senderType: SenderType) => boolean | Promise<boolean>;
}

export function ChatInput({ disabled, onlineAgents, onSend }: ChatInputProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const insertMention = (name: string) => {
    setText((prev) => {
      const token = `@${name}`;
      if (prev.includes(token)) return prev;
      const prefix = `${token} `;
      return prev.trim() ? `${prefix}${prev}` : prefix;
    });
    inputRef.current?.focus();
  };

  const submit = () => {
    if (!text.trim() || disabled) return;
    const pending = text.trim();
    void Promise.resolve(onSend(pending, "human"))
      .then((ok) => {
        if (ok) setText("");
      })
      .catch(() => {
        /* 发送失败时保留文字，方便重试 */
      });
  };

  return (
    <div className="chat-input">
      {onlineAgents.length > 0 && (
        <div className="chat-input__mentions">
          {onlineAgents.length >= 2 && (
            <button
              type="button"
              className="mention-btn mention-btn--all"
              onClick={() => insertMention("全体")}
              disabled={disabled}
            >
              <AtSign size={12} strokeWidth={2} />
              <span>全体</span>
            </button>
          )}
          {onlineAgents.map((agent) => (
            <button
              key={agent}
              type="button"
              className="mention-btn"
              onClick={() => insertMention(agent)}
              disabled={disabled}
            >
              <AtSign size={12} strokeWidth={1.9} />
              <span>{agent}</span>
            </button>
          ))}
        </div>
      )}
      <div className="chat-input__row">
        <input
          ref={inputRef}
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "等待加密连接就绪…" : "输入消息，或点上方 @Agent 唤醒智能体协作"}
          disabled={disabled}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={disabled || !text.trim()}
        >
          <ArrowUp size={15} strokeWidth={2.2} />
          <span>发送</span>
        </button>
      </div>
    </div>
  );
}
