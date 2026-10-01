import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { freeBusy, loadCalendar, type CalendarEvent } from "./calendar.ts";

const events: CalendarEvent[] = [
  {
    start: "2026-10-06T09:00:00Z",
    end: "2026-10-06T10:00:00Z",
    title: "和律师谈离婚协议",
    notes: "带上房产证",
    attendees: ["lawyer@example.com"],
  },
  { start: "2026-10-05T14:00:00Z", end: "2026-10-05T15:00:00Z", title: "体检" },
  { start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z", title: "范围外" },
];

test("free/busy only contains start and end, sorted, inside the range", () => {
  const payload = freeBusy(events, { date_from: "2026-10-05", date_to: "2026-10-09" });
  assert.deepEqual(payload, {
    scope: "calendar.free_busy",
    date_from: "2026-10-05",
    date_to: "2026-10-09",
    busy: [
      { start: "2026-10-05T14:00:00.000Z", end: "2026-10-05T15:00:00.000Z" },
      { start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T10:00:00.000Z" },
    ],
  });
  const encoded = JSON.stringify(payload);
  for (const secret of ["律师", "房产证", "lawyer@example.com", "体检", "范围外"]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

test("the last day of the range is included", () => {
  const payload = freeBusy(
    [{ start: "2026-10-09T23:00:00Z", end: "2026-10-09T23:30:00Z" }],
    { date_from: "2026-10-05", date_to: "2026-10-09" }
  );
  assert.equal(payload.busy.length, 1);
});

test("loadCalendar returns [] for a missing file and filters bad rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cal-"));
  assert.deepEqual(await loadCalendar(path.join(dir, "none.json")), []);
  const file = path.join(dir, "calendar.json");
  await writeFile(file, JSON.stringify([{ start: "2026-10-05T09:00:00Z", end: "2026-10-05T10:00:00Z" }, { title: "no time" }]));
  const loaded = await loadCalendar(file);
  assert.equal(loaded.length, 1);
});
