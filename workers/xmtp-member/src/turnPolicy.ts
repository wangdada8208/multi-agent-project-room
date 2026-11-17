export interface TurnPolicyInput {
  text: string;
  selfName: string;
  participants: string[];
  peerNames?: string[];
  turnIndex: number;
}

export interface TurnDecision {
  reply: boolean;
  reason: "mentioned" | "turn" | "not_this_turn";
}

const BROADCAST_MENTION_RE = /(?:^|[^\w])@(?:all|全体)(?![\w-])/i;

export function hasBroadcastMention(text: string): boolean {
  return BROADCAST_MENTION_RE.test(text);
}

function isSelfDirectlyMentioned(
  text: string,
  trimmedSelf: string,
  participants: string[],
  peerNames?: string[]
): boolean {
  const candidates: string[] = [];
  const seenLower = new Set<string>();
  for (const raw of [trimmedSelf, ...participants, ...(peerNames ?? [])]) {
    const name = raw.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    candidates.push(name);
  }
  candidates.sort((a, b) => b.length - a.length);

  const selfLower = trimmedSelf.toLowerCase();
  let pos = 0;
  while (pos < text.length) {
    const atIdx = text.indexOf("@", pos);
    if (atIdx === -1) break;
    if (atIdx > 0 && /\w/.test(text[atIdx - 1])) {
      pos = atIdx + 1;
      continue;
    }

    let matchedCandidate: string | null = null;
    for (const candidate of candidates) {
      const endIdx = atIdx + 1 + candidate.length;
      if (endIdx > text.length) continue;
      if (text.slice(atIdx + 1, endIdx).toLowerCase() !== candidate.toLowerCase()) continue;
      if (endIdx < text.length && /[a-zA-Z0-9_-]/.test(text[endIdx])) continue;
      matchedCandidate = candidate;
      break;
    }

    if (matchedCandidate !== null) {
      if (matchedCandidate.toLowerCase() === selfLower) {
        return true;
      }
      pos = atIdx + 1 + matchedCandidate.length;
    } else {
      pos = atIdx + 1;
    }
  }

  return false;
}

export function decideReply(input: TurnPolicyInput): TurnDecision {
  const { text, selfName, participants, peerNames, turnIndex } = input;

  const trimmedSelf = selfName.trim();
  if (trimmedSelf.length > 0 && isSelfDirectlyMentioned(text, trimmedSelf, participants, peerNames)) {
    return { reply: true, reason: "mentioned" };
  }

  if (hasBroadcastMention(text)) {
    return { reply: true, reason: "mentioned" };
  }

  if (participants.length > 0) {
    const currentParticipant = participants[turnIndex % participants.length];
    if (currentParticipant.toLowerCase() === selfName.toLowerCase()) {
      return { reply: true, reason: "turn" };
    }
  }

  return { reply: false, reason: "not_this_turn" };
}
