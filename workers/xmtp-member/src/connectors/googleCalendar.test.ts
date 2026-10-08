import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoogleCalendarConnector } from "./googleCalendar.ts";

test("calendar-level errors must not be reported as all free", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gcal-error-"));
  const credentialPath = path.join(dir, "token.json");
  await writeFile(credentialPath, JSON.stringify({ access_token: "synthetic" }), { mode: 0o600 });
  const connector = new GoogleCalendarConnector({ credentialPath,
    fetchImpl: async () => new Response(JSON.stringify({ calendars: { primary: {
      errors: [{ reason: "notFound" }],
    } } }), { status: 200 }),
  });
  await assert.rejects(connector.fetch("calendar.free_busy", {
    date_from: "2026-10-05", date_to: "2026-10-09",
  }), /calendar.*failed/i);
});

test("GoogleCalendarConnector rejects credentials if file permissions are not 0600", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gcal-insecure-"));
  const credFile = path.join(dir, "token.json");
  await writeFile(credFile, JSON.stringify({ access_token: "mock-token" }));
  await chmod(credFile, 0o644); // 开放读权限

  const connector = new GoogleCalendarConnector({ credentialPath: credFile });
  await assert.rejects(
    connector.fetch("calendar.free_busy", { date_from: "2026-10-05", date_to: "2026-10-09" }),
    /insecure permissions/i
  );
});

test("GoogleCalendarConnector queries freeBusy endpoint and formats busy slots without event titles", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gcal-secure-"));
  const credFile = path.join(dir, "token.json");
  await writeFile(credFile, JSON.stringify({ access_token: "mock-bearer-token" }));
  await chmod(credFile, 0o600); // 严格仅拥有者读写

  let calledUrl = "";
  let calledMethod = "";
  let calledBody: any = null;

  const mockFetch = async (url: any, options: any) => {
    calledUrl = String(url);
    calledMethod = options.method;
    calledBody = JSON.parse(options.body);

    return {
      ok: true,
      json: async () => ({
        calendars: {
          primary: {
            busy: [
              {
                start: "2026-10-06T09:00:00.000Z",
                end: "2026-10-06T10:00:00.000Z",
              },
            ],
          },
        },
      }),
    } as any;
  };

  const connector = new GoogleCalendarConnector({
    credentialPath: credFile,
    fetchImpl: mockFetch,
  });

  const payload: any = await connector.fetch("calendar.free_busy", {
    date_from: "2026-10-05",
    date_to: "2026-10-09",
  });

  // 断言请求接口必须是 freeBusy，严禁调用全量事件接口 /events
  assert.equal(calledUrl.includes("/freeBusy"), true);
  assert.equal(calledUrl.includes("/events"), false);
  assert.equal(calledMethod, "POST");
  assert.equal(calledBody.timeMin, "2026-10-05T00:00:00.000Z");
  assert.equal(calledBody.timeMax, "2026-10-09T23:59:59.999Z");

  // 断言返回格式
  assert.equal(payload.scope, "calendar.free_busy");
  assert.equal(payload.date_from, "2026-10-05");
  assert.equal(payload.date_to, "2026-10-09");
  assert.deepEqual(payload.busy, [
    { start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T10:00:00.000Z" },
  ]);
});
