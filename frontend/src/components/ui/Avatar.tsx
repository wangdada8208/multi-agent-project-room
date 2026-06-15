import type { HTMLAttributes } from "react";
import { Bot, User } from "lucide-react";
import { cn } from "../../lib/utils";

interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  type?: "human" | "agent" | "system";
}

export function Avatar({ className, type = "human", ...props }: AvatarProps) {
  const Icon = type === "agent" ? Bot : User;

  return (
    <div
      className={cn(
        "grid size-9 place-items-center rounded-full border border-slate-700 bg-slate-950 text-slate-200",
        type === "agent" && "border-violet-500 text-violet-200",
        type === "system" && "border-amber-500 text-amber-200",
        className,
      )}
      {...props}
    >
      <Icon size={18} />
    </div>
  );
}
