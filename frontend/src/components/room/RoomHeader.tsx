import type { ComponentProps } from "react";
import { ArrowLeft, Bell, BellRing, PanelRight, Search, UserRoundPlus, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { AvatarStack } from "../ui/AvatarStack";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Tag } from "../ui/Tag";
import { E2eeBadge } from "./E2eeBadge";

export function RoomHeader({ name, template, encryption, avatars, pending, inspector, notifications, searchOpen, onSearch, onNotify, onInvite, onMembers, onInspector }: {
  name: string;
  template?: string;
  encryption?: ComponentProps<typeof E2eeBadge>;
  avatars: ComponentProps<typeof AvatarStack>["avatars"];
  pending: number;
  inspector: boolean;
  notifications: boolean;
  searchOpen: boolean;
  onSearch: () => void;
  onNotify: () => void;
  onInvite: () => void;
  onMembers: () => void;
  onInspector: () => void;
}) {
  return <header className="wb-room-head">
    <Link className="wb-room-back wb-mobile" to="/home" aria-label="返回房间"><ArrowLeft size={19} /></Link>
    <div className="wb-room-head__title">
      <h1 title={name}>{name}</h1>
      {template && <Tag className="wb-desktop">{template}</Tag>}
      {encryption && <E2eeBadge {...encryption} />}
    </div>
    <div className="wb-room-head__actions">
      <button type="button" className="wb-head-members wb-desktop" aria-label="打开成员" onClick={onMembers}>
        {avatars.length ? <AvatarStack avatars={avatars} max={5} /> : <Users size={17} />}
      </button>
      <IconButton label={encryption ? "本机搜索加密消息" : "搜索消息"} pressed={searchOpen} onClick={onSearch}><Search size={17} /></IconButton>
      <IconButton className="wb-desktop" label={notifications ? "Agent 回复通知已开启" : "开启 Agent 回复通知"} pressed={notifications} onClick={onNotify}>
        {notifications ? <BellRing size={17} /> : <Bell size={17} />}
      </IconButton>
      <Button className="wb-desktop" variant="secondary" size="sm" onClick={onInvite}><UserRoundPlus size={15} />邀请</Button>
      <IconButton className="wb-desktop" label="切换侧栏" pressed={inspector} onClick={onInspector}><PanelRight size={17} /></IconButton>
      <div className="wb-head-members-mobile wb-mobile">
        <IconButton label="打开成员" onClick={onMembers}><Users size={19} /></IconButton>
        {pending > 0 && <span className="workbench-count" aria-label={`${pending} 个待审批`}>{pending}</span>}
      </div>
    </div>
  </header>;
}
