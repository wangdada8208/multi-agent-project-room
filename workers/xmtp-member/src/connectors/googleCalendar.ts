import { readFile, stat } from "node:fs/promises";
import type { Connector, DateRange, FreeBusyPayload } from "./types.ts";

export interface GoogleCalendarConnectorOptions {
  credentialPath: string;
  fetchImpl?: typeof fetch;
}

export class GoogleCalendarConnector implements Connector {
  readonly id = "google-calendar";
  readonly scopes = ["calendar.free_busy"];
  private readonly credentialPath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleCalendarConnectorOptions) {
    this.credentialPath = options.credentialPath;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async loadToken(): Promise<string> {
    const fileStat = await stat(this.credentialPath);
    const mode = fileStat.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `Insecure permissions on credential file: expected 0600, got 0${mode.toString(8)}`
      );
    }
    const raw = JSON.parse(await readFile(this.credentialPath, "utf8"));
    if (!raw?.access_token) {
      throw new Error("Missing access_token in credential file");
    }
    return raw.access_token;
  }

  async fetch(scope: string, constraints: unknown): Promise<FreeBusyPayload> {
    if (scope !== "calendar.free_busy") {
      throw new Error(`Unsupported scope: ${scope}`);
    }
    const range = constraints as DateRange;
    const token = await this.loadToken();

    const timeMin = `${range.date_from}T00:00:00.000Z`;
    const timeMax = `${range.date_to}T23:59:59.999Z`;

    const res = await this.fetchImpl("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        timeMin,
        timeMax,
        items: [{ id: "primary" }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Google Calendar freeBusy request failed with status: ${res.status}`);
    }

    const data: any = await res.json();
    const calendar = data?.calendars?.primary;
    if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) {
      throw new Error("Google Calendar query failed; availability is unknown");
    }
    const busyRaw = calendar.busy;

    const busy = busyRaw
      .map((b: any) => ({
        start: new Date(b.start).toISOString(),
        end: new Date(b.end).toISOString(),
      }))
      .sort((a: any, b: any) => a.start.localeCompare(b.start));

    return {
      scope: "calendar.free_busy",
      date_from: range.date_from,
      date_to: range.date_to,
      busy,
    };
  }
}
