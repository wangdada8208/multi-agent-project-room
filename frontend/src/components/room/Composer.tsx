import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, AtSign, LockKeyhole, RefreshCw, X } from "lucide-react";
import type { SenderType } from "../../types/chat";
import {
  clearEncryptedDraft,
  hasDraftSession,
  loadEncryptedDraft,
  saveEncryptedDraft,
  setDraftSessionKeyMaterial,
} from "../../lib/encryptedDrafts";
import { filterMentionCandidates, parseMentionQuery, type MentionCandidate } from "../../lib/domain/mentions";
import { MentionPicker } from "./MentionPicker";

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
  candidates?: readonly MentionCandidate[];
  prefill?: { text: string };
  encrypted?: boolean;
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

export function Composer({
  disabled,
  onlineAgents,
  pausedAgents = [],
  onSend,
  roomId,
  identityAddress,
  draftKeyMaterial,
  replyTarget,
  onCancelReply,
  candidates,
  prefill,
  encrypted,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftReadyRef = useRef(false);
  const sendInFlight = useRef(false);
  const pickerId = useId();
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const pickerItems = candidates ?? [
    ...(onlineAgents.length > 1 ? [{ id: "all", name: "全体", actor: "shortcut", disabled: false } satisfies MentionCandidate] : []),
    ...onlineAgents.map((name): MentionCandidate => ({ id: name, name, actor: "local", disabled: false })),
    ...pausedAgents.map((name): MentionCandidate => ({ id: name, name, actor: "local", disabled: true })),
  ];
  const mention = dismissed ? null : parseMentionQuery(text, cursor);
  const matches = mention ? filterMentionCandidates(pickerItems, mention.query) : [];
  const selectable = matches.filter((item) => !item.disabled);
  const active = selectable[activeIndex % (selectable.length || 1)];
  const hasPicker = matches.length > 0 && !disabled;

  useEffect(() => {
    if (!prefill) return;
    setText((previous) => previous.trim() ? `${previous}\n${prefill.text}` : prefill.text);
    setDismissed(true);
    inputRef.current?.focus();
  }, [prefill]);

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

  const updateText = (next: string, selection: number) => {
    setText(next);
    setCursor(selection);
    setActiveIndex(0);
    setDismissed(false);
  };

  const focusAt = (position: number) => {
    inputRef.current?.focus();
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(position, position));
  };

  const choose = (item: MentionCandidate) => {
    if (!mention || item.disabled) return;
    const token = `@${item.name} `;
    const end = mention.start + token.length;
    updateText(text.slice(0, mention.start) + token + text.slice(mention.end), end);
    setDismissed(true);
    focusAt(end);
  };

  const openMentions = () => {
    const selection = inputRef.current?.selectionStart ?? text.length;
    if (parseMentionQuery(text, selection)) {
      setCursor(selection);
      setDismissed(false);
      focusAt(selection);
      return;
    }
    const token = selection && !/\s/u.test(text[selection - 1]) ? " @" : "@";
    updateText(text.slice(0, selection) + token + text.slice(selection), selection + token.length);
    focusAt(selection + token.length);
  };

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
    if (!text.trim() || disabled || sendInFlight.current) return;
    sendInFlight.current = true;
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
      .finally(() => { sendInFlight.current = false; setSending(false); });
  };

  return (
    <div className="wb-composer-wrap">
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
      {!candidates && (onlineAgents.length > 0 || pausedAgents.length > 0) && (
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
      <div className="wb-composer">
        {hasPicker && <MentionPicker id={pickerId} items={matches} activeId={active?.id} onChoose={choose} />}
        <button type="button" className="wb-mention-trigger" aria-label="提及成员" onClick={openMentions} disabled={disabled}><AtSign size={17} /></button>
        <textarea
          ref={inputRef}
          className="wb-composer__input"
          aria-label="输入消息"
          aria-controls={hasPicker ? pickerId : undefined}
          aria-activedescendant={hasPicker && active ? `${pickerId}-${active.id}` : undefined}
          rows={1}
          value={text}
          onChange={(e) => updateText(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
          onBlur={() => setDismissed(true)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (hasPicker && e.key === "Escape") {
              e.preventDefault();
              setDismissed(true);
              return;
            }
            if (hasPicker && selectable.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              const direction = e.key === "ArrowDown" ? 1 : -1;
              setActiveIndex((activeIndex + direction + selectable.length) % selectable.length);
              return;
            }
            if (hasPicker && !e.shiftKey && (e.key === "Enter" || e.key === "Tab")) {
              if (active) { e.preventDefault(); choose(active); }
              else if (e.key === "Enter") e.preventDefault();
              return;
            }
            if (isSubmitKeyDown(e)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "等待加密连接就绪…" : "发消息，输入 @ 召唤 Agent…"}
          disabled={disabled}
        />
        <div className="wb-composer__bar">
          <button type="button" className="wb-mention-trigger" aria-label="提及成员" onClick={openMentions} disabled={disabled}><AtSign size={17} /></button>
          <span>{encrypted && <><LockKeyhole size={12} />端到端加密 · </>}<kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>
          <button
          type="button"
          className="wb-send"
          aria-label={sending ? "发送中" : "发送"}
          onClick={submit}
          disabled={disabled || sending || !text.trim()}
        >
          <ArrowUp size={15} strokeWidth={2.2} />
        </button>
        </div>
      </div>
    </div>
  );
}
