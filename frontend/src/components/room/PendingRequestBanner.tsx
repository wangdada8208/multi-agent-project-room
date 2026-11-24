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
  return <section className={`wb-pending${syncing ? " wb-pending--syncing" : ""}`} aria-label="待批准申请">
    {syncing ? <><LoaderCircle size={22} className="wb-spin" /><strong role="status">正在把 {syncing} 加入加密群…</strong></> : request && <>
      <Avatar actor={request.kind === "agent" ? "cloud" : "human"} name={request.displayName} />
      <div className="wb-pending__label">
        <div><strong>{request.displayName}</strong>{requests.length > 1 ? ` 等 ${requests.length} 个申请` : " 请求加入房间"}</div>
        <small>{requests.length > 1 ? <button type="button" onClick={onOpen}>查看全部申请</button>
          : <>{request.kind === "agent" ? "云端 Agent" : "协作者"} · 通过你生成的邀请链接</>}</small>
      </div>
      <RequestActions {...actions} request={request} minimal />
    </>}
    {actions.error && <p className="wb-error" role="alert">{actions.error}</p>}
  </section>;
}
