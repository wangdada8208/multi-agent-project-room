import { useEffect, useRef, useState } from "react";
import { ArrowUp, AtSign, RefreshCw, X } from "lucide-react";
import type { SenderType } from "../types/chat";
import {
  clearEncryptedDraft,
  hasDraftSession,
  loadEncryptedDraft,
  saveEncryptedDraft,
  setDraftSessionKeyMaterial,
} from "../lib/encryptedDrafts";
import "./ChatInput.css";

export interface ReplyTargetInfo {
  id: string;
  senderInboxId?: string;
  senderName: string;
  excerpt: string;
}

interface ChatInputProps {
  disabled: boolean;
  onlineAgents: string[];
  pausedAgents?: readonly string[];
  onSend: (content: string, senderType: SenderType) => boolean | Promise<boolean>;
  roomId?: string;
  identityAddress?: string | null;
  draftKeyMaterial?: string | null;
  replyTarget?: ReplyTargetInfo | null;
  onCancelReply?: () => void;
}

/**
 * Enter 发送、Shift+Enter 换行；IME 输入法合成期间（isComposing）绝不发送。
 */
export function isSubmitKeyDown(e: {
  key: string;
  shiftKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing;
}

/**
 * 一次发送尝试：sent=成功（可清空草稿），failed=失败（保留文字可重试），skipped=空内容。
 */
export async function attemptSend(input: {
  text: string;
  onSend: (content: string) => boolean | Promise<boolean>;
}): Promise<"sent" | "failed" | "skipped"> {
  const pending = input.text.trim();
  if (!pending) return "skipped";
  try {
    const ok = await Promise.resolve(input.onSend(pending));
    return ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

export function ChatInput({
  disabled,
  onlineAgents,
  pausedAgents = [],
  onSend,
  roomId,
  identityAddress,
  draftKeyMaterial,
  replyTarget,
  onCancelReply,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftReadyRef = useRef(false);

  // 会话密钥材料只驻留内存；本组件是唯一持有方，随 prop 更新、卸载即清除。
  useEffect(() => {
    setDraftSessionKeyMaterial(draftKeyMaterial ?? null);
    return () => setDraftSessionKeyMaterial(null);
  }, [draftKeyMaterial]);

  // 身份解锁后按 (roomId, identityAddress) 恢复加密草稿；身份未就绪时不清空输入。
  useEffect(() => {
    draftReadyRef.current = false;
    if (!roomId || !identityAddress || !hasDraftSession()) return;
    let cancelled = false;
    void loadEncryptedDraft({ roomId, identityAddress })
      .then((draft) => {
        if (!cancelled && draft) setText(draft);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) draftReadyRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, identityAddress, draftKeyMaterial]);

  // 草稿防抖落盘（密文）；身份锁定或初次恢复未完成前不写。
  useEffect(() => {
    if (!roomId || !identityAddress || !draftReadyRef.current || !hasDraftSession()) return;
    const timer = window.setTimeout(() => {
      void saveEncryptedDraft({ roomId, identityAddress, text }).catch(() => {});
    }, 200);
    return () => window.clearTimeout(timer);
  }, [text, roomId, identityAddress]);

  // 多行输入框随内容自适应高度（封顶后内部滚动）。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

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
    if (!text.trim() || disabled || sending) return;
    setSending(true);
    setSendFailed(false);
    void attemptSend({ text, onSend: (content) => onSend(content, "human") })
      .then((result) => {
        if (result === "sent") {
          setText("");
          if (roomId && identityAddress) {
            clearEncryptedDraft({ roomId, identityAddress });
          }
        } else if (result === "failed") {
          setSendFailed(true);
        }
      })
      .finally(() => setSending(false));
  };

  return (
    <div className="chat-input">
      {replyTarget && (
        <div className="chat-input__reply-banner">
          <span className="chat-input__reply-text">
            回复 {replyTarget.senderName}：{replyTarget.excerpt}
          </span>
          <button
            type="button"
            className="icon-btn chat-input__reply-cancel"
            onClick={onCancelReply}
            title="取消回复"
            aria-label="取消回复"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}
      {sendFailed && (
        <div className="chat-input__send-error" role="alert">
          <span className="chat-input__send-error-dot" />
          <span className="chat-input__send-error-text">上一条消息发送失败，内容已保留</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={submit}
            disabled={disabled || sending}
          >
            <RefreshCw size={12} strokeWidth={2} />
            <span>重试</span>
          </button>
        </div>
      )}
      {(onlineAgents.length > 0 || pausedAgents.length > 0) && (
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
          {pausedAgents.map((agent) => (
            <button key={agent} type="button" className="mention-btn" title="已暂停" disabled>
              <AtSign size={12} strokeWidth={1.9} />
              <span>{agent}</span>
            </button>
          ))}
        </div>
      )}
      <div className="chat-input__row">
        <textarea
          ref={inputRef}
          className="input chat-input__textarea"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isSubmitKeyDown(e)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "等待加密连接就绪…" : "输入消息，Enter 发送，Shift+Enter 换行"}
          disabled={disabled}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={disabled || sending || !text.trim()}
        >
          <ArrowUp size={15} strokeWidth={2.2} />
          <span>{sending ? "发送中" : "发送"}</span>
        </button>
      </div>
    </div>
  );
}
