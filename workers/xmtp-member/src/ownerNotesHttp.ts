import type { OwnerNote } from "./ownerNote.ts";

export interface HandleOwnerNotesInput {
  host?: string | null;
  notes: OwnerNote[];
}

export interface HandleOwnerNotesResponse {
  status: number;
  body: {
    notes: OwnerNote[];
  };
}

export async function handleOwnerNotes(input: HandleOwnerNotesInput): Promise<HandleOwnerNotesResponse> {
  const rawHost = input.host ?? "";
  const host = rawHost.split(":")[0].trim().toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost";
  if (!isLoopback) {
    return {
      status: 403,
      body: {
        notes: [],
      },
    };
  }

  const safeNotes: OwnerNote[] = (input.notes || []).map((n) => ({
    self_name: n.self_name,
    turns_seen: n.turns_seen,
    action: n.action,
    block_reason: n.block_reason ?? null,
  }));

  return {
    status: 200,
    body: {
      notes: safeNotes,
    },
  };
}
