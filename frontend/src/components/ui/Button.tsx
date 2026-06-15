import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variants: Record<ButtonVariant, string> = {
  primary: "border-blue-500 bg-blue-600 text-white hover:bg-blue-500",
  ghost: "border-slate-700 bg-slate-950 text-slate-100 hover:bg-slate-900",
  danger: "border-red-500 bg-red-600 text-white hover:bg-red-500",
};

export function Button({ className, variant = "primary", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "rounded-xl border px-4 py-2 font-bold transition disabled:cursor-not-allowed disabled:opacity-55",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
