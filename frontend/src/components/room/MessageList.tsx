import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import type { DisplayMessage } from "../../lib/domain/displayMessages";
import { MessageItem } from "./MessageItem";

export function MessageList({ messages, byId, notice, ...actions }: Omit<ComponentProps<typeof MessageItem>, "message" | "replyTo"> & {
  messages: DisplayMessage[];
  byId: ReadonlyMap<string, DisplayMessage>;
  notice?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastId = messages.at(-1)?.id;
  useLayoutEffect(() => {
    if (ref.current && atBottom.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lastId]);
  return (
    <div className="wb-stream" ref={ref} role="log" aria-label="房间消息"
      onScroll={({ currentTarget: el }) => { atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
      <div className="wb-stream__inner">
        {notice}
        {messages.map((message) => <MessageItem key={message.id} message={message}
          replyTo={message.replyToId ? byId.get(message.replyToId) : undefined} {...actions} />)}
      </div>
    </div>
  );
}
