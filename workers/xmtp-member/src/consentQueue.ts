import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DateRange } from "./envelope.ts";

export type ConsentStatus = "pending" | "approved" | "denied" | "expired";

export interface PendingConsent {
  request_id: string;
  requester: string;
  conversation_id: string;
  scope: string;
  purpose: string;
  constraints: DateRange;
  created_at: string;
  status: ConsentStatus;
}

function copy(item: PendingConsent): PendingConsent {
  return { ...item, constraints: { ...item.constraints } };
}

export class ConsentQueue {
  private items: PendingConsent[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    const raw = JSON.parse(await readFile(this.file, "utf8"));
    this.items = Array.isArray(raw) ? raw : [];
  }

  list(): PendingConsent[] {
    return this.items.map(copy);
  }

  get(requestId: string): PendingConsent | null {
    const found = this.items.find((i) => i.request_id === requestId);
    return found ? copy(found) : null;
  }

  async add(item: Omit<PendingConsent, "status">): Promise<boolean> {
    if (this.items.some((i) => i.request_id === item.request_id)) return false;
    this.items.push({ ...item, constraints: { ...item.constraints }, status: "pending" });
    await this.save();
    return true;
  }

  // Status changes synchronously before the first await, so two concurrent
  // callers can never both claim the same pending item.
  async claim(
    requestId: string,
    status: Exclude<ConsentStatus, "pending">
  ): Promise<PendingConsent | null> {
    const found = this.items.find((i) => i.request_id === requestId);
    if (!found || found.status !== "pending") return null;
    found.status = status;
    await this.save();
    return copy(found);
  }

  dueForExpiry(now: Date, ttlMs: number): PendingConsent[] {
    return this.items
      .filter((i) => i.status === "pending" && Date.parse(i.created_at) + ttlMs <= now.getTime())
      .map(copy);
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2), "utf8");
  }
}
