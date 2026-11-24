import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** 复制按钮：写剪贴板成功后在按钮上短暂显示「已复制」。剪贴板不可用时静默。 */
export function CopyButton({ text, label = "复制", onCopied }: { text: string; label?: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          onCopied?.();
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* 剪贴板不可用时静默 */
        }
      }}
    >
      {copied ? (
        <>
          <Check size={13} strokeWidth={2.2} />
          <span>已复制</span>
        </>
      ) : (
        <>
          <Copy size={13} strokeWidth={1.9} />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}
