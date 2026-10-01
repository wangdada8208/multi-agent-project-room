import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResultEnvelope, TaskEnvelope, VerdictEnvelope } from "./envelope.ts";

export type TaskStatus = "pending" | "retrying" | "completed" | "escalated";

export interface TaskRecord {
  request_id: string;
  task: TaskEnvelope;
  results: ResultEnvelope[];
  verdicts: VerdictEnvelope[];
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

function copyRecord(rec: TaskRecord): TaskRecord {
  return {
    ...rec,
    task: { ...rec.task, acceptance: [...rec.task.acceptance] },
    results: rec.results.map((r) => ({ ...r, evidence: [...r.evidence] })),
    verdicts: rec.verdicts.map((v) => ({ ...v })),
  };
}

export class TaskStore {
  private items: TaskRecord[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      this.items = Array.isArray(raw) ? raw : [];
    } catch {
      this.items = [];
    }
  }

  list(): TaskRecord[] {
    return this.items.map(copyRecord);
  }

  get(requestId: string): TaskRecord | null {
    const found = this.items.find((item) => item.request_id === requestId);
    return found ? copyRecord(found) : null;
  }

  async add(task: TaskEnvelope): Promise<boolean> {
    if (this.items.some((item) => item.request_id === task.request_id)) {
      return false;
    }
    const now = new Date().toISOString();
    const record: TaskRecord = {
      request_id: task.request_id,
      task: { ...task, acceptance: [...task.acceptance] },
      results: [],
      verdicts: [],
      status: "pending",
      created_at: now,
      updated_at: now,
    };
    this.items.push(record);
    await this.save();
    return true;
  }

  async recordResult(requestId: string, result: ResultEnvelope): Promise<boolean> {
    const found = this.items.find((item) => item.request_id === requestId);
    if (!found) return false;
    found.results.push({ ...result, evidence: [...result.evidence] });
    found.updated_at = new Date().toISOString();
    await this.save();
    return true;
  }

  async recordVerdict(
    requestId: string,
    verdict: VerdictEnvelope,
    status: TaskStatus
  ): Promise<boolean> {
    const found = this.items.find((item) => item.request_id === requestId);
    if (!found) return false;
    found.verdicts.push({ ...verdict });
    found.status = status;
    found.updated_at = new Date().toISOString();
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2), "utf8");
  }
}
