import { LockKeyhole, MoreHorizontal, Reply } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MentionCandidate } from "../../lib/domain/mentions";
import type { DisplayMessage } from "../../lib/domain/displayMessages";
import { detectConflicts } from "../ChatMessage";
import { CopyButton } from "../CopyButton";
import { Avatar } from "../ui/Avatar";
import { IconButton } from "../ui/IconButton";
import { Tag } from "../ui/Tag";
import { ConclusionCard } from "./ConclusionCard";
import { MarkdownLite } from "./MarkdownLite";

export function MessageItem({ message, replyTo, owner, candidates, onReply, onPrefill }: {
  message: DisplayMessage;
  replyTo?: DisplayMessage;
  owner?: boolean;
  candidates?: readonly MentionCandidate[];
  onReply?: (message: DisplayMessage) => void;
  onPrefill?: (text: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const hold = useRef<number | undefined>(undefined);
  const finishHold = () => window.clearTimeout(hold.current);
  useEffect(() => () => window.clearTimeout(hold.current), []);
  const time = new Date(message.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (message.msg_type === "system") return <div className="wb-system"><LockKeyhole size={13} />{message.content} · {time}</div>;
  const name = message.sender_name || message.sender_id.slice(0, 8);
  const conclusion = message.msg_type === "consensus" || message.msg_type === "report"
    || (message.sender_type === "agent" && /^\s*\[CONSENSUS\]/iu.test(message.content));
  const conflicts = conclusion ? [] : detectConflicts(message.content);

  return (
    <article className={`wb-message wb-message--${message.actor}`}
      onContextMenu={(event) => { event.preventDefault(); setMenu(true); }}
      onPointerDown={(event) => {
        if (event.pointerType === "touch") hold.current = window.setTimeout(() => setMenu(true), 500);
      }} onPointerMove={finishHold} onPointerUp={finishHold} onPointerCancel={finishHold} onPointerLeave={finishHold}>
      <Avatar actor={message.actor} name={name} />
      <div className="wb-message__content">
        <header>
          <strong>{name}</strong>
          {(message.actor === "cloud" || message.actor === "local") && <Tag tone={message.actor}>{message.sourceSubtitle}</Tag>}
          {message.actor === "me" && owner && <Tag tone="owner">房主</Tag>}
          <time dateTime={message.created_at}>{time}</time>
        </header>
        {message.replyToId && <div className="wb-quote">↩ 回复 {replyTo ? `${replyTo.sender_name || "一条消息"}：${replyTo.content.replace(/\s+/gu, " ").slice(0, 60)}` : "一条消息"}</div>}
        {conclusion ? <ConclusionCard content={message.content} author={name} candidates={candidates} onPrefill={onPrefill} /> : <MarkdownLite text={message.content} candidates={candidates} />}
        {conflicts.length > 0 && <Tag tone="warn">显式分歧标记</Tag>}
      </div>
      <div className={`wb-message__actions${menu ? " wb-message__actions--open" : ""}`}>
        {onReply && <IconButton label="回复此消息" size="sm" onClick={() => { onReply(message); setMenu(false); }}><Reply size={14} /></IconButton>}
        <IconButton label={menu ? "关闭消息操作" : "更多消息操作"} pressed={menu} size="sm" onClick={() => setMenu(!menu)}><MoreHorizontal size={15} /></IconButton>
        {menu && <CopyButton label="复制消息" text={message.content} />}
      </div>
    </article>
  );
}
