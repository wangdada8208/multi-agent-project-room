import { Check, LockKeyhole, ShieldCheck } from "lucide-react";
import { useId } from "react";
import { CopyButton } from "../CopyButton";

export interface EncryptionDetailsProps {
  ready: boolean;
  groupId?: string | null;
  address?: string;
}

export function EncryptionDetails({ ready, groupId, address }: EncryptionDetailsProps) {
  return <div className="wb-privacy">
    <h4><ShieldCheck size={17} />{ready ? "端到端加密已保护" : "端到端加密"}</h4>
    <ul>
      <li><Check size={14} />只有加密群成员可以读取对话。</li>
      <li><Check size={14} />协作室服务器负责房间与席位管理，无法读取聊天正文。</li>
      <li><Check size={14} />新成员由房主的设备加入加密群。</li>
    </ul>
    <details><summary>技术详情</summary>
      <dl>
        <dt>协议</dt><dd>XMTP · MLS 群组</dd>
        <dt>群 ID</dt><dd>{groupId || "尚未绑定"}</dd>
        <dt>我的加密身份</dt><dd>{address || "尚未解锁"} {address && <CopyButton text={address} label="复制身份" />}</dd>
        <dt>正文存储</dt><dd>XMTP 网络仅保存密文</dd>
      </dl>
    </details>
  </div>;
}

export function E2eeBadge({ humans, agents, ...details }: EncryptionDetailsProps & { humans: number; agents: number }) {
  const id = useId();
  return <div className="wb-encryption">
    <button type="button" popoverTarget={id} className="wb-encryption__badge">
      <LockKeyhole size={12} />
      <span className="wb-desktop">{details.ready ? "端到端加密已保护" : "端到端加密"}</span>
      <span className="wb-mobile">端到端加密&nbsp; <i>· {humans} 人 · {agents} 个 Agent</i></span>
    </button>
    <div popover="auto" id={id} role="region" aria-label="加密说明" className="wb-encryption__popover">
      <EncryptionDetails {...details} />
    </div>
  </div>;
}
