export function buildBindingPayload(input: { xmtpGroupId: string }): {
  xmtp_group_id: string;
} {
  return { xmtp_group_id: input.xmtpGroupId };
}
