import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  side?: "right" | "bottom";
  className?: string;
}

export function Drawer({ open, onClose, title, children, side = "right", className = "" }: DrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const startY = useRef<number | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    if (!open && element.open) {
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog ref={dialog} aria-labelledby={heading} className={`ui-drawer ui-drawer--${side} ${className}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ui-drawer__body">
        {side === "bottom" && <div className="ui-drawer__grab" aria-hidden="true"
          onPointerDown={(event) => {
            startY.current = event.clientY;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            if (startY.current !== null && event.clientY - startY.current > 54) onClose();
            startY.current = null;
          }}
          onPointerCancel={() => { startY.current = null; }} />}
        <header className="ui-drawer__header">
          <h2 id={heading}>{title}</h2>
          <IconButton label="关闭" onClick={onClose}>×</IconButton>
        </header>
        {children}
      </div>
    </dialog>
  );
}
