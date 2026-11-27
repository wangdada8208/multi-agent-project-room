import { useState } from "react";
import { PermissionsPanel, type PermissionsPanelProps } from "../../panels/PermissionsPanel";
import { Button } from "../../ui/Button";
import { ConfirmInline } from "../../ui/ConfirmInline";
import { EncryptionDetails, type EncryptionDetailsProps } from "../E2eeBadge";

export function RulesTab({ permissions, encryption, onDelete, onLeave, deleting, error }: {
  permissions: PermissionsPanelProps;
  encryption?: EncryptionDetailsProps;
  onDelete: () => void;
  onLeave: () => void;
  deleting: boolean;
  error: string;
}) {
  const [confirm, setConfirm] = useState<"leave" | "delete" | null>(null);
  return <div className="wb-tab-content">
    {encryption && <section className="wb-panel-card"><EncryptionDetails {...encryption} /></section>}
    <section className="wb-panel-card">
      <h3>房间房间规则</h3>
      <p>规则仅供协作参考。实际授权由每位主人的本机规则和确认决定。</p>
      {permissions.isOwner && <PermissionsPanel {...permissions} section="rules" />}
      {!permissions.isOwner && permissions.room?.settings_json == null && <p className="wb-muted">服务器暂未提供此房间的规则详情。</p>}
    </section>
    <section className="wb-panel-card">
      <h3>房间操作</h3>
      {error && <p className="wb-error" role="alert">{error}</p>}
      {confirm ? <ConfirmInline confirmLabel={confirm === "delete" ? "删除房间" : "离开房间"} loading={deleting}
        onCancel={() => setConfirm(null)} onConfirm={confirm === "delete" ? onDelete : onLeave}>
        {confirm === "delete" ? "删除后，所有成员将失去房间里的房间入口。此操作无法撤销。" : "返回房间并锁定此设备的加密身份。你的成员资格将保留。"}
      </ConfirmInline> : <div className="wb-actions">
        <Button variant="secondary" size="sm" onClick={() => setConfirm("leave")}>离开房间</Button>
        {permissions.isOwner && <Button variant="danger" size="sm" onClick={() => setConfirm("delete")}>删除房间</Button>}
      </div>}
    </section>
  </div>;
}
