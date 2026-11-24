import { useEffect, useReducer, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CloudAgentPreset } from "../../lib/agentPresets";
import { createRoomInvite, listRoomRedemptions, listRoomSeats, revokeRoomInvite } from "../../lib/localHelper";
import { cloudInviteReducer, rememberCloudInviteName } from "../../lib/domain/cloudInvite";
import { redemptionsKey, usePendingRequests } from "../room/usePendingRequests";
import { roomSeatsKey } from "../room/useRoomData";
import { xmtpEnvFromVite } from "../../lib/xmtpEnv";

const POLL_INTERVAL_MS = 4000;

export function useCloudInvite({ preset, roomId, hubOrigin, defaultApproval }: {
  preset: CloudAgentPreset; roomId: string; hubOrigin: string; defaultApproval: boolean;
}) {
  const [requiresApproval, setRequiresApproval] = useState(defaultApproval);
  const [copied, setCopied] = useState(false);
  const [flow, dispatch] = useReducer(cloudInviteReducer, { kind: "idle" });
  const roomPath = `/rooms/${encodeURIComponent(roomId)}`;
  const createInvite = useMutation({
    mutationFn: async (requireApproval: boolean) => {
      if ("token" in flow && flow.kind !== "approved" && flow.kind !== "expired" && flow.kind !== "denied") {
        await revokeRoomInvite(roomId, flow.token);
      }
      setCopied(false);
      dispatch({ type: "reset" });
      dispatch({ type: "generate" });
      return createRoomInvite(roomId, {
        expires_hours: 72,
        max_uses: 1,
        requires_approval: requireApproval,
        role: "member",
        proposed_scopes: [],
      });
    },
    onSuccess: (invite) => {
      rememberCloudInviteName(invite.token, preset.title);
      dispatch({
        type: "generated", token: invite.token,
        command: {
          hubOrigin,
          inviteUrl: `${window.location.origin}${roomPath}?invite=${encodeURIComponent(invite.token)}`,
          title: preset.title,
          env: xmtpEnvFromVite(import.meta.env.VITE_XMTP_ENV),
        },
      });
    },
    onError: () => dispatch({ type: "generationFailed" }),
  });
  const token = "token" in flow ? flow.token : undefined;
  const command = "command" in flow ? flow.command : "";
  const { query: pending, requests: allRequests, decide } = usePendingRequests(roomId, true, POLL_INTERVAL_MS);
  const seats = useQuery({
    queryKey: roomSeatsKey(roomId),
    queryFn: () => listRoomSeats(roomId),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const cloudSeats = seats.data?.filter((seat) =>
    seat.room_id === roomId && seat.group_status !== "removed" &&
    (seat.source === "invite" || seat.kind === "cloud-agent"),
  ) ?? [];
  const requests = token ? allRequests.filter((request) => request.kind === "agent" && request.token === token) : [];
  const redemptions = useQuery({
    queryKey: redemptionsKey(roomId),
    queryFn: () => listRoomRedemptions(roomId),
    enabled: Boolean(token && (cloudSeats.length || (flow.kind === "pending" && !requests.length))),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const seat = cloudSeats.find((item) => redemptions.data?.some((redemption) =>
    redemption.token === token && redemption.kind === "agent" && redemption.seat_id === item.seat_id &&
    (redemption.status === "approved" || redemption.status === "consumed"),
  ));
  const decision = decide.data?.token === token ? decide.data
    : redemptions.data?.find((request) => request.token === token && request.kind === "agent");
  const status = seat ? "approved"
    : decision?.status === "denied" ? "denied"
    : requests.length ? "pending" : null;
  useEffect(() => {
    if (token && status) dispatch({ type: status, token });
  }, [token, status]);

  const expiresAt = createInvite.data?.expires_at;
  useEffect(() => {
    if (!token || !expiresAt) return;
    const delay = Date.parse(expiresAt) - Date.now();
    if (delay > 2_147_483_647 || !Number.isFinite(delay)) return;
    const timer = window.setTimeout(() => dispatch({ type: "expired", token }), Math.max(0, delay));
    return () => window.clearTimeout(timer);
  }, [token, expiresAt]);

  return {
    requiresApproval, setRequiresApproval, flow, roomPath, command, copied, createInvite, requests, seat, decide,
    readError: pending.isError || seats.isError || redemptions.isError,
    onCopied: () => {
      setCopied(true);
      if (token) dispatch({ type: "copied", token });
    },
  };
}
