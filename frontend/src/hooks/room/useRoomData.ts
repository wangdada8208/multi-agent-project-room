import { useQuery } from "@tanstack/react-query";
import { ApiError, apiJson } from "../../lib/apiError";
import { listRoomSeats } from "../../lib/localHelper";
import type { RoomPermissionMember as HubPermissionMember } from "../../hubContracts.generated";
import type { Room } from "../../types/chat";

export type RoomPermissionMember = Pick<HubPermissionMember,
  "user_id" | "role" | "username" | "display_name" | "avatar_url" | "user_type"
> & Partial<Pick<HubPermissionMember, "xmtp_address">>;

interface RoomPermissions {
  members?: RoomPermissionMember[];
}

const roomErrors: Record<number, string> = {
  403: "你没有这个房间的访问权限。",
  404: "房间不存在或已删除。",
  410: "邀请已过期，请联系房主获取新的邀请。",
};

export const roomPermissionsKey = (roomId: string) => ["rooms", roomId, "permissions"];
export const roomSeatsKey = (roomId: string) => ["rooms", roomId, "seats"];

export function useRoomData(roomId: string, userId: string | undefined, enabled: boolean) {
  const roomQuery = useQuery({
    queryKey: ["rooms", roomId],
    queryFn: async () => (await apiJson<{ room: Room }>(`/api/v1/rooms/${roomId}`)).room,
    enabled,
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 3,
  });
  const permissionsQuery = useQuery({
    queryKey: roomPermissionsKey(roomId),
    queryFn: () => apiJson<RoomPermissions>(`/api/v1/rooms/${roomId}/permissions`),
    enabled,
    retry: false,
  });
  const myRoomRole = userId ? permissionsQuery.data?.members?.find((member) => member.user_id === userId)?.role : undefined;
  const roomSeatsQuery = useQuery({
    queryKey: roomSeatsKey(roomId),
    queryFn: () => listRoomSeats(roomId),
    enabled,
    refetchInterval: myRoomRole === "owner" ? 5000 : 15000,
    refetchIntervalInBackground: false,
  });
  const status = roomQuery.error instanceof ApiError ? roomQuery.error.status : undefined;
  const roomError = roomQuery.isError ? {
    status,
    message: (status && roomErrors[status]) || "房间不存在或没有访问权限。",
  } : null;
  return {
    roomQuery, permissionsQuery, roomSeatsQuery, myRoomRole, roomError,
    isObserver: myRoomRole === "viewer" || myRoomRole === "observer",
  };
}
