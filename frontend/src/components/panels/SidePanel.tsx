import { useState, type ReactNode } from "react";

type TabId = "members" | "tasks" | "dialogue" | "team";

interface SidePanelProps {
  members: ReactNode;
  tasks: ReactNode;
  dialogue: ReactNode;
  team: ReactNode;
}

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "members", label: "成员", icon: "👥" },
  { id: "tasks", label: "任务", icon: "📋" },
  { id: "dialogue", label: "对话", icon: "💬" },
  { id: "team", label: "团队", icon: "⚙️" },
];

export function SidePanel({ members, tasks, dialogue, team }: SidePanelProps) {
  const [active, setActive] = useState<TabId>("members");

  const content = { members, tasks, dialogue, team };

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
        {content[active]}
      </div>
    </aside>
  );
}
