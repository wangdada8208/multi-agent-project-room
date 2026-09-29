export function buildEvidence(input: {
  groupId: string;
  probeReceivedByPeer: boolean;
  replyReceivedBySender: boolean;
  hubPlaintextCount: number;
  messagesTablePresent: boolean;
  hubDatabase: string;
  browserGroupId?: string;
}): {
  checked_at: string;
  env: "dev";
  group_id: string;
  browser_group_id?: string;
  probe_name: "member-send-dev-ping";
  probe_received_by_peer: boolean;
  reply_received_by_sender: boolean;
  hub_plaintext_count: number;
  messages_table_present: boolean;
  hub_database: string;
} {
  const evidence: {
    checked_at: string;
    env: "dev";
    group_id: string;
    browser_group_id?: string;
    probe_name: "member-send-dev-ping";
    probe_received_by_peer: boolean;
    reply_received_by_sender: boolean;
    hub_plaintext_count: number;
    messages_table_present: boolean;
    hub_database: string;
  } = {
    checked_at: new Date().toISOString(),
    env: "dev" as const,
    group_id: input.groupId,
    probe_name: "member-send-dev-ping" as const,
    probe_received_by_peer: input.probeReceivedByPeer,
    reply_received_by_sender: input.replyReceivedBySender,
    hub_plaintext_count: input.hubPlaintextCount,
    messages_table_present: input.messagesTablePresent,
    hub_database: input.hubDatabase,
  };
  if (input.browserGroupId !== undefined) {
    evidence.browser_group_id = input.browserGroupId;
  }
  if (/0x[0-9a-fA-F]{64}/.test(JSON.stringify(evidence))) {
    throw new Error("evidence contains a private key");
  }
  if (!input.messagesTablePresent) {
    throw new Error("messages table absent");
  }
  return evidence;
}
