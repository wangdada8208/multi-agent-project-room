import { Bot, FilePlus2, Folder, Hand, Keyboard, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Room } from "../types/chat";
import "./CommandPalette.css";

type PaletteActionId = "create-room" | "agents" | "approvals" | "shortcuts";

type PaletteEntry =
  | { kind: "room"; id: string; label: string; hint: string }
  | { kind: "action"; id: PaletteActionId; label: string; hint: string };

const ACTION_ENTRIES: readonly Extract<PaletteEntry, { kind: "action" }>[] = [
  { kind: "action", id: "create-room", label: "新建房间", hint: "n" },
  { kind: "action", id: "agents", label: "去接入助手", hint: "/agents" },
  { kind: "action", id: "approvals", label: "去待审批", hint: "成员面板" },
  { kind: "action", id: "shortcuts", label: "查看快捷键", hint: "?" },
];

function entryMatches(entry: PaletteEntry, query: string): boolean {
  if (!query) return true;
  return `${entry.label} ${entry.hint}`.toLowerCase().includes(query);
}

function EntryIcon({ entry }: { entry: PaletteEntry }) {
  if (entry.kind === "room") return <Folder size={16} strokeWidth={1.8} />;
  if (entry.id === "create-room") return <FilePlus2 size={16} strokeWidth={1.8} />;
  if (entry.id === "agents") return <Bot size={16} strokeWidth={1.8} />;
  if (entry.id === "approvals") return <Hand size={16} strokeWidth={1.8} />;
  return <Keyboard size={16} strokeWidth={1.8} />;
}

export function CommandPalette({ open, rooms, pendingRoomId, onClose, onCreateRoom, onShowShortcuts }: {
  open: boolean;
  rooms: readonly Room[];
  pendingRoomId?: string;
  onClose: () => void;
  onCreateRoom: () => void;
  onShowShortcuts: () => void;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const normalizedQuery = query.trim().toLowerCase();

  const entries = useMemo(() => {
    const roomEntries: PaletteEntry[] = rooms.map((room) => ({
      kind: "room",
      id: room.id,
      label: room.name,
      hint: room.description || "进入房间",
    }));
    return [...ACTION_ENTRIES, ...roomEntries]
      .filter((entry) => entryMatches(entry, normalizedQuery))
      .slice(0, 10);
  }, [rooms, normalizedQuery]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [normalizedQuery]);

  if (!open) return null;

  function execute(entry: PaletteEntry) {
    onClose();
    if (entry.kind === "room") {
      navigate(`/rooms/${encodeURIComponent(entry.id)}`);
      return;
    }
    if (entry.id === "create-room") {
      onCreateRoom();
    } else if (entry.id === "agents") {
      navigate("/agents");
    } else if (entry.id === "approvals") {
      navigate(pendingRoomId ? `/rooms/${encodeURIComponent(pendingRoomId)}?panel=members` : "/home");
    } else if (entry.id === "shortcuts") {
      onShowShortcuts();
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => entries.length ? (index + 1) % entries.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => entries.length ? (index - 1 + entries.length) % entries.length : 0);
    } else if (event.key === "Enter" && entries[active]) {
      event.preventDefault();
      execute(entries[active]);
    }
  }

  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="command-palette__search">
          <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="搜索房间或输入命令…"
            aria-label="搜索房间或命令"
          />
          <button type="button" aria-label="关闭命令面板" onClick={onClose}><X size={15} strokeWidth={1.9} /></button>
        </div>
        <div className="command-palette__list" role="listbox" aria-label="可用命令">
          {entries.map((entry, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? "command-palette__item command-palette__item--active" : "command-palette__item"}
              key={`${entry.kind}:${entry.id}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => execute(entry)}
            >
              <span className="command-palette__icon" aria-hidden="true"><EntryIcon entry={entry} /></span>
              <span className="command-palette__copy"><strong>{entry.label}</strong><small>{entry.hint}</small></span>
              {entry.kind === "action" && <kbd>{entry.id === "create-room" ? "n" : entry.id === "shortcuts" ? "?" : "Enter"}</kbd>}
            </button>
          ))}
          {entries.length === 0 && <p className="command-palette__empty">没有找到匹配的房间或命令。</p>}
        </div>
      </section>
    </div>
  );
}

const SHORTCUTS = [
  { keys: "⌘ / Ctrl + K", description: "打开命令面板" },
  { keys: "/", description: "聚焦房间搜索" },
  { keys: "n", description: "新建房间" },
  { keys: "Esc", description: "关闭当前弹层" },
  { keys: "?", description: "打开快捷键帮助" },
] as const;

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="shortcut-help" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
        <header>
          <div>
            <h2 id="shortcut-help-title">快捷键</h2>
            <p>手不离键盘，也能完成常用操作。</p>
          </div>
          <button type="button" aria-label="关闭快捷键帮助" onClick={onClose}><X size={16} strokeWidth={1.9} /></button>
        </header>
        <ul>
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.keys}>
              <kbd>{shortcut.keys}</kbd>
              <span>{shortcut.description}</span>
            </li>
          ))}
        </ul>
        <p className="shortcut-help__note">输入框聚焦时，单键 /、n、? 不会误触。</p>
      </section>
    </div>
  );
}
