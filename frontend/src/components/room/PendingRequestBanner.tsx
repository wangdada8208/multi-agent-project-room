import { LoaderCircle } from "lucide-react";
import type { PendingRequest } from "../../lib/domain/pendingRequests";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";

export interface PendingActions {
  busy: boolean;
  error: string;
  onDecide: (request: PendingRequest, approved: boolean) => void;
}

export function RequestActions({ request, busy, onDecide, minimal = false }: Pick<PendingActions, "busy" | "onDecide"> & { request: PendingRequest; minimal?: boolean }) {
  return <div className="wb-request-actions">
    <Button variant={minimal ? "ghost" : "secondary"} size="sm" disabled={busy} onClick={() => onDecide(request, false)}>拒绝</Button>
    <Button size="sm" disabled={busy} onClick={() => onDecide(request, true)}>批准入房</Button>
  </div>;
}

export function PendingRequestBanner({ isOwner, requests, syncing, onOpen, ...actions }: PendingActions & {
  isOwner: boolean;
  requests: readonly PendingRequest[];
  syncing?: string;
  onOpen: () => void;
}) {
  const request = requests[0];
  if (!isOwner || (!request && !syncing && !actions.error)) return null;
  return <section className={`wb-pending${syncing ? " wb-pending--syncing" : ""}`} aria-label="待审批申请">
    {syncing ? <><LoaderCircle size={22} className="wb-spin" /><strong role="status">正在让 {syncing} 看到加密聊天…</strong></> : request && <>
      <Avatar actor={request.kind === "agent" ? "cloud" : "human"} name={request.displayName} />
      <div className="wb-pending__label">
        <div><strong>{request.displayName}</strong>{requests.length > 1 ? ` 等 ${requests.length} 个申请` : " 申请加入房间"}</div>
        <small>{requests.length > 1 ? <button type="button" onClick={onOpen}>查看全部申请</button>
          : <>{request.kind === "agent" ? "云端助手" : "协作者"} · 通过邀请链接</>}</small>
      </div>
      <RequestActions {...actions} request={request} minimal />
    </>}
    {actions.error && <p className="wb-error" role="alert">{actions.error}</p>}
  </section>;
}
