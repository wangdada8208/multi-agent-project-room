import type { HubSeatView } from "../localHelper";
import type { PresenceParticipant } from "../../types/chat";

export interface MentionCandidate {
  id: string;
  name: string;
  actor: "shortcut" | "human" | "cloud" | "local";
  disabled: boolean;
}

export function parseMentionQuery(text: string, cursor = text.length) {
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(text.slice(0, cursor));
  if (!match) return null;
  return { query: match[1], start: cursor - match[1].length - 1, end: cursor };
}

export function filterMentionCandidates(candidates: readonly MentionCandidate[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return candidates.filter(({ name }) => name.toLocaleLowerCase().includes(needle));
}

export function mentionCandidatesFrom(seats: readonly HubSeatView[], participants: readonly PresenceParticipant[]): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: MentionCandidate) => {
    if (!candidate.name || seen.has(candidate.name)) return;
    seen.add(candidate.name);
    candidates.push(candidate);
  };
  for (const seat of seats) {
    if (seat.group_status === "removed") continue;
    add({
      id: seat.seat_id, name: seat.agent_display_name.trim(),
      actor: seat.source === "invite" || seat.kind === "cloud-agent" ? "cloud" : "local",
      disabled: Boolean(seat.paused_at),
    });
  }
  for (const participant of participants) {
    if (participant.sender_type === "system") continue;
    add({
      id: participant.sender_id, name: (participant.sender_name || participant.sender_id).trim(),
      actor: participant.sender_type === "agent" ? "local" : "human", disabled: false,
    });
  }
  if (candidates.some(({ actor, disabled }) => !disabled && (actor === "local" || actor === "cloud"))) {
    candidates.unshift({ id: "all", name: "全体", actor: "shortcut", disabled: false });
  }
  return candidates;
}
