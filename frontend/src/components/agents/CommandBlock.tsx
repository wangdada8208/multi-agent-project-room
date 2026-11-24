import { useState } from "react";
import { CopyButton } from "../CopyButton";

export function CommandBlock({ command, onCopied }: { command: string; onCopied?: () => void }) {
  const [full, setFull] = useState(false);
  const bridge = command.split(" && node ").at(-1);
  const summary = bridge && bridge !== command
    ? `curl … && tar … && npm ci …\n# 下载并安装桥接程序\nnode ${bridge}` : command;

  return <div className="wb-command code-block">
    <header>
      <button type="button" aria-pressed={full} onClick={() => setFull(!full)}>{full ? "显示摘要" : "完整指令"}</button>
      <CopyButton text={command} label="复制" onCopied={onCopied} />
    </header>
    <pre><code>{full ? command : summary}</code></pre>
  </div>;
}
