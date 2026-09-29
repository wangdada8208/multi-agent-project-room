import { useRef, useState } from "react";
import type { SenderType } from "../../types/chat";

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
      const mention = `@${name} `;
      if (prev.includes(`@${name}`)) return prev;
      return prev.trim() ? `${mention}${prev}` : mention;
    });
    inputRef.current?.focus();
  };

  const submit = () => {
    if (!text.trim() || disabled) return;
    const pending = text.trim();
    void Promise.resolve(onSend(pending, "human")).then((ok) => {
      if (ok) setText("");
    });
  };

  return (
    <div className="chat-input">
      <div className="chat-input__mentions">
        {onlineAgents.map((agent) => (
          <button key={agent} type="button" className="chat-input__mention-btn" onClick={() => insertMention(agent)} disabled={disabled}>
            @{agent}
          </button>
        ))}
      </div>
      <div className="chat-input__row">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={disabled ? "等待连接..." : "输入消息，或 @Agent 呼叫"}
          disabled={disabled}
        />
        <button type="button" onClick={submit} disabled={disabled || !text.trim()}>
          发送
        </button>
      </div>
    </div>
  );
}
