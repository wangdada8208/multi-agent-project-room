import { composeReply } from "./composeReply.ts";
import { ingest, type LocalLoopState } from "./localLoop.ts";
import { filterOutbound } from "./outboundFilter.ts";
import { buildOwnerNote, type OwnerNote, type OwnerNoteAction } from "./ownerNote.ts";

export interface OnInboundTextInput {
  state: LocalLoopState;
  text: string;
  sendText: (body: string) => Promise<void>;
  saveState: (state: LocalLoopState) => Promise<void>;
  complete?: (prompt: string) => Promise<string>;
  approvedDays?: string[];
  sensitiveKeywords?: string[];
  recordOwner?: (note: OwnerNote) => Promise<void>;
}

export async function onInboundText(input: OnInboundTextInput): Promise<LocalLoopState> {
  const result = ingest(input.state, input.text);

  let action: OwnerNoteAction = "silent";
  let blockReason: string | null = null;

  if (result.outbound !== null) {
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
