import { useRef, useState } from "react";
import type { PendingRequest } from "../../lib/domain/pendingRequests";
import type { usePendingRequests } from "./usePendingRequests";

export function useRoomRequestDecisions(decide: ReturnType<typeof usePendingRequests>["decide"], addresses: Record<string, string>, encrypted: boolean) {
  const [approved, setApproved] = useState<PendingRequest[]>([]);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const groupAddresses = new Set(Object.values(addresses));
  const syncing = approved.find(({ redeemer_address }) => redeemer_address && !groupAddresses.has(redeemer_address.toLowerCase()));
  const joined = approved.filter(({ redeemer_address }) => redeemer_address && groupAddresses.has(redeemer_address.toLowerCase()));

  async function onDecide(request: PendingRequest, allow: boolean) {
    if (busy.current) return;
    busy.current = true;
    setError("");
    try {
      await decide.mutateAsync({ id: request.id, approved: allow });
      if (allow && encrypted && request.redeemer_address) setApproved((previous) => [...previous, request]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新入房申请失败，请重试。");
    } finally {
      busy.current = false;
    }
  }

  return { onDecide, error, busy: decide.isPending, syncing: syncing?.displayName, joined };
}
