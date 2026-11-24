import type { ReactNode } from "react";
import { Button } from "./Button";

export function ConfirmInline({ children, onCancel, onConfirm, confirmLabel = "确认", loading }: {
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  loading?: boolean;
}) {
  return (
    <div className="ui-confirm">
      <div>{children}</div>
      <div className="ui-confirm__actions">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={loading}>取消</Button>
        <Button variant="danger" size="sm" onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
      </div>
    </div>
  );
}
