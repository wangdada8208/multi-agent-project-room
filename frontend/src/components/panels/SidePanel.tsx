import { useState, type ReactNode } from "react";
import { PermissionsPanel } from "./PermissionsPanel";

type TabId = "members" | "tasks" | "dialogue" | "files" | "team" | "permissions";

interface SidePanelProps {
  members: ReactNode;
  tasks: ReactNode;
  dialogue: ReactNode;
  files: ReactNode;
  team: ReactNode;
  roomId: string;
}

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "members", label: "成员", icon: "👥" },
  { id: "tasks", label: "任务", icon: "📋" },
  { id: "dialogue", label: "对话", icon: "💬" },
  { id: "files", label: "文件", icon: "📎" },
  { id: "team", label: "团队", icon: "⚙️" },
  { id: "permissions", label: "权限", icon: "🔒" },
];

export function SidePanel({ members, tasks, dialogue, files, team, roomId }: SidePanelProps) {
  const [active, setActive] = useState<TabId>("members");
  const content: Partial<Record<TabId, ReactNode>> = { members, tasks, dialogue, files, team };

  return (
    <aside className="side-panel">
      <nav className="side-panel__tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`side-panel__tab ${active === tab.id ? "side-panel__tab--active" : ""}`}
            onClick={() => setActive(tab.id)}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
      <div className="side-panel__content">
        {active === "permissions" ? <PermissionsPanel roomId={roomId} /> : content[active]}
      </div>
    </aside>
  );
}
