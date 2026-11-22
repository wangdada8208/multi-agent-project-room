import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DisclosurePayload } from "./envelope.ts";
import { writeJsonSecure } from "./secureFile.ts";

export interface ActionResultRecord {
  kind: "action_result";
  status: "executed" | "failed" | "uncertain";
  receipt?: string;
  summary?: string;
}

export interface InboxEntry {
  received_at: string;
  from: string;
  request_id: string;
  grant_id: string;
  payload: DisclosurePayload | ActionResultRecord;
}

export async function readInbox(file: string): Promise<InboxEntry[]> {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(await readFile(file, "utf8"));
  return Array.isArray(raw) ? raw : [];
}

const appendChains = new Map<string, Promise<void>>();

export async function appendInboxOnce(file: string, entry: InboxEntry): Promise<boolean> {
  const key = path.resolve(file);
  const previous = appendChains.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const all = await readInbox(file);
    if (all.some((e) => e.grant_id === entry.grant_id)) return false;
    all.push(entry);
    await writeJsonSecure(file, all);
    return true;
  });
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  appendChains.set(key, tail);
  try {
    return await run;
  } finally {
    if (appendChains.get(key) === tail) appendChains.delete(key);
  }
}
