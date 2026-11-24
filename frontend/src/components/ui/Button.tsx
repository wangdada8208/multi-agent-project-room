import type { ComponentPropsWithoutRef } from "react";

export type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
};

export function Button({ variant = "primary", size = "md", loading, disabled, className = "", children, type = "button", ...props }: ButtonProps) {
  return (
    <button {...props} type={type} disabled={disabled || loading} aria-busy={loading}
      className={`ui-button ui-button--${variant} ui-button--${size} ${className}`}>
      {loading && <span className="ui-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
