import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

export async function saveLoopState(file: string, state: LocalLoopState): Promise<void> {
  const cleanState: LocalLoopState = {
    participants: Array.isArray(state.participants) ? [...state.participants] : [],
    selfName: String(state.selfName),
    turnIndex: Number(state.turnIndex),
    turnsSeen: Number(state.turnsSeen),
    status: "active",
  };

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cleanState, null, 2), "utf8");
}

export async function loadLoopState(file: string): Promise<LocalLoopState> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(`Loop state file not found: ${file}`);
    }
    throw new Error(`Failed to read loop state file: ${file}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse loop state JSON from ${file}`);
  }

  if (
    !parsed ||
    !Array.isArray(parsed.participants) ||
    !parsed.participants.every((p: unknown) => typeof p === "string") ||
    typeof parsed.selfName !== "string" ||
    typeof parsed.turnIndex !== "number" ||
    typeof parsed.turnsSeen !== "number" ||
    parsed.status !== "active"
  ) {
    throw new Error(`Invalid loop state structure in ${file}`);
  }

  return {
    participants: parsed.participants,
    selfName: parsed.selfName,
    turnIndex: parsed.turnIndex,
    turnsSeen: parsed.turnsSeen,
    status: "active",
  };
}
