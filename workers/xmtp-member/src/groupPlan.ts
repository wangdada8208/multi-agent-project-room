export type GroupPlan =
  | { action: "use"; groupId: string; source: "env" | "hub" }
  | { action: "create" }
  | { action: "none" };

export function resolveGroupPlan(input: {
  envGroupId?: string;
  hubGroupId?: string | null;
  peerAddresses: string[];
}): GroupPlan {
  const envId = (input.envGroupId || "").trim();
  if (envId) return { action: "use", groupId: envId, source: "env" };
  const hubId = (input.hubGroupId || "").trim();
  if (hubId) return { action: "use", groupId: hubId, source: "hub" };
  if (input.peerAddresses.length > 0) return { action: "create" };
  return { action: "none" };
}

export async function fetchHubGroupId(input: {
  hubBaseUrl: string;
  hubRoomId: string;
  hubToken: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const fetchFn = input.fetchImpl ?? fetch;
  const url = `${input.hubBaseUrl.replace(/\/$/, "")}/api/v1/rooms/${input.hubRoomId}`;
  const resp = await fetchFn(url, {
    headers: { Authorization: `Bearer ${input.hubToken}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to read hub room: HTTP status ${resp.status}`);
  }
  const data: any = await resp.json();
  const id = data?.room?.xmtp_group_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
