import { composeReply } from "./composeReply.ts";
import { ingest, type LocalLoopState } from "./localLoop.ts";
import { filterOutbound } from "./outboundFilter.ts";
import { buildOwnerNote, type OwnerNote, type OwnerNoteAction } from "./ownerNote.ts";

export interface OnInboundTextInput {
  state: LocalLoopState;
  text: string;
  /** 发送者是不是房里的另一个席位 Agent（连环护栏依据；未知按人类处理）。 */
  senderIsAgent?: boolean;
  guardLimit?: number;
  sendText: (body: string) => Promise<void>;
  saveState: (state: LocalLoopState) => Promise<void>;
  complete?: (prompt: string) => Promise<string>;
  approvedDays?: string[];
  sensitiveKeywords?: string[];
  recordOwner?: (note: OwnerNote) => Promise<void>;
}

export async function onInboundText(input: OnInboundTextInput): Promise<LocalLoopState> {
  const result = ingest(input.state, input.text, {
    senderIsAgent: input.senderIsAgent,
    guardLimit: input.guardLimit,
  });

  let action: OwnerNoteAction = "silent";
  let blockReason: string | null = null;

  if (result.reason === "loop_guard") {
    action = "guard";
    if (result.outbound !== null) {
      // 护栏通告原样发出，不送引擎改写。
      await input.sendText(result.outbound);
      action = "sent";
    }
  } else if (result.outbound !== null) {
    const rawReply = await composeReply({
      shouldReply: true,
      selfName: input.state.selfName,
      inbound: input.text,
      complete: input.complete,
    });

    if (rawReply !== null) {
      const filtered = filterOutbound({
        content: rawReply,
        approvedDays: input.approvedDays,
        sensitiveKeywords: input.sensitiveKeywords,
      });

      if (!filtered.blocked && filtered.text !== null) {
        await input.sendText(filtered.text);
        action = "sent";
      } else {
        action = "blocked";
        blockReason = "unapproved_day";
      }
    }
  }

  await input.saveState(result.state);

  if (input.recordOwner) {
    const note = buildOwnerNote({
      selfName: result.state.selfName,
      turnsSeen: result.state.turnsSeen,
      action,
      blockReason,
    });
    await input.recordOwner(note);
  }

  return result.state;
}
