import { AtSign } from "lucide-react";
import type { MentionCandidate } from "../../lib/domain/mentions";
import { Avatar } from "../ui/Avatar";

const groups = [
  { label: "快捷", matches: (item: MentionCandidate) => item.actor === "shortcut" },
  { label: "Agent", matches: (item: MentionCandidate) => item.actor === "cloud" || item.actor === "local" },
  { label: "人类", matches: (item: MentionCandidate) => item.actor === "human" },
];

export function MentionPicker({ id, items, activeId, onChoose }: {
  id: string;
  items: readonly MentionCandidate[];
  activeId?: string;
  onChoose: (item: MentionCandidate) => void;
}) {
  return (
    <div className="wb-mentions" id={id} role="listbox" aria-label="提及候选">
      {groups.map(({ label, matches }) => {
        const group = items.filter(matches);
        return group.length > 0 && (
          <div key={label} role="group" aria-label={label}>
            <h6>{label}</h6>
            {group.map((item) => (
              <button key={item.id} id={`${id}-${item.id}`} type="button" role="option"
                aria-selected={activeId === item.id} disabled={item.disabled}
                onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(item)}>
                {item.actor === "shortcut" ? <AtSign size={19} /> : <Avatar actor={item.actor} name={item.name} size="sm" />}
                <span>{item.name}{item.actor === "shortcut" ? " Agent" : ""}</span>
                {item.actor !== "shortcut" && item.actor !== "human" && <small>{item.disabled ? "已暂停" : item.status ?? "可提及"}</small>}
              </button>
            ))}
          </div>
        );
      })}
      <footer>↑↓ 选择 · Enter / Tab 插入 · Esc 关闭</footer>
    </div>
  );
}
