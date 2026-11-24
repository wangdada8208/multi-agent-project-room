import type { ComponentPropsWithoutRef } from "react";

export function Tag({ tone = "neutral", className = "", ...props }: ComponentPropsWithoutRef<"span"> & {
  tone?: "neutral" | "cloud" | "local" | "ok" | "warn" | "owner";
}) {
  return <span {...props} className={`ui-tag ui-tag--${tone} ${className}`} />;
}
