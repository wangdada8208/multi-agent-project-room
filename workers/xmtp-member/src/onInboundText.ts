import { ingest, type LocalLoopState } from "./localLoop.ts";

export interface OnInboundTextInput {
  state: LocalLoopState;
  text: string;
  sendText: (body: string) => Promise<void>;
  saveState: (state: LocalLoopState) => Promise<void>;
}

export async function onInboundText(input: OnInboundTextInput): Promise<LocalLoopState> {
  const result = ingest(input.state, input.text);

  if (result.outbound !== null) {
    await input.sendText(result.outbound);
  }

  await input.saveState(result.state);
  return result.state;
}
