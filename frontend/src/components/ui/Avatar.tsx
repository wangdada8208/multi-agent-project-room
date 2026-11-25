import type { ActorKind } from "../../lib/domain/displayMessages";
import { AgentMark } from "./AgentMark";

const actorLabel: Record<ActorKind, string> = { me: "我", human: "人类", cloud: "云端 Agent", local: "电脑端 Agent" };
const presenceLabel = { online: "在线", paused: "已暂停", pending: "待入群" };

export interface AvatarProps {
  actor: ActorKind;
  name: string;
  size?: "sm" | "md" | "lg";
  presence?: keyof typeof presenceLabel;
  src?: string;
}

export function Avatar({ actor, name, size = "md", presence, src }: AvatarProps) {
  const label = [name, actorLabel[actor], presence ? presenceLabel[presence] : ""].filter(Boolean).join(" · ");
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span role="img" aria-label={label} title={label} className={`ui-avatar ui-avatar--${actor} ui-avatar--${size}`}>
      {src ? (
        <img src={src} alt="" />
      ) : actor === "cloud" || actor === "local" ? (
        <span className="ui-avatar__brand" aria-hidden="true"><AgentMark name={name} actor={actor} /></span>
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
      {presence && <span className={`ui-avatar__presence ui-avatar__presence--${presence}`} aria-hidden="true" />}
    </span>
  );
}
