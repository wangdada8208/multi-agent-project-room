import { readFile, stat } from "node:fs/promises";
import { writeJsonSecure } from "./secureFile.ts";
import { trustFrame, type MessageSource } from "./trustFrame.ts";

export interface RoomMessage {
  id: string;
  text: string;
  source: MessageSource;
  verifiedOwner?: string;
}

type Entry = { id: string; handled: boolean; message?: RoomMessage };
type Snapshot = { entries: Entry[]; acknowledged: number; delivered: number };
export type InboxOptions = { cursor?: number; limit?: number; peek?: boolean; ack?: boolean };

export async function routeLiveMessage(options: {
  inbox: RoomInbox;
  id: string;
  message?: RoomMessage;
  mode: "active" | "watch";
  arrived?: () => void;
  dispatch: () => Promise<void>;
}): Promise<void> {
  if (!(await options.inbox.claim(options.id, options.message))) return;
  options.arrived?.();
  if (options.mode === "active") await options.dispatch();
}

export class RoomInbox {
  private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private entriesById = new Map<string, Entry>();
  private messages: RoomMessage[] = [];
  private file: string;
  private state: Snapshot;

  private constructor(file: string, state: Snapshot) {
    this.file = file;
    this.state = state;
    this.indexEntries();
  }

  static async open(file: string): Promise<RoomInbox> {
    let state: Snapshot;
    try {
      if ((await stat(file)).mode & 0o077) throw new Error("insecure_room_inbox");
      state = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      state = { entries: [], acknowledged: 0, delivered: 0 };
    }
    return new RoomInbox(file, state);
  }

  private indexEntries() {
    this.entriesById = new Map(this.state.entries.map((entry) => [entry.id, entry]));
    this.messages = this.state.entries.flatMap((entry) => entry.message ? [entry.message] : []);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(operation);
    this.writes = next.catch(() => {});
    return next;
  }

  private async save(next: Snapshot) {
    await writeJsonSecure(this.file, next);
    this.state = next;
  }

  get status() {
    return {
      cursor: this.state.acknowledged,
      delivered: this.state.delivered,
      unread: this.messages.length - this.state.acknowledged,
    };
  }

  // Claim in the same transaction as appending the live message, before any automatic reply.
  claim(id: string, message?: RoomMessage): Promise<boolean> {
    return this.serial(async () => {
      const entry = this.entriesById.get(id);
      if (entry?.handled) return false;
      const next = { id, handled: true, message: entry?.message ?? message };
      await this.save({
        ...this.state,
        entries: entry ? this.state.entries.map((item) => item === entry ? next : item) :
          [...this.state.entries, next],
      });
      this.entriesById.set(id, next);
      if (!entry?.message && next.message) {
        this.indexEntries();
        for (const notify of this.listeners) notify();
      }
      return true;
    });
  }

  // History fills gaps in the inbox. It never runs a model or sends a reply.
  restore(messages: RoomMessage[]): Promise<void> {
    return this.serial(async () => {
      const seen = new Set(this.entriesById.keys());
      const fresh: Entry[] = [];
      for (const message of messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        fresh.push({ id: message.id, message, handled: false });
      }
      if (!fresh.length) return;
      await this.save({ ...this.state, entries: [...this.state.entries, ...fresh] });
      this.indexEntries();
      for (const notify of this.listeners) notify();
    });
  }

  read(options: InboxOptions = {}) {
    return this.serial(async () => {
      const start = options.cursor ?? this.state.acknowledged;
      const maxCursor = options.peek ? this.messages.length : this.state.delivered;
      if (!Number.isSafeInteger(start) || start < 0 || start > maxCursor) throw new Error("invalid_cursor");
      const limit = options.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
      if (options.peek && options.ack) throw new Error("peek_cannot_ack");
      const batch = this.messages.slice(start, start + limit);
      const cursor = start + batch.length;
      const delivered = Math.max(this.state.delivered, cursor);
      const acknowledged = options.ack ? Math.max(this.state.acknowledged, cursor) : this.state.acknowledged;
      if (!options.peek && (delivered !== this.state.delivered || acknowledged !== this.state.acknowledged)) {
        await this.save({ ...this.state, delivered, acknowledged });
      }
      return {
        cursor,
        acknowledged: this.state.acknowledged,
        messages: batch.map((m) => ({ id: m.id, frame: trustFrame(m.text, m.source, m.verifiedOwner) })),
        hasMore: cursor < this.messages.length,
      };
    });
  }

  ack(cursor: number): Promise<number> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.state.delivered) throw new Error("invalid_cursor");
      if (cursor > this.state.acknowledged) await this.save({ ...this.state, acknowledged: cursor });
      return this.state.acknowledged;
    });
  }

  summary() {
    return this.messages.slice(-10).map((m) => ({
      id: m.id, frame: trustFrame(Array.from(m.text).slice(0, 240).join(""), m.source, m.verifiedOwner),
    }));
  }

  async wait(options: InboxOptions, timeoutMs: number, signal: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let notify: () => void = () => {};
      const changed = new Promise<void>((resolve) => { notify = resolve; });
      this.listeners.add(notify);
      signal.addEventListener("abort", notify, { once: true });
      const timer = setTimeout(notify, Math.max(0, deadline - Date.now()));
      try {
        if (signal.aborted) throw new Error("wait_cancelled");
        const result = await this.read(options);
        if (result.messages.length || Date.now() >= deadline) return result;
        await changed;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", notify);
        this.listeners.delete(notify);
      }
    }
  }
}
