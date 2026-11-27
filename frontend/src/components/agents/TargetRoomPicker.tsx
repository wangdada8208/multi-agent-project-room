import { useState } from "react";
import { Folder, Plus } from "lucide-react";
import type { useTargetRoom } from "../../hooks/agents/useTargetRoom";
import { Button } from "../ui/Button";

type Target = ReturnType<typeof useTargetRoom>;

export function TargetRoomPicker({ target }: { target: Target }) {
  return <label className="wb-target">
    <Folder size={16} />接入到
    <select aria-label="目标房间" value={target.roomId} onChange={(event) => target.selectRoom(event.target.value)} disabled={!target.rooms.length}>
      {target.rooms.length ? target.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)
        : <option value="">{target.roomsLoaded ? "暂无房间" : "正在读取房间…"}</option>}
    </select>
  </label>;
}

export function CreateTargetRoom({ target }: { target: Target }) {
  const [name, setName] = useState("");
  if (target.error) return <p role="alert" className="wb-error">暂时无法读取房间，请刷新重试。</p>;
  if (target.rooms.length || !target.roomsLoaded) return null;

  return <form id="agent-create-room" className="wb-create-room" onSubmit={(event) => {
    event.preventDefault();
    if (name.trim() && !target.create.isPending) target.create.mutate(name.trim(), { onSuccess: () => setName("") });
  }}>
    <strong>先创建一个房间</strong>
    <p>创建后即可邀请智能体加入。</p>
    <div>
      <input className="input" value={name} aria-label="房间名称" placeholder="例如：产品迭代协作间" onChange={(event) => setName(event.target.value)} />
      <Button type="submit" loading={target.create.isPending} disabled={!name.trim()}><Plus size={15} />先创建一个房间</Button>
    </div>
    {target.create.error && <p className="wb-error" role="alert">{target.create.error.message}</p>}
  </form>;
}
