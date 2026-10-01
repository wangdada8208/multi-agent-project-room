import { freeBusy, loadCalendar } from "../calendar.ts";
import type { Connector, DateRange } from "./types.ts";

export class LocalCalendarConnector implements Connector {
  readonly id = "local-calendar";
  readonly scopes = ["calendar.free_busy"];
  private readonly file: string;

  constructor(calendarFile: string) {
    this.file = calendarFile;
  }

  async fetch(scope: string, constraints: unknown): Promise<unknown> {
    if (scope !== "calendar.free_busy") {
      throw new Error(`Unsupported scope: ${scope}`);
    }
    const events = await loadCalendar(this.file);
    return freeBusy(events, constraints as DateRange);
  }
}
