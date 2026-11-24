import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  side?: "right" | "bottom";
}

export function Drawer({ open, onClose, title, children, side = "right" }: DrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} aria-labelledby={heading} className={`ui-drawer ui-drawer--${side}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ui-drawer__body">
        <header className="ui-drawer__header">
          <h2 id={heading}>{title}</h2>
          <IconButton label="关闭" onClick={onClose}>×</IconButton>
        </header>
        {children}
      </div>
    </dialog>
  );
}
