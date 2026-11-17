import { useState } from "react";

/** 复制按钮：写剪贴板成功后在按钮上短暂显示「已复制」。剪贴板不可用时静默。 */
export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch { /* 剪贴板不可用时静默 */ }
      }}
    >
      {copied ? "✓ 已复制" : `📋 ${label}`}
    </button>
  );
}
