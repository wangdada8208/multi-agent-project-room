import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, RoomTask, RoomTaskPatch, TaskProgressEvent } from "../types/chat";

const harness = vi.hoisted(() => ({ cleanups: [] as (() => void)[], fetch: vi.fn() }));
// Invoke real socket handlers with mocked hook lifecycle; no DOM dependency.
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  const hooks = {
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useEffect: (effect: () => (() => void)) => { harness.cleanups.push(effect()); },
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useDebugValue: () => {},
  };
  return { ...original, ...hooks, default: { ...original, ...hooks } };
});
vi.mock("../stores/chatStore", async (importOriginal) => {
  const original = await importOriginal<typeof import("../stores/chatStore")>();
  const actual = original.useChatStore;
  const select = (selector: (state: ReturnType<typeof actual.getState>) => unknown) => selector(actual.getState());
  return { ...original, useChatStore: Object.assign(select, actual) };
});
vi.mock("../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: null }) } }));
vi.mock("../lib/api", () => ({ apiFetch: harness.fetch, websocketUrl: (path: string) => "ws://synthetic" + path }));
vi.mock("../lib/xmtpSend", () => ({ deliverOutgoing: vi.fn() }));

import { useChatStore } from "../stores/chatStore";
import { useWebSocket } from "./useWebSocket";

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  handlers = new Map<string, ((event: { data: string; code?: number }) => void)[]>();
  close = vi.fn();
  send = vi.fn();
  constructor(_url: string) { FakeSocket.all.push(this); }
  addEventListener(type: string, handler: (event: { data: string; code?: number }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  emit(payload: unknown) { this.handlers.get("message")?.forEach((handler) => handler({ data: JSON.stringify(payload) })); }
  open() { this.handlers.get("open")?.forEach((handler) => handler({ data: "" })); }
  disconnect() { this.handlers.get("close")?.forEach((handler) => handler({ data: "", code: 1006 })); }
}

const task = (id = "t1", room = "r1", seq?: number): RoomTask => ({
  id, room_id: room, query: "Keep the query", source_agent: "hub", target_agent: "bot",
  status: "working", created_at: "2026-10-11T10:00:00Z", ...(seq === undefined ? {} : { event_seq: seq }),
});
const progress = (seq = 3, percent = 40): TaskProgressEvent => ({
  type: "task_progress", task_id: "t1", phase: "running", percent, event_seq: seq,
});
const store = () => useChatStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-test-token" });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  FakeSocket.all = [];
  harness.fetch.mockReset();
  harness.fetch.mockResolvedValue({ ok: false });
  useChatStore.setState({ tasks: [], messages: [], participants: [], typingUsers: [] });
});
afterEach(() => {
  harness.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("task patches", () => {
  it("preserves details on partial updates and sorts new complete tasks", () => {
    store().setTasks([task()]);
    store().upsertTask({ id: "t1", room_id: "r1", status: "completed", event_seq: 2 });
    expect(store().tasks[0]).toMatchObject({ ...task(), status: "completed", event_seq: 2 });
    store().upsertTask({ ...task("t2"), created_at: "2026-10-11T11:00:00Z" });
    expect(store().tasks.map((item) => item.id)).toEqual(["t2", "t1"]);
  });
  it("rejects old/equal state changes and unsequenced downgrade", () => {
    store().setTasks([task("t1", "r1", 4)]);
    store().upsertTask({ id: "t1", status: "failed", event_seq: 3 });
    store().upsertTask({ id: "t1", status: "failed", event_seq: 4 });
    store().upsertTask({ id: "t1", status: "failed" });
    expect(store().tasks[0].status).toBe("working");
    store().upsertTask({ id: "t1", status: "completed", event_seq: 5 });
    expect(store().tasks[0].status).toBe("completed");
  });
  it("allows legacy updates, strips unknown fields and rejects invalid sequences", () => {
    store().setTasks([task()]);
    store().upsertTask({ id: "t1", status: "input_required", token: "secret", owner_user_id: "other", query: undefined } as RoomTaskPatch);
    expect(store().tasks[0]).toMatchObject({ status: "input_required", query: "Keep the query" });
    expect(store().tasks[0]).not.toHaveProperty("token");
    expect(store().tasks[0]).not.toHaveProperty("owner_user_id");
    store().upsertTask({ id: "t1", status: "canceled", event_seq: -1 });
    expect(store().tasks[0].status).toBe("input_required");
  });
  it("cannot move an existing task to a different room", () => {
    store().setTasks([task(), task("t2", "r2")]);
    store().upsertTask({ id: "t1", room_id: "r2", status: "failed", event_seq: 9 });
    store().upsertTask({ id: "t2", room_id: "r2", status: "completed", event_seq: 3 });
    expect(store().tasks.find((item) => item.id === "t1")).toMatchObject({ room_id: "r1", status: "working" });
    expect(store().tasks.find((item) => item.id === "t2")?.status).toBe("completed");
  });
  it("keeps recent state/progress when an older polling response arrives", () => {
    store().setTasks([task("t1", "r1", 3)]);
    store().updateTaskProgress(progress(4), "r1");
    store().setTasks([task("t1", "r1", 2)]);
    expect(store().tasks[0]).toMatchObject({ event_seq: 3, progress: { event_seq: 4, percent: 40 } });
    store().upsertTask({ id: "t1", status: "submitted", event_seq: 3 });
    expect(store().tasks[0].status).toBe("working");
  });
});

describe("socket task consumption", () => {
  it("merges patches and consumes/deduplicates progress", () => {
    store().setTasks([task("t1", "r1", 2)]);
    useWebSocket("r1");
    const ws = FakeSocket.all[0];
    ws.emit({ type: "task_update", task: { id: "t1", room_id: "r1", status: "working", event_seq: 5 } });
    ws.emit(progress(4));
    const first = store().tasks[0];
    ws.emit(progress(4, 99));
    ws.emit(progress(3, 20));
    expect(store().tasks[0]).toBe(first);
    expect(first).toMatchObject({ query: "Keep the query", event_seq: 5, progress: { percent: 40, event_seq: 4 } });
    expect(harness.fetch).not.toHaveBeenCalled();
  });
  it("isolates rooms and discards events from disposed sockets", () => {
    store().setTasks([task(), task("t2", "r2")]);
    useWebSocket("r1");
    const ws = FakeSocket.all[0];
    ws.emit({ type: "task_update", task: { id: "t2", room_id: "r2", status: "failed", event_seq: 9 } });
    ws.emit({ ...progress(), task_id: "t2" });
    expect(store().tasks.find((item) => item.id === "t2")).toEqual(task("t2", "r2"));
    harness.cleanups.splice(0).forEach((cleanup) => cleanup());
    useWebSocket("r2");
    ws.emit({ type: "task_update", task: { id: "t1", room_id: "r1", status: "failed", event_seq: 9 } });
    expect(store().tasks.find((item) => item.id === "t1")?.status).toBe("working");
  });
  it("ignores repeated/old events across reconnects", () => {
    store().setTasks([task("t1", "r1", 2)]);
    useWebSocket("r1");
    FakeSocket.all[0].emit(progress());
    FakeSocket.all[0].disconnect();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    const ws = FakeSocket.all[1];
    ws.emit(progress());
    ws.emit({ type: "task_update", task: { id: "t1", room_id: "r1", status: "submitted", event_seq: 1 } });
    expect(store().tasks[0]).toMatchObject({ status: "working", progress: { event_seq: 3 } });
  });
  it("hydrates unknown partial tasks and keeps a newer patch over the HTTP snapshot", async () => {
    harness.fetch.mockResolvedValue({ ok: true, json: async () => ({ task: task("t1", "r1", 1) }) });
    useWebSocket("r1");
    const ws = FakeSocket.all[0];
    ws.emit({ type: "task_update", task: { id: "t1", room_id: "r1", status: "input_required", event_seq: 4 } });
    ws.emit(progress(3));
    await vi.waitFor(() => expect(store().tasks[0]?.event_seq).toBe(4));
    expect(store().tasks[0]).toMatchObject({ status: "input_required", query: "Keep the query", progress: { percent: 40 } });
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed progress without changing old tasks", () => {
    store().setTasks([task()]);
    useWebSocket("r1");
    for (const frame of [{ ...progress(), percent: 101 }, { ...progress(), phase: "secret" }, { ...progress(), event_seq: -1 }, null]) FakeSocket.all[0].emit(frame);
    expect(store().tasks[0]).toEqual(task());
  });
  it("never fetches malformed/other-room progress, and ignores late hydration after switching rooms", async () => {
    store().setTasks([task("t2", "r2")]);
    let resolve!: (value: unknown) => void;
    harness.fetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    useWebSocket("r1");
    const ws = FakeSocket.all[0];
    ws.emit({ ...progress(), task_id: "t2" });
    ws.emit({ ...progress(), percent: 101 });
    ws.emit({ type: "task_update", task: { id: "t1", room_id: "r1", status: "failed", event_seq: -1 } });
    expect(harness.fetch).not.toHaveBeenCalled();
    ws.emit({ type: "task_update", task: { id: "t1", room_id: "r1", status: "working", event_seq: 2 } });
    harness.cleanups.splice(0).forEach((cleanup) => cleanup());
    useWebSocket("r2");
    resolve({ ok: true, json: async () => ({ task: task("t1", "r1", 1) }) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store().tasks).toEqual([task("t2", "r2")]);
  });

});

const message = (id: string, room = "r1", seq?: number, time = "2026-10-11T10:00:00Z"): ChatMessage => ({
  id, room_id: room, room_seq: seq, sender_id: "human1", sender_type: "human", content: id, msg_type: "text", created_at: time,
});
const participant = (id = "human1") => ({ sender_id: id, sender_name: id, sender_type: "human" as const,
  joined_at: "2026-10-11T10:00:00Z", last_seen_at: "2026-10-11T10:00:00Z" });
const response = (messages: ChatMessage[], extra = {}) => ({ ok: true, json: async () => ({ messages, ...extra }) });

describe("cross-Hub chat and presence", () => {
  it("deduplicates replay and sorts by sequence despite clock skew", () => {
    store().addMessage(message("second", "r1", 2, "2026-10-11T09:00:00Z"));
    store().setMessages([message("first", "r1", 1), message("second", "r1", 2)], "r1");
    store().addMessage(message("first", "r1", 1));
    expect(store().messages.map((item) => item.id)).toEqual(["first", "second"]);
  });
  it("preserves live messages and room caches during scoped history merge", () => {
    store().addMessage(message("live", "r1", 3)); store().addMessage(message("other", "r2", 1));
    store().setMessages([message("history", "r1", 1), message("foreign", "r2", 2)], "r1");
    expect(store().messages.map((item) => item.id).sort()).toEqual(["history", "live", "other"]);
  });
  it("orders legacy messages and only enriches duplicate sequence metadata", () => {
    store().addMessage(message("b", "r1", undefined, "2026-10-11T11:00:00Z")); store().addMessage(message("a"));
    store().addMessage({ ...message("a", "r1", 1), content: "changed" }); store().addMessage(message("a", "r2", 9));
    expect(store().messages.map((item) => item.id)).toEqual(["a", "b"]);
    expect(store().messages[0]).toMatchObject({ content: "a", room_id: "r1", room_seq: 1 });
  });
  it("isolates message frames by room", () => {
    useWebSocket("r1", "hub"); FakeSocket.all[0].emit({ type: "message", message: message("foreign", "r2") });
    FakeSocket.all[0].emit({ type: "message", message: message("local") });
    expect(store().messages.map((item) => item.id)).toEqual(["local"]);
  });
  it("replaces and deduplicates snapshots without flickering on tab offline hints", () => {
    useWebSocket("r1", "hub"); const socket = FakeSocket.all[0];
    socket.emit({ type: "presence_snapshot", participants: [participant(), participant(), participant("human2")] });
    socket.emit({ type: "user_offline", participant: participant() }); expect(store().participants).toHaveLength(2);
    socket.emit({ type: "presence_snapshot", participants: [participant()] });
    socket.emit({ type: "presence_snapshot", participants: [participant(), participant()] });
    expect(store().participants).toEqual([participant()]);
  });
  it("handles legacy deltas and ignores foreign snapshots or old room sockets", () => {
    useWebSocket("r1", "hub"); const socket = FakeSocket.all[0];
    socket.emit({ type: "user_online", participant: participant() }); socket.emit({ type: "user_online", participant: participant() });
    socket.emit({ type: "presence_snapshot", room_id: "r2", participants: [] }); expect(store().participants).toHaveLength(1);
    socket.emit({ type: "user_offline", participant: participant() }); expect(store().participants).toHaveLength(0);
    harness.cleanups.splice(0).forEach((cleanup) => cleanup()); useWebSocket("r2", "hub");
    socket.emit({ type: "presence_snapshot", participants: [participant()] }); expect(store().participants).toHaveLength(0);
  });
  it("paginates reconnect catch-up and deduplicates overlapping WS replay", async () => {
    store().addMessage(message("before", "r1", 1)); useWebSocket("r1", "hub"); FakeSocket.all[0].open();
    expect(harness.fetch).not.toHaveBeenCalled(); FakeSocket.all[0].disconnect(); vi.advanceTimersByTime(1000);
    harness.fetch.mockResolvedValueOnce(response([message("before", "r1", 1), message("middle", "r1", 2)], { next_cursor: 2, has_more: true }))
      .mockResolvedValueOnce(response([message("last", "r1", 3), message("foreign", "r2", 4)], { next_cursor: 3, has_more: false }));
    FakeSocket.all[1].open(); FakeSocket.all[1].emit({ type: "message", message: message("middle", "r1", 2) });
    await vi.waitFor(() => expect(store().messages).toHaveLength(3));
    expect(store().messages.map((item) => item.id)).toEqual(["before", "middle", "last"]);
    expect(harness.fetch.mock.calls[0][0]).toContain("after_seq=0"); expect(harness.fetch.mock.calls[0][0]).toContain("after=");
    expect(harness.fetch.mock.calls[1][0]).toContain("after_seq=2");
  });
  it("retries failed catch-up on subsequent reconnect with legacy responses", async () => {
    useWebSocket("r1", "hub"); FakeSocket.all[0].disconnect(); vi.advanceTimersByTime(1000); FakeSocket.all[1].open();
    await vi.waitFor(() => expect(harness.fetch).toHaveBeenCalledTimes(1));
    FakeSocket.all[1].disconnect(); vi.advanceTimersByTime(1000); harness.fetch.mockResolvedValueOnce(response([message("legacy")]));
    FakeSocket.all[2].open(); await vi.waitFor(() => expect(store().messages.map((item) => item.id)).toEqual(["legacy"]));
  });
  it("drops HTTP catch-up resolved after switching rooms", async () => {
    let resolve!: (value: unknown) => void; harness.fetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    useWebSocket("r1", "hub"); FakeSocket.all[0].disconnect(); vi.advanceTimersByTime(1000); FakeSocket.all[1].open();
    harness.cleanups.splice(0).forEach((cleanup) => cleanup()); useWebSocket("r2", "hub"); resolve(response([message("stale")]));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); expect(store().messages).toHaveLength(0);
  });
  it("keeps XMTP plaintext local during reconnect", () => {
    useWebSocket("r1", "xmtp"); FakeSocket.all[0].disconnect(); vi.advanceTimersByTime(1000); FakeSocket.all[1].open();
    FakeSocket.all[1].emit({ type: "message", message: message("plaintext") });
    expect(harness.fetch).not.toHaveBeenCalled(); expect(store().messages).toHaveLength(0);
  });
});
