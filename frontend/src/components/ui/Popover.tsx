import { useId, type ReactNode } from "react";
import { Button } from "./Button";

export function Popover({ trigger, children, label }: { trigger: ReactNode; children: ReactNode; label: string }) {
  const id = useId();
  return (
    <div className="ui-popover">
      <Button variant="secondary" popoverTarget={id}>{trigger}</Button>
      <div id={id} popover="auto" role="region" aria-label={label} className="ui-popover__content">{children}</div>
    </div>
  );
}
