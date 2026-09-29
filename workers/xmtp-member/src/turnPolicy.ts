export interface TurnPolicyInput {
  text: string;
  selfName: string;
  participants: string[];
  turnIndex: number;
}

export interface TurnDecision {
  reply: boolean;
  reason: "mentioned" | "turn" | "not_this_turn";
}

export function decideReply(input: TurnPolicyInput): TurnDecision {
  const { text, selfName, participants, turnIndex } = input;

  const escapedName = selfName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`@${escapedName}(?:(?=[^a-zA-Z0-9_-])|$)`, "i");

  if (mentionPattern.test(text)) {
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
