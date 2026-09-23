import { composeReply } from "./composeReply.ts";
import { ingest, type LocalLoopState } from "./localLoop.ts";

export interface OnInboundTextInput {
  state: LocalLoopState;
  text: string;
  sendText: (body: string) => Promise<void>;
  saveState: (state: LocalLoopState) => Promise<void>;
  complete?: (prompt: string) => Promise<string>;
}

export async function onInboundText(input: OnInboundTextInput): Promise<LocalLoopState> {
  const result = ingest(input.state, input.text);

  if (result.outbound !== null) {
    const reply = await composeReply({
      shouldReply: true,
      selfName: input.state.selfName,
      inbound: input.text,
      complete: input.complete,
    });
    if (reply !== null) {
      await input.sendText(reply);
    }
  }

  await input.saveState(result.state);
  return result.state;
}
