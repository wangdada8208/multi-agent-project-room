import { useId, type ReactNode } from "react";

export function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: readonly { value: T; label: ReactNode; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="ui-segmented">
      {options.map((option) => (
        <label key={option.value}>
          <input type="radio" name={name} checked={option.value === value} disabled={option.disabled} onChange={() => onChange(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
