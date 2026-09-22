import { decideReply } from "./turnPolicy.ts";

export interface LocalLoopState {
  participants: string[];
  selfName: string;
  turnIndex: number;
  turnsSeen: number;
  status: "active";
}

export function createLocalLoop(input: {
  participants: string[];
  selfName: string;
  turnIndex?: number;
}): LocalLoopState {
  return {
    participants: input.participants,
    selfName: input.selfName,
    turnIndex: input.turnIndex ?? 0,
    turnsSeen: 0,
    status: "active",
  };
}

export function ingest(state: LocalLoopState, text: string): {
  state: LocalLoopState;
  outbound: string | null;
  reason: "mentioned" | "turn" | "not_this_turn";
} {
  const decision = decideReply({
    text,
    selfName: state.selfName,
    participants: state.participants,
    turnIndex: state.turnIndex,
  });
  const next: LocalLoopState = {
    participants: state.participants,
    selfName: state.selfName,
    turnIndex: state.turnIndex + 1,
    turnsSeen: state.turnsSeen + 1,
    status: "active",
  };
  return {
    state: next,
    reason: decision.reason,
    outbound: decision.reply ? `收到，本轮由 ${state.selfName} 处理。` : null,
  };
}
