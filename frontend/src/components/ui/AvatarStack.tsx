import { Avatar, type AvatarProps } from "./Avatar";

export function AvatarStack({ avatars, max = 4 }: { avatars: readonly (AvatarProps & { id: string })[]; max?: number }) {
  const visible = avatars.slice(0, Math.max(0, max));
  const remaining = avatars.length - visible.length;
  return (
    <div className="ui-avatar-stack">
      {visible.map(({ id, ...avatar }) => <Avatar key={id} {...avatar} />)}
      {remaining > 0 && <span className="ui-avatar-stack__overflow" aria-label={`另有 ${remaining} 人`}>+{remaining}</span>}
    </div>
  );
}
