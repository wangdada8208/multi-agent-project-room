import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { DateRange, FreeBusyPayload } from "./envelope.ts";

export interface CalendarEvent {
  start: string;
  end: string;
  title?: string;
  notes?: string;
  attendees?: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function loadCalendar(file: string): Promise<CalendarEvent[]> {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error("calendar file must be a JSON array");
  return raw.filter(
    (e: any) => e && typeof e.start === "string" && typeof e.end === "string"
  );
}

export function freeBusy(events: CalendarEvent[], range: DateRange): FreeBusyPayload {
  const from = Date.parse(`${range.date_from}T00:00:00Z`);
  const to = Date.parse(`${range.date_to}T00:00:00Z`) + DAY_MS;
  const busy = events
    .map((e) => ({ s: Date.parse(e.start), e: Date.parse(e.end) }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e) && x.s < to && x.e > from)
    .map((x) => ({ start: new Date(x.s).toISOString(), end: new Date(x.e).toISOString() }))
    .sort((a, b) => a.start.localeCompare(b.start));
  return {
    scope: "calendar.free_busy",
    date_from: range.date_from,
    date_to: range.date_to,
    busy,
  };
}
