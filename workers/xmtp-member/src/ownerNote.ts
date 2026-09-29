export type OwnerNoteAction = "sent" | "blocked" | "silent";

export interface BuildOwnerNoteInput {
  selfName: string;
  turnsSeen: number;
  action: OwnerNoteAction;
  blockReason?: string | null;
  inbound?: string;
  modelText?: string | null;
}

export interface OwnerNote {
  self_name: string;
  turns_seen: number;
  action: OwnerNoteAction;
  block_reason: string | null;
}

export function buildOwnerNote(input: BuildOwnerNoteInput): OwnerNote {
  return {
    self_name: input.selfName,
    turns_seen: input.turnsSeen,
    action: input.action,
    block_reason: input.action === "blocked" ? (input.blockReason ?? null) : null,
  };
}
