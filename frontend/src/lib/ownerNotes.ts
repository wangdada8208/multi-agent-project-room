export type OwnerNoteAction = "sent" | "blocked" | "silent";

export interface VisibleOwnerNote {
  self_name: string;
  turns_seen: number;
  action: OwnerNoteAction;
  block_reason: string | null;
}

export function visibleOwnerNotes(notes: any[]): VisibleOwnerNote[] {
  return (notes || []).map((n) => ({
    self_name: String(n.self_name || ""),
    turns_seen: Number(n.turns_seen || 0),
    action: (n.action || "silent") as OwnerNoteAction,
    block_reason: n.block_reason != null ? String(n.block_reason) : null,
  }));
}

export function formatOwnerNoteAction(action: string): string {
  if (action === "sent") return "已发送";
  if (action === "blocked") return "未发送";
  if (action === "silent") return "未轮到";
  return action;
}
