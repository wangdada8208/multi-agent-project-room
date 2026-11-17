import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decideReply } from "./turnPolicy.ts";

/** 连续只看 Agent 发言达到此数后暂停接话（借鉴 agentchattr 的 loop guard；人类发言随时重置）。 */
export const DEFAULT_GUARD_LIMIT = 6;

export interface LocalLoopState {
  participants: string[];
  selfName: string;
  turnIndex: number;
  turnsSeen: number;
  /** 连续 Agent 发言轮数；人类发言清零。旧状态文件没有此字段时按 0 处理。 */
  agentChain: number;
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
    agentChain: 0,
    status: "active",
  };
}

export function ingest(
  state: LocalLoopState,
  text: string,
  opts?: { senderIsAgent?: boolean; guardLimit?: number }
): {
  state: LocalLoopState;
  outbound: string | null;
  reason: "mentioned" | "turn" | "not_this_turn" | "loop_guard";
} {
  const senderIsAgent = opts?.senderIsAgent ?? false;
  const guardLimit = opts?.guardLimit ?? DEFAULT_GUARD_LIMIT;
  const prevChain = state.agentChain;
  const agentChain = senderIsAgent ? prevChain + 1 : 0;
  const guardActive = guardLimit > 0 && agentChain >= guardLimit;

  const decision = decideReply({
    text,
    selfName: state.selfName,
    participants: state.participants,
    turnIndex: state.turnIndex,
  });

  let outbound: string | null = null;
  let reason: "mentioned" | "turn" | "not_this_turn" | "loop_guard" = decision.reason;
  if (guardActive) {
    if (decision.reply) {
      reason = "loop_guard";
      // 只在踏入暂停的当口、且本轮本来要接话时通告一次，之后沉默。
      if (prevChain < guardLimit) {
        outbound = `连续 ${guardLimit} 轮只有 Agent 在说话，我先停一下；人类发任意消息即恢复。`;
      }
    } else {
      reason = "not_this_turn";
    }
  } else if (decision.reply) {
    outbound = `收到，本轮由 ${state.selfName} 处理。`;
  }

  const next: LocalLoopState = {
    participants: state.participants,
    selfName: state.selfName,
    turnIndex: state.turnIndex + 1,
    turnsSeen: state.turnsSeen + 1,
    agentChain,
    status: "active",
  };
  return { state: next, reason, outbound };
}

export async function saveLoopState(file: string, state: LocalLoopState): Promise<void> {
  const cleanState: LocalLoopState = {
    participants: Array.isArray(state.participants) ? [...state.participants] : [],
    selfName: String(state.selfName),
    turnIndex: Number(state.turnIndex),
    turnsSeen: Number(state.turnsSeen),
    agentChain: Number.isFinite(state.agentChain) ? Number(state.agentChain) : 0,
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
    agentChain: typeof parsed.agentChain === "number" && parsed.agentChain >= 0 ? parsed.agentChain : 0,
    status: "active",
  };
}
