import { composeReply } from "./composeReply.ts";
import { ingest, type LocalLoopState } from "./localLoop.ts";
import { filterOutbound } from "./outboundFilter.ts";

export interface OnInboundTextInput {
  state: LocalLoopState;
  text: string;
  sendText: (body: string) => Promise<void>;
  saveState: (state: LocalLoopState) => Promise<void>;
  complete?: (prompt: string) => Promise<string>;
  approvedDays?: string[];
  sensitiveKeywords?: string[];
}

export async function onInboundText(input: OnInboundTextInput): Promise<LocalLoopState> {
  const result = ingest(input.state, input.text);

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
      }
    }
  }

  await input.saveState(result.state);
  return result.state;
}
