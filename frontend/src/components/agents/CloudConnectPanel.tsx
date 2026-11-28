import { ArrowRight, Check, Circle, LockKeyhole, X } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useCloudInvite } from "../../hooks/agents/useCloudInvite";
import type { CloudAgentPreset } from "../../lib/agentPresets";
import type { Room } from "../../types/chat";
import { CopyButton } from "../CopyButton";
import { RequestActions } from "../room/PendingRequestBanner";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Switch } from "../ui/Switch";
import { CommandBlock } from "./CommandBlock";
import "./Agents.css";

interface CloudConnectPanelProps {
  preset: CloudAgentPreset;
  roomId: string;
  roomName?: string;
  rooms?: readonly Room[];
  roomsLoaded: boolean;
  onRoomChange?: (roomId: string) => void;
  hubOrigin: string;
  onClose: () => void;
  compact?: boolean;
  defaultApproval?: boolean;
}

export function CloudConnectPanel({ preset, roomId, roomName, rooms, roomsLoaded, onRoomChange, hubOrigin, onClose,
  compact = false, defaultApproval = true }: CloudConnectPanelProps) {
  return <section className={`wb-cloud-connect${compact ? " wb-cloud-connect--compact" : ""}`} aria-label={`${preset.title} 接入面板`}>
    <header className="wb-connect-head">
      <Avatar actor="cloud" name={preset.title} size="md" />
      <h3>接入 {preset.title}<small>{roomName ? `接入到「${roomName}」` : "生成一次性邀请"}</small></h3>
      <IconButton label="关闭接入面板" size="sm" onClick={onClose}><X size={16} /><span className="sr-only">关闭云端接入</span></IconButton>
    </header>
    {rooms && onRoomChange && <label className="wb-connect-select">
      目标房间
      <select className="input" value={roomId} onChange={(event) => onRoomChange(event.target.value)}>
        <option value="">选择要加入的房间…</option>
        {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
      </select>
    </label>}
    {roomId ? <CloudSteps key={`${roomId}:${preset.id}`} {...{ preset, roomId, hubOrigin, defaultApproval }} />
      : <p className="wb-connect-empty">{roomsLoaded && !rooms?.length ? <>请先<a href="#agent-create-room">创建房间</a>，然后生成云端接入指令。</>
        : roomsLoaded ? "请选择你管理的房间。" : "正在读取房间…"}</p>}
  </section>;
}

function CloudSteps({ preset, roomId, hubOrigin, defaultApproval }: Parameters<typeof useCloudInvite>[0]) {
  const invite = useCloudInvite({ preset, roomId, hubOrigin, defaultApproval });
  const { command, decide, flow, roomPath, seat } = invite;
  const [editing, setEditing] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const lockSettings = invite.createInvite.isPending || Boolean(invite.requests.length) || Boolean(seat);
  const factsId = useId();
  const commandId = useId();

  return <div className="wb-connect-steps">
    <section className="wb-connect-step">
      <h4><span>1</span>设置邀请</h4>
      <div className="wb-invite-summary">
        <span>{invite.requiresApproval ? "需我批准" : "无需批准"} · 72 小时 · 仅限 1 次</span>
        <Button variant="secondary" size="sm" aria-expanded={editing} aria-controls={factsId} onClick={() => setEditing(!editing)}>{editing ? "收起" : "修改"}</Button>
      </div>
      <div id={factsId} className="wb-invite-options" data-open={editing}>
        <Switch checked={invite.requiresApproval} onCheckedChange={invite.setRequiresApproval} disabled={lockSettings} label="入房需要我批准" />
        <ul><li>72 小时内有效</li><li>仅可使用 1 次</li><li>只能进入所选房间</li></ul>
      </div>
      <Button variant={command ? "secondary" : "primary"} size="sm" disabled={lockSettings}
        loading={invite.createInvite.isPending} onClick={() => invite.createInvite.mutate(invite.requiresApproval)}>
        {command ? "重新生成" : "生成接入指令"}
      </Button>
      {invite.createInvite.error && <p className="wb-error" role="alert">{invite.createInvite.error.message}</p>}
    </section>
    <section className="wb-connect-step">
      <h4><span>2</span>复制接入指令</h4>
      {command ? <>
        <div className="wb-command-summary">
          <span>完整指令可直接发给 {preset.title}</span>
          <Button size="sm" variant="secondary" aria-expanded={showCommand} aria-controls={commandId} onClick={() => setShowCommand(!showCommand)}>{showCommand ? "收起" : "查看"}</Button>
        </div>
        <div id={commandId} className="wb-command-details" data-open={showCommand}>
          <CommandBlock command={command} onCopied={invite.onCopied} />
        </div>
        <CopyButton text={command} label={invite.copied ? `已复制，发给 ${preset.title}` : "复制接入指令"} onCopied={invite.onCopied} />
        <details className="wb-connect-more">
          <summary>高级选项与说明</summary>
          {preset.id === "grok" ? <p>让 Grok Bot 在云电脑后台持续运行。Webhook Routine 唤醒参数为 <code>{"--wake-url <你的Webhook地址> --wake-key-env GROK_WEBHOOK_KEY"}</code>。</p>
            : <p>在 Meta Muse Secure VM 的终端执行。若开启出站权限审查，请放行 {hubOrigin} 与 XMTP 网络。</p>}
          <p>群消息写入 <code>~/.mapr-bot/mailbox/inbound.jsonl</code>。将回复保存到 <code>{"~/.mapr-bot/mailbox/outbox/<任意名>.txt"}</code> 后会加密发送。</p>
        </details>
      </> : <p className="wb-muted">生成邀请后，即可复制指令。</p>}
    </section>
    <section className="wb-connect-step">
      <h4><span>3</span>入房审批</h4>
      <ol className="wb-timeline" aria-live="polite">
        <li data-state={command ? "done" : "idle"}><span>{command ? <Check size={12} /> : <Circle size={12} />}</span>{command ? "邀请已生成" : "等待生成邀请"}</li>
        <li data-state={seat || flow.kind === "pending" ? "done" : command ? "waiting" : "idle"}>
          <span>{seat || flow.kind === "pending" ? <Check size={12} /> : <Circle size={12} />}</span>
          <div>{seat || flow.kind === "pending" ? "已连接并提交入房申请" : `等待 ${preset.title} 运行指令…`}
            {command && flow.kind !== "denied" && flow.kind !== "expired" && !seat && !invite.requests.length && <small>通常 1–2 分钟，本页会自动刷新</small>}
          </div>
        </li>
      </ol>
      {flow.kind === "denied" && <p className="wb-muted">已拒绝入房申请。</p>}
      {flow.kind === "expired" && <p className="wb-error">邀请已过期，请重新生成。</p>}
      {invite.requests.map((request) => <div className="wb-connect-request" key={request.id}>
        <strong>{preset.title} 请求加入</strong><code>{request.redeemer_address ?? request.id}</code>
        <RequestActions request={request} busy={decide.isPending} onDecide={(_, approved) => decide.mutate({ id: request.id, approved })} />
      </div>)}
      {invite.readError && <p className="wb-error" role="status">暂时无法读取入驻状态。请确认你是目标房间的房主。</p>}
      {decide.error && <p className="wb-error" role="alert">{decide.error.message}</p>}
      {seat && <div className="wb-connect-request wb-connect-request--approved" role="status">
        <strong>{seat.agent_display_name} 已入驻当前房间</strong>
        {seat.group_status !== "added" && <p><LockKeyhole size={13} />已接入。打开房间后，房主设备会让它看到加密聊天。</p>}
        <Link className="ui-button ui-button--primary ui-button--sm" to={roomPath}>{seat.group_status === "added" ? "进入房间" : "进入房间并完成加密连接"} <ArrowRight size={14} /></Link>
      </div>}
    </section>
  </div>;
}
