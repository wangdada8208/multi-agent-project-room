import { useRef, useState } from "react";
import { pauseRoomSeat, removeRoomSeat, resumeRoomSeat, type HubSeatView } from "../../lib/localHelper";
import { removeAddressFromXmtpGroup, type XmtpClientLike } from "../../lib/seatGroupSync";

export async function removeSeatFromRoom(seat: HubSeatView, client?: XmtpClientLike | null, groupId?: string | null) {
  if (seat.group_status !== "pending") {
    if (!client || !groupId) throw new Error("请先在聊天区解锁你的加密身份，才能把该席位移出加密群");
    try {
      await removeAddressFromXmtpGroup(client, groupId, seat.xmtp_address);
    } catch {
      throw new Error("无法把该席位地址移出加密群（移出他人地址通常需要房主客户端执行）。席位记录未删除——等待房主客户端移出加密群。");
    }
  }
  await removeRoomSeat(seat.room_id, seat.seat_id);
}

export function useSeatActions(client?: XmtpClientLike | null, groupId?: string | null, onChanged?: () => void) {
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState("");
  const busy = useRef(false);

  async function handleRemoveSeat(seat: HubSeatView) {
    if (busy.current) return;
    busy.current = true;
    setRemovingId(seat.seat_id);
    setRemoveError("");
    try {
      await removeSeatFromRoom(seat, client, groupId);
      onChanged?.();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "移出席位失败");
    } finally {
      busy.current = false;
      setRemovingId(null);
    }
  }

  async function handleSetPaused(seat: HubSeatView, paused: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPausingId(seat.seat_id);
    setPauseError("");
    try {
      await (paused ? pauseRoomSeat : resumeRoomSeat)(seat.room_id, seat.seat_id);
      onChanged?.();
    } catch (err) {
      setPauseError(err instanceof Error ? err.message : "更新席位状态失败");
    } finally {
      busy.current = false;
      setPausingId(null);
    }
  }

  return { removingId, removeError, pausingId, pauseError, handleRemoveSeat, handleSetPaused };
}
