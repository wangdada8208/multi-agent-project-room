import { useEffect, useRef } from "react";

export interface GlobalShortcutActions {
  toggleCommandPalette: () => void;
  focusRoomSearch: () => void;
  openCreateRoom: () => void;
  closeTopLayer: () => boolean;
  showShortcutHelp: () => void;
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.contentEditable === "true") return true;
  const editable = target.closest("[contenteditable]");
  if (editable && editable.getAttribute("contenteditable") !== "false") return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function useGlobalShortcuts(actions: GlobalShortcutActions) {
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        actionsRef.current.toggleCommandPalette();
        return;
      }
      if (event.key === "Escape") {
        if (actionsRef.current.closeTopLayer()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableShortcutTarget(event.target)) return;

      if (event.key === "/") {
        event.preventDefault();
        actionsRef.current.focusRoomSearch();
      } else if (key === "n") {
        event.preventDefault();
        actionsRef.current.openCreateRoom();
      } else if (event.key === "?") {
        event.preventDefault();
        actionsRef.current.showShortcutHelp();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
