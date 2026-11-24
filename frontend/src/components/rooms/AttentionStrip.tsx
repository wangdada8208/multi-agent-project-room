import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { PendingRequest } from "../../lib/domain/pendingRequests";
import type { Room } from "../../types/chat";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { formatRelativeTime } from "./templateMeta";

export interface AttentionItem {
  room: Room;
  request: PendingRequest;
}

export function AttentionStrip({ items }: { items: readonly AttentionItem[] }) {
  const navigate = useNavigate();
  if (items.length === 0) return null;

  const first = items[0];
  const isAgent = first.request.kind === "agent";
  const when = formatRelativeTime(first.request.created_at);
  const extra = items.length > 1 ? ` · 另有 ${items.length - 1} 条待处理` : "";

  return (
    <div className="wb-attention" role="status">
      <Avatar
        actor={isAgent ? "cloud" : "human"}
        name={first.request.displayName}
        size="md"
      />
      <div className="wb-attention__text">
        <strong>{first.request.displayName}</strong> 正在等你批准加入「{first.room.name}」
        <small>
          {isAgent ? "云端 Agent" : "协作者"}
          {when ? ` · ${when}` : ""}
          {" · 通过你的邀请链接提交"}
          {extra}
        </small>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => navigate(`/rooms/${encodeURIComponent(first.room.id)}?panel=members`)}
      >
        去处理
        <ArrowRight size={14} strokeWidth={1.9} />
      </Button>
    </div>
  );
}
