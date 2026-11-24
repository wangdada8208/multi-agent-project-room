import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cloudInviteName } from "../../lib/domain/cloudInvite";
import { pendingRequestsFrom } from "../../lib/domain/pendingRequests";
import { approveRedemption, denyRedemption, listRoomRedemptions } from "../../lib/localHelper";
import { roomPermissionsKey, roomSeatsKey } from "./useRoomData";

export const redemptionsKey = (roomId: string) => ["rooms", roomId, "redemptions"];

export function usePendingRequests(roomId: string, isOwner: boolean, refetchInterval = 4000) {
  const client = useQueryClient();
  const queryKey = [...redemptionsKey(roomId), "pending"];
  const query = useQuery({
    queryKey,
    queryFn: () => listRoomRedemptions(roomId, "pending"),
    enabled: Boolean(roomId && isOwner),
    refetchInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (input: { id: string; approved: boolean; options?: Parameters<typeof approveRedemption>[2]; reason?: string }) =>
      input.approved
        ? approveRedemption(roomId, input.id, ...(input.options ? [input.options] : []))
        : denyRedemption(roomId, input.id, ...(input.reason ? [input.reason] : [])),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: redemptionsKey(roomId) }),
        client.invalidateQueries({ queryKey: roomSeatsKey(roomId) }),
        client.invalidateQueries({ queryKey: roomPermissionsKey(roomId) }),
      ]);
    },
  });
  const requests = pendingRequestsFrom(query.data ?? [], (token) => cloudInviteName(token));
  return { query, requests, decide };
}
