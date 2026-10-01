import type { LedgerEntry } from "./ledger.ts";

export interface ScoreboardItem {
  peer: string;
  accepted: number;
  rejected: number;
}

export function scoreboard(entries: LedgerEntry[]): ScoreboardItem[] {
  const map = new Map<string, { accepted: number; rejected: number }>();

  for (const entry of entries) {
    if (entry.kind !== "verdict_sent") continue;
    if (!entry.peer) continue;
    const peer = entry.peer.toLowerCase();
    const curr = map.get(peer) || { accepted: 0, rejected: 0 };
    if (entry.reason === "accepted") {
      curr.accepted += 1;
    } else if (entry.reason === "rejected") {
      curr.rejected += 1;
    }
    map.set(peer, curr);
  }

  const result: ScoreboardItem[] = [];
  for (const [peer, counts] of map.entries()) {
    result.push({
      peer,
      accepted: counts.accepted,
      rejected: counts.rejected,
    });
  }

  // 排序：优先按 accepted 降序，其次按 rejected 升序，最后按 peer 字典序
  return result.sort((a, b) => {
    if (b.accepted !== a.accepted) {
      return b.accepted - a.accepted;
    }
    if (a.rejected !== b.rejected) {
      return a.rejected - b.rejected;
    }
    return a.peer.localeCompare(b.peer);
  });
}
