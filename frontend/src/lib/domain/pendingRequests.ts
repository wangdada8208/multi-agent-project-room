import type { RedemptionView } from "../localHelper";

export type PendingRequest = RedemptionView & { displayName: string };

export function pendingRequestsFrom(redemptions: readonly RedemptionView[], lookupName: (token: string) => string | null): PendingRequest[] {
  return redemptions
    .filter((row) => row.status === "pending" && (row.kind === "human" || row.kind === "agent"))
    .map((row) => {
      const address = row.redeemer_address;
      const abbreviated = address ? `（${address.slice(0, 6)}…${address.slice(-4)}）` : "";
      return {
        ...row,
        displayName: row.kind === "agent" ? lookupName(row.token) || `云端 Agent${abbreviated}` : `协作者${abbreviated}`,
      };
    });
}
