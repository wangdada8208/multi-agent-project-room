import type { ComponentPropsWithoutRef } from "react";

export function Switch({ checked, onCheckedChange, label, ...props }: Omit<ComponentPropsWithoutRef<"input">, "checked" | "type" | "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="ui-switch">
      <input {...props} type="checkbox" role="switch" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} />
      <span className="ui-switch__track" aria-hidden="true" />
      {label}
    </label>
  );
}
