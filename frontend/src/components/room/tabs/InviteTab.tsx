import { useState } from "react";
import { Cloud, Laptop, Link2 } from "lucide-react";
import { Link } from "react-router-dom";
import { AGENT_PRESETS, type CloudAgentPreset } from "../../../lib/agentPresets";
import { apiUrl } from "../../../lib/api";
import { apiJson } from "../../../lib/apiError";
import { CloudAgentConnectPanel } from "../../CloudAgentConnectPanel";
import { CopyButton } from "../../CopyButton";
import { PermissionsPanel, type PermissionsPanelProps } from "../../panels/PermissionsPanel";
import { Button } from "../../ui/Button";

export function InviteTab({ permissions }: { permissions: PermissionsPanelProps }) {
  const [cloud, setCloud] = useState<CloudAgentPreset | null>(null);
  const [sharing, setSharing] = useState(false);
  const [share, setShare] = useState("");
  const [error, setError] = useState("");
  const { roomId, room, isEncrypted, isOwner } = permissions;
  const path = `/agents?room=${encodeURIComponent(roomId)}`;

  async function shareRoom() {
    if (!isOwner || isEncrypted || sharing) return;
    setSharing(true);
    setError("");
    try {
      const data = await apiJson<{ share_url: string }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/share`, {
        method: "POST",
        body: JSON.stringify({ expires_hours: 72 }),
      });
      setShare(new URL(data.share_url, window.location.origin).href);
    } catch {
      setError("无法创建分享链接，请重试。");
    } finally {
      setSharing(false);
    }
  }

  return <div className="wb-tab-content">
    <section className="wb-panel-card">
      <h3><Link2 size={16} />邀请协作者</h3>
      {isOwner && isEncrypted ? <PermissionsPanel {...permissions} section="invite" />
        : <p>由房主生成入房邀请。你可以把房间地址发给已获授权的成员。</p>}
      <CopyButton text={`${window.location.origin}/rooms/${encodeURIComponent(roomId)}`} label="复制房间地址" />
    </section>
    <section className="wb-panel-card">
      <h3><Cloud size={16} />快速接入云端 Agent</h3>
      {AGENT_PRESETS.filter((preset) => preset.mode === "cloud-agent").map((preset) => <div key={preset.id} className="wb-quick-agent">
        <div><strong>{preset.title}</strong><small>手机可用</small></div>
        {isOwner ? <Button variant="secondary" size="sm" onClick={() => setCloud(cloud?.id === preset.id ? null : preset)}>
          {cloud?.id === preset.id ? "收起" : "接入"}
        </Button> : <Link to={`${path}&agent=${preset.id}`}>接入</Link>}
      </div>)}
      {cloud && <CloudAgentConnectPanel preset={cloud} compact roomId={roomId} roomName={room?.name} roomsLoaded
        onRoomChange={() => {}} hubOrigin={apiUrl("").replace(/\/$/u, "") || window.location.origin} onClose={() => setCloud(null)} />}
    </section>
    <Link className="wb-add" to={path}><Laptop size={16} />接入电脑端 Agent</Link>
    {!isEncrypted && isOwner && <section className="wb-panel-card">
      <h3>只读分享</h3>
      <p>分享链接 72 小时内有效。</p>
      <Button variant="secondary" size="sm" title="分享只读链接" loading={sharing} onClick={() => void shareRoom()}>生成只读链接</Button>
      {share && <div className="wb-actions"><CopyButton text={share} label="复制链接" /><a href={share} target="_blank" rel="noreferrer">打开预览</a></div>}
      {error && <p role="alert" className="wb-error">{error}</p>}
    </section>}
  </div>;
}
