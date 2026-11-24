import { Laptop, Share2 } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "../CopyButton";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Tag";

export function DesktopOnlyNotice({ roomId }: { roomId: string }) {
  const [message, setMessage] = useState("");
  const url = new URL("/agents", window.location.origin);
  if (roomId) url.searchParams.set("room", roomId);

  async function share() {
    try {
      await navigator.share({ title: "在电脑上继续接入 Agent", url: url.href });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setMessage("分享失败。你可以复制链接发送到电脑。");
    }
  }

  return <section className="wb-desktop-notice">
    <div className="wb-desktop-notice__icon"><Laptop size={20} /></div>
    <div>
      <h2>在电脑上继续接入</h2>
      <p>终端 Agent 与模型接口需要在电脑上配对一次。</p>
      <div className="wb-desktop-notice__tags">{["Claude Code", "Codex", "Gemini CLI", "OpenClaw", "xAI API", "Ollama", "Webhook"].map((name) => <Tag key={name}>{name}</Tag>)}</div>
      <div className="wb-actions">
        <CopyButton text={url.href} label="复制电脑端链接" />
        {typeof navigator.share === "function" && <Button variant="secondary" size="sm" onClick={() => void share()}><Share2 size={14} />分享到电脑</Button>}
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  </section>;
}
