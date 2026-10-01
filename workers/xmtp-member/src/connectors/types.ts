import type { DateRange, EmailReceiptPayload, FreeBusyPayload } from "../envelope.ts";

export interface Connector {
  id: string;
  scopes: string[];
  fetch(scope: string, constraints: unknown): Promise<unknown>;
}

export interface EmailReceiptConstraints {
  query: string;
  date_from: string;
  date_to: string;
}

export type { EmailReceiptPayload, FreeBusyPayload, DateRange };
