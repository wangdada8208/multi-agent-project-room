import { Link } from "react-router-dom";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import type { RoomStatusView } from "../../lib/domain/roomStatusView";
import { CopyButton } from "../CopyButton";
import { XmtpUnlock } from "../XmtpUnlock";
import { Button } from "../ui/Button";

const labels = {
  awaitingApproval: ["入群申请已提交，等待房主批准", "批准后，房主页面会自动把你加入加密群。"],
  awaitingAdd: ["加密身份已登记", "房主在线时会自动把你加入加密群（约 5 秒）。"],
  notInGroup: ["当前加密身份尚未加入此房间加密群", "请向房主索取邀请链接，或将你的加密地址发给房主。"],
};

export function RoomStatusCard({ view, address, roomId, accepted, binding, canBind, onUnlock, onBind, onReconnect, onRetryInvite, starters, onStarter }: {
  view: RoomStatusView;
  address: string;
  roomId: string;
  accepted: boolean;
  binding: boolean;
  canBind: boolean;
  onUnlock: (key: string) => void;
  onBind: () => void;
  onReconnect: () => void;
  onRetryInvite?: () => void;
  starters: string[];
  onStarter?: (text: string) => void;
}) {
  switch (view.kind) {
    case "locked":
      return <div className="wb-unlock">
        {accepted && <div className="wb-notice">房间权限已开通。解锁此设备的加密身份后，系统会为你登记入群。</div>}
        <XmtpUnlock onUnlock={onUnlock} />
      </div>;
    case "connecting":
      return <section className="wb-status wb-skeleton" role="status">
        <strong>正在连接加密对话…</strong><i /><i /><i />
      </section>;
    case "enableGroup":
    case "waitForGroup":
      return <section className="wb-status" role={binding ? "status" : undefined}>
        <LockKeyhole size={24} />
        <strong>{view.kind === "enableGroup"
          ? binding ? "正在开启端到端加密…" : "这个房间还没启用加密对话"
          : "等房主打开房间启用加密对话"}</strong>
        {view.kind === "enableGroup" && (binding ? (
          <p>首次开启通常需要几秒，完成后即可直接发消息。</p>
        ) : <>
          <p>启用后，此设备会自动把待入群的成员加入加密群。</p>
          <div className="wb-actions">
            <Button size="sm" loading={binding} disabled={!canBind} onClick={onBind}>立即启用</Button>
            <Link to={`/setup/${encodeURIComponent(roomId)}`}>打开完整配置向导</Link>
          </div>
        </>)}
      </section>;
    case "awaitingApproval":
    case "awaitingAdd":
    case "notInGroup":
      return <section className="wb-status">
        <LockKeyhole size={24} />
        <strong>{labels[view.kind][0]}</strong>
        <p>{labels[view.kind][1]}</p>
        {view.kind === "notInGroup" && <Button size="sm" variant="secondary" onClick={onReconnect}>重新检查入群</Button>}
        {address && <details><summary>我的加密身份</summary><code>{address}</code> <CopyButton text={address} label="复制我的加密地址" /></details>}
      </section>;
    case "inviteError":
    case "error": {
      const bindFailed = view.kind === "error" && view.reason === "bind";
      return <section className="wb-status" role="alert">
        <strong>{view.kind === "error" ? bindFailed ? "端到端加密开启失败" : "加密连接中断" : "邀请链接核销失败"}</strong>
        <p>{view.message}</p>
        <div className="wb-actions">
          {view.kind === "inviteError" && onRetryInvite && <Button size="sm" onClick={onRetryInvite}>重试核销</Button>}
          {view.kind === "error" && bindFailed
            ? <Button size="sm" loading={binding} disabled={!canBind} onClick={onBind}>重试开启</Button>
            : <Button variant="secondary" size="sm" onClick={onReconnect}>{view.kind === "error" ? "重试连接" : "重新连接"}</Button>}
          {address && <CopyButton text={address} label="复制我的加密地址" />}
        </div>
      </section>;
    }
    case "ready":
      return <section className="wb-status">
        <ShieldCheck size={24} /><strong>端到端加密对话已就绪</strong>
        <p>发送第一条消息，或打开「邀请」接入 Agent。</p>
        {onStarter && <div className="wb-actions">{starters.map((text) => <Button key={text} variant="secondary" size="sm" onClick={() => onStarter(text)}>{text}</Button>)}</div>}
      </section>;
  }
}
