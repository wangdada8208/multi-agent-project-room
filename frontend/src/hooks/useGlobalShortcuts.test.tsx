// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEditableShortcutTarget, useGlobalShortcuts, type GlobalShortcutActions } from "./useGlobalShortcuts";

function Harness({ actions }: { actions: GlobalShortcutActions }) {
  useGlobalShortcuts(actions);
  return null;
}

describe("useGlobalShortcuts", () => {
  let host: HTMLDivElement;
  let root: Root;
  let actions: { [K in keyof GlobalShortcutActions]: ReturnType<typeof vi.fn<GlobalShortcutActions[K]>> };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    actions = {
      toggleCommandPalette: vi.fn<GlobalShortcutActions["toggleCommandPalette"]>(),
      focusRoomSearch: vi.fn<GlobalShortcutActions["focusRoomSearch"]>(),
      openCreateRoom: vi.fn<GlobalShortcutActions["openCreateRoom"]>(),
      closeTopLayer: vi.fn<GlobalShortcutActions["closeTopLayer"]>().mockReturnValue(true),
      showShortcutHelp: vi.fn<GlobalShortcutActions["showShortcutHelp"]>(),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Harness actions={actions} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it("triggers all five real shortcuts from the workspace", () => {
    const ctrlK = press("k", { ctrlKey: true });
    expect(actions.toggleCommandPalette).toHaveBeenCalledTimes(1);
    expect(ctrlK.defaultPrevented).toBe(true);

    press("/", {}, document.body);
    expect(actions.focusRoomSearch).toHaveBeenCalledTimes(1);

    press("n", {}, document.body);
    expect(actions.openCreateRoom).toHaveBeenCalledTimes(1);

    press("?", {}, document.body);
    expect(actions.showShortcutHelp).toHaveBeenCalledTimes(1);

    const escape = press("Escape", {}, document.body);
    expect(actions.closeTopLayer).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
  });

  it("treats Meta+K the same as Ctrl+K", () => {
    press("k", { metaKey: true }, document.body);
    expect(actions.toggleCommandPalette).toHaveBeenCalledTimes(1);
  });

  it("does not fire single-key shortcuts while typing in inputs, textareas, selects, or editable content", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(input, textarea, select, editable);

    expect(isEditableShortcutTarget(input)).toBe(true);
    press("/", {}, input);
    press("n", {}, textarea);
    press("?", {}, select);
    press("/", {}, editable);

    expect(actions.focusRoomSearch).not.toHaveBeenCalled();
    expect(actions.openCreateRoom).not.toHaveBeenCalled();
    expect(actions.showShortcutHelp).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+K available inside an input but ignores modified single-letter keys", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);

    press("k", { ctrlKey: true }, input);
    press("n", { ctrlKey: true }, document.body);
    press("/", { altKey: true }, document.body);
    press("?", { metaKey: true }, document.body);

    expect(actions.toggleCommandPalette).toHaveBeenCalledTimes(1);
    expect(actions.openCreateRoom).not.toHaveBeenCalled();
    expect(actions.focusRoomSearch).not.toHaveBeenCalled();
    expect(actions.showShortcutHelp).not.toHaveBeenCalled();
  });

  it("lets Escape continue to local dialogs when no palette layer is open", () => {
    actions.closeTopLayer.mockReturnValue(false);
    const event = press("Escape", {}, document.body);
    expect(event.defaultPrevented).toBe(false);
  });
});
