import { FormEvent, useMemo, useState } from "react";
import type { SenderType } from "../../types/chat";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

interface MessageInputProps {
  disabled?: boolean;
  onSend: (content: string, senderType: SenderType) => boolean;
}

export function MessageInput({ disabled = false, onSend }: MessageInputProps) {
  const [content, setContent] = useState("");
  const [senderType, setSenderType] = useState<SenderType>("human");

  const canSend = useMemo(() => content.trim().length > 0 && !disabled, [content, disabled]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSend) {
      return;
    }

    const sent = onSend(content.trim(), senderType);
    if (sent) {
      setContent("");
    }
  }

  return (
    <form className="message-input" onSubmit={handleSubmit}>
      <Input
        value={content}
        disabled={disabled}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Send a message to the room..."
      />
      <select
        value={senderType}
        disabled={disabled}
        onChange={(event) => setSenderType(event.target.value as SenderType)}
        aria-label="Sender type"
      >
        <option value="human">Human</option>
        <option value="agent">Agent</option>
      </select>
      <Button disabled={!canSend}>Send</Button>
    </form>
  );
}
