import { useEffect, useReducer, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import type { CloudAgentPreset } from "../lib/agentPresets";
import {
  createRoomInvite,
  listRoomRedemptions,
  listRoomSeats,
} from "../lib/localHelper";
import { cloudInviteReducer, rememberCloudInviteName } from "../lib/domain/cloudInvite";
import { redemptionsKey, usePendingRequests } from "../hooks/room/usePendingRequests";
import { roomSeatsKey } from "../hooks/room/useRoomData";
import { xmtpEnvFromVite } from "../lib/xmtpEnv";
import type { Room } from "../types/chat";
import { CopyButton } from "./CopyButton";

const POLL_INTERVAL_MS = 4000;

interface CloudAgentConnectPanelProps {
  preset: CloudAgentPreset;
  roomId: string;
  roomName?: string;
  rooms?: readonly Room[];
  roomsLoaded: boolean;
  onRoomChange: (roomId: string) => void;
  hubOrigin: string;
  onClose: () => void;
}

export function CloudAgentConnectPanel({
  preset,
  roomId,
  roomName,
  rooms,
  roomsLoaded,
  onRoomChange,
  hubOrigin,
  onClose,
}: CloudAgentConnectPanelProps) {
  return (
    <section className="setup-card cloud-agent-connect" aria-label={`${preset.title} 云端接入`}>
      <div className="cloud-agent-connect__header">
        <h3>{preset.title} 云端接入</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>关闭云端接入</button>
      </div>
      {rooms ? (
        <label className="cloud-agent-connect__field">
          目标协作房间
          <select className="input" value={roomId} onChange={(event) => onRoomChange(event.target.value)}>
            <option value="">选择要加入的房间…</option>
            {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
          </select>
        </label>
      ) : (
        <p>目标协作房间：{roomName ?? roomId}</p>
      )}
      {roomId ? (
        <CloudInvite key={`${roomId}:${preset.id}`} preset={preset} roomId={roomId} hubOrigin={hubOrigin} />
      ) : roomsLoaded && rooms?.length === 0 ? (
        <p>请先<a href="#agent-create-room">创建协作房间</a>，然后生成云端接入指令。</p>
      ) : (
        <p>{roomsLoaded ? "请选择你管理的协作房间。" : "正在读取协作房间…"}</p>
      )}
    </section>
  );
}

function CloudInvite({ preset, roomId, hubOrigin }: Pick<CloudAgentConnectPanelProps, "preset" | "roomId" | "hubOrigin">) {
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [flow, dispatch] = useReducer(cloudInviteReducer, { kind: "idle" });
  const roomPath = `/rooms/${encodeURIComponent(roomId)}`;
  const createInvite = useMutation({
    mutationFn: (requireApproval: boolean) => createRoomInvite(roomId, {
      expires_hours: 72,
      max_uses: 1,
      requires_approval: requireApproval,
      role: "member",
      proposed_scopes: [],
    }),
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
    retry: false,
  });
  const cloudSeats = seats.data?.filter((seat) =>
    seat.room_id === roomId && seat.group_status !== "removed" &&
    (seat.source === "invite" || seat.kind === "cloud-agent"),
  ) ?? [];
  const redemptions = useQuery({
    queryKey: redemptionsKey(roomId),
    queryFn: () => listRoomRedemptions(roomId),
    enabled: Boolean(token && cloudSeats.length),
    refetchInterval: POLL_INTERVAL_MS,
    retry: false,
  });
  const seat = cloudSeats.find((item) => redemptions.data?.some((redemption) =>
    redemption.token === token && redemption.kind === "agent" && redemption.seat_id === item.seat_id &&
    (redemption.status === "approved" || redemption.status === "consumed"),
  ));
  const requests = token ? allRequests.filter((request) => request.kind === "agent" && request.token === token) : [];
  const decision = decide.data;
  const status = seat ? "approved"
    : decision?.token === token && decision?.status === "denied" ? "denied"
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

  return (
    <>
      <label className="cloud-agent-connect__field">
        <input
          type="checkbox"
          checked={requiresApproval}
          disabled={createInvite.isPending || Boolean(token)}
          onChange={(event) => setRequiresApproval(event.target.checked)}
        />
        需房主批准后入群
      </label>
      {!token && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={createInvite.isPending}
          onClick={() => {
            dispatch({ type: "generate" });
            createInvite.mutate(requiresApproval);
          }}
        >
          {createInvite.isPending ? "正在生成接入指令…" : "生成接入指令"}
        </button>
      )}
      {createInvite.error && <p className="error-text" role="alert">{createInvite.error.message}</p>}
      {command && (
        <div className="cloud-agent-connect__instructions">
          <strong>直接复制发给 {preset.title} 的完整接入指令</strong>
          <div className="code-block">
            <CopyButton text={command} label="复制接入指令" onCopied={() => { if (token) dispatch({ type: "copied", token }); }} />
            <code>{command}</code>
          </div>
          <p>此邀请有效期为 72 小时，可使用一次。仅把指令发给你要接入的 {preset.title}。</p>
          {preset.id === "grok" ? (
            <p>
              让 Grok Bot 在云电脑的后台持续运行该命令。使用 Webhook Routine 实时唤醒时，可追加
              {" "}<code>{"--wake-url <你的Webhook地址> --wake-key-env GROK_WEBHOOK_KEY"}</code>。
            </p>
          ) : (
            <p>在 Meta Muse Secure VM 的终端执行。若开启了出站权限审查，请放行 {hubOrigin} 与 XMTP 网络。</p>
          )}
          <p>
            群消息写入 <code>~/.mapr-bot/mailbox/inbound.jsonl</code>。将回复保存为
            {" "}<code>{"~/.mapr-bot/mailbox/outbox/<任意名>.txt"}</code> 会自动加密发送到群中。
          </p>
          {!seat && <p>进入 <Link to={roomPath}>目标房间</Link> 解锁加密身份，激活加密群并同步席位。</p>}
        </div>
      )}
      {(pending.isError || seats.isError || redemptions.isError) && (
        <p className="error-text" role="status">暂时无法读取入驻状态。请确认你是目标房间的房主。</p>
      )}
      {requests.length > 0 && (
        <div className="cloud-agent-connect__instructions" aria-live="polite">
          <strong>待审批的云端入房申请</strong>
          {requests.map((request) => (
            <div className="cloud-agent-connect__header" key={request.id}>
              <code>{request.redeemer_address ?? request.id}</code>
              <div className="cloud-agent-connect__header">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: request.id, approved: true })}
                >
                  批准入房
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: request.id, approved: false })}
                >
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {decide.error && <p className="error-text" role="alert">{decide.error.message}</p>}
      {seat && (
        <div className="setup-info" role="status">
          <p>{seat.agent_display_name} 已入驻当前房间。</p>
          <Link className="btn btn-primary btn-sm" to={roomPath}>
            {seat.group_status === "added" ? "进入房间" : "进入房间自动拉入加密群"}
            <ArrowRight size={14} />
          </Link>
        </div>
      )}
    </>
  );
}
