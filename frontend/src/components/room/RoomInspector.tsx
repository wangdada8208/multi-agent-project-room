import type { ReactNode } from "react";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { Drawer } from "../ui/Drawer";
import { Sheet } from "../ui/Sheet";

const tabs = [
  { id: "members", label: "成员" }, { id: "invite", label: "邀请" },
  { id: "rules", label: "规则" }, { id: "activity", label: "动态" },
] as const;
export type InspectorTab = (typeof tabs)[number]["id"];

export function inspectorTab(value: string | null): InspectorTab | undefined {
  return tabs.find(({ id }) => id === value)?.id;
}

export function RoomInspector({ open, tab, pending, children, onTab, onClose }: {
  open: boolean;
  tab: InspectorTab;
  pending: number;
  children: ReactNode;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
}) {
  const width = useViewportWidth();
  if (!open) return null;

  const content = <>
    <nav className="wb-inspector__tabs" aria-label="房间检查器">
      {tabs.map(({ id, label }) => (
        <button key={id} type="button" aria-pressed={tab === id} onClick={() => onTab(id)}>
          {label}{id === "members" && pending > 0 && <span className="workbench-count">{pending}</span>}
        </button>
      ))}
    </nav>
    <div className="wb-inspector__body">{children}</div>
  </>;

  if (width >= 1024) return <aside className="wb-inspector" aria-label="房间检查器">{content}</aside>;
  const Panel = width < 768 ? Sheet : Drawer;
  return <Panel open onClose={onClose} title="房间检查器" className="wb-inspector-dialog">
    {content}
  </Panel>;
}
