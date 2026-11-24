import { Button, type ButtonProps } from "./Button";

export function IconButton({ label, pressed, variant = "ghost", className = "", ...props }: ButtonProps & {
  label: string;
  pressed?: boolean;
}) {
  return <Button {...props} variant={variant} title={label} aria-label={label} aria-pressed={pressed}
    className={`ui-icon-button ${className}`} />;
}
