import { useState } from "react";
import { filterVisibleInRoom } from "../../../lib/roomTabs";
import type { RoomTask } from "../../../types/chat";
import { ActivityPanel } from "../../panels/ActivityPanel";
import { TasksPanel } from "../../panels/TasksPanel";
import { OwnerApprovalPanel } from "../../panels/OwnerApprovalPanel";
import { DialoguePanel } from "../../panels/DialoguePanel";
import { FilesPanel } from "../../panels/FilesPanel";

const filters = [
  { id: "all", label: "全部" }, { id: "tasks", label: "任务" }, { id: "approvals", label: "审批" },
  { id: "dialogue", label: "Agent 对话" }, { id: "files", label: "文件" },
] as const;

export function ActivityTab({ roomId, encrypted, tasks, agents }: { roomId: string; encrypted: boolean; tasks: RoomTask[]; agents: string[] }) {
  const [selected, setSelected] = useState<(typeof filters)[number]["id"]>("all");
  const filter = filterVisibleInRoom(selected, encrypted) ? selected : "all";
  return <div className="wb-tab-content">
    <div className="wb-filters" aria-label="动态筛选">
      {filters.filter(({ id }) => filterVisibleInRoom(id, encrypted)).map(({ id, label }) => (
        <button type="button" key={id} aria-pressed={id === filter} onClick={() => setSelected(id)}>{label}</button>
      ))}
    </div>
    <ActivityPanel roomId={roomId} integrityOnly={filter !== "all"} />
    {filter === "tasks" && <TasksPanel tasks={tasks} />}
    {filter === "approvals" && <OwnerApprovalPanel roomId={roomId} />}
    {filter === "dialogue" && <DialoguePanel roomId={roomId} onlineAgents={agents} />}
    {filter === "files" && <FilesPanel roomId={roomId} />}
  </div>;
}
