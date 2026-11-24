import { useSyncExternalStore } from "react";
import { IconButton } from "./IconButton";

interface ToastMessage {
  id: number;
  message: string;
  tone: "info" | "ok" | "danger";
}

let nextId = 0;
let messages: ToastMessage[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const empty: ToastMessage[] = [];

function publish(next: ToastMessage[]) {
  messages = next;
  listeners.forEach((listener) => listener());
}

function dismiss(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  publish(messages.filter((item) => item.id !== id));
}

export function toast(message: string, tone: ToastMessage["tone"] = "info") {
  const id = ++nextId;
  publish([...messages, { id, message, tone }]);
  timers.set(id, setTimeout(() => dismiss(id), tone === "danger" ? 8000 : 5000));
  return () => dismiss(id);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function ToastContainer() {
  const items = useSyncExternalStore(subscribe, () => messages, () => empty);
  return (
    <div className="ui-toast-list">
      {items.map((item) => (
        <div key={item.id} className={`ui-toast ui-toast--${item.tone}`}>
          <span role={item.tone === "danger" ? "alert" : "status"}>{item.message}</span>
          <IconButton label="关闭通知" size="sm" onClick={() => dismiss(item.id)}>×</IconButton>
        </div>
      ))}
    </div>
  );
}
