import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DisclosurePayload } from "./envelope.ts";

export interface InboxEntry {
  received_at: string;
  from: string;
  request_id: string;
  grant_id: string;
  payload: DisclosurePayload;
}

export async function readInbox(file: string): Promise<InboxEntry[]> {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(await readFile(file, "utf8"));
  return Array.isArray(raw) ? raw : [];
}

export async function appendInboxOnce(file: string, entry: InboxEntry): Promise<boolean> {
  const all = await readInbox(file);
  if (all.some((e) => e.grant_id === entry.grant_id)) return false;
  all.push(entry);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(all, null, 2), "utf8");
  return true;
}
