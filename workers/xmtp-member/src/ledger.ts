import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type LedgerKind =
  | "sender_dropped"
  | "request_sent"
  | "request_denied"
  | "request_queued"
  | "consent_approved"
  | "consent_denied"
  | "consent_expired"
  | "send_failed"
  | "disclosure_stored"
  | "disclosure_rejected"
  | "denial_received"
  | "pending_received";

export interface LedgerEntry {
  at: string;
  kind: LedgerKind;
  request_id: string | null;
  peer: string | null;
  scope: string | null;
  reason: string | null;
  payload_hash: string | null;
}

export function buildLedgerEntry(input: {
  now: Date;
  kind: LedgerKind;
  requestId?: string | null;
  peer?: string | null;
  scope?: string | null;
  reason?: string | null;
  payloadHash?: string | null;
}): LedgerEntry {
  return {
    at: input.now.toISOString(),
    kind: input.kind,
    request_id: input.requestId ?? null,
    peer: input.peer ? input.peer.toLowerCase() : null,
    scope: input.scope ?? null,
    reason: input.reason ?? null,
    payload_hash: input.payloadHash ?? null,
  };
}

export async function appendLedger(file: string, entry: LedgerEntry): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

export async function readLedger(file: string): Promise<LedgerEntry[]> {
  if (!existsSync(file)) return [];
  const content = await readFile(file, "utf8");
  const out: LedgerEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  return out;
}
