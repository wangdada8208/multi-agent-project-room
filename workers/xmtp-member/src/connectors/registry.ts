import type { Connector } from "./types.ts";

export function findConnector(scope: string, connectors: Connector[]): Connector | null {
  for (const c of connectors) {
    if (c.scopes.includes(scope)) {
      return c;
    }
  }
  return null;
}
