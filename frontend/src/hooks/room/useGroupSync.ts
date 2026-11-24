import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listRoomInvites, listRoomRedemptions, listRoomSeats, markSeatGroupAdded } from "../../lib/localHelper";
import { collectGroupSyncAddresses, syncPendingSeatsToGroup, syncRedeemedInvitesToGroup } from "../../lib/seatGroupSync";
import type { XmtpMemberLike } from "../../lib/roomIdentity";
import type { RoomXmtpClient } from "./useXmtpSession";
import { redemptionsKey } from "./usePendingRequests";
import { roomSeatsKey } from "./useRoomData";

export function useGroupSync({ client, groupId, roomId, userId, role, phase, permissionMembers, restartListener, updateInboxMap, refetchSeats }: {
  client: RoomXmtpClient | null;
  groupId?: string | null;
  roomId: string;
  userId?: string;
  role?: string;
  phase: "ready" | "notInGroup" | null;
  permissionMembers?: { xmtp_address?: string | null; user_type?: string }[];
  restartListener: () => void;
  updateInboxMap: (members: XmtpMemberLike[]) => void;
  refetchSeats: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const membersRef = useRef(permissionMembers);
  useEffect(() => { membersRef.current = permissionMembers; }, [permissionMembers]);

  useEffect(() => {
    if (!client || !groupId || !userId || !role || !phase) return;
    let cancelled = false;
    let running = false;
    const isOwner = role === "owner";
    const staleTime = 4500;

    const tick = async () => {
      if (cancelled || running || document.visibilityState === "hidden") return;
      running = true;
      try {
        if (phase === "notInGroup") {
          await client.conversations.syncAll();
          if (await client.conversations.getConversationById(groupId) && !cancelled) restartListener();
          return;
        }
        const group = await client.conversations.getConversationById(groupId);
        if (!group || cancelled) return;
        await group.sync();
        const members = typeof group.members === "function" ? await group.members() : [];
        if (cancelled) return;
        updateInboxMap(members);

        const seatOutcome = await syncPendingSeatsToGroup({
          client, roomId, groupId, currentUserId: userId, isRoomOwner: isOwner,
          deps: {
            listSeats: (id) => queryClient.fetchQuery({ queryKey: roomSeatsKey(id), queryFn: () => listRoomSeats(id), staleTime })
              .then((seats) => cancelled ? [] : seats),
            markAdded: markSeatGroupAdded,
          },
          isActive: () => !cancelled,
        });
        if (cancelled) return;
        if (seatOutcome.reported.length) void refetchSeats();

        let collaborators = 0;
        if (isOwner) {
          const result = await syncRedeemedInvitesToGroup({
            client, roomId, groupId,
            listAddresses: async (id) => {
              const [invites, redemptions] = await Promise.all([
                queryClient.fetchQuery({ queryKey: ["rooms", id, "invites"], queryFn: () => listRoomInvites(id), staleTime }).catch(() => []),
                queryClient.fetchQuery({ queryKey: redemptionsKey(id), queryFn: () => listRoomRedemptions(id), staleTime }),
              ]);
              if (cancelled) return [];
              return collectGroupSyncAddresses({ invites, redemptions, members: membersRef.current });
            },
            isActive: () => !cancelled,
          });
          collaborators = result.addedAddresses.length;
        }
        if (!cancelled && (seatOutcome.added.length || collaborators)) {
          await group.sync();
          const updated = typeof group.members === "function" ? await group.members() : [];
          if (!cancelled) updateInboxMap(updated);
        }
      } catch {
        // The next tick retries synchronization.
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = window.setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [client, groupId, roomId, userId, role, phase, restartListener, updateInboxMap, refetchSeats, queryClient]);
}
