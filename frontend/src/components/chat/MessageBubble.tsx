import type { ChatMessage } from "../../types/chat";
import { Avatar } from "../ui/Avatar";

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  return (
    <article className={`message-bubble ${message.sender_type}`}>
      <div className="message-row">
        <Avatar type={message.sender_type} />
        <div>
          <div className="message-meta">
            <span>{message.sender_type}</span>
            <span>{message.sender_id}</span>
            <span>{message.msg_type}</span>
          </div>
          <p>{message.content}</p>
        </div>
      </div>
    </article>
  );
}
