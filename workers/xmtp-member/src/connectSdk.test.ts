import assert from "node:assert/strict";
import test from "node:test";
import {
  validConnectRedirect,
  buildConnectAuthorizeUrl,
  parseConnectRequestFromUrl,
  type ConnectRequest,
} from "./connectSdk.ts";

test("buildConnectAuthorizeUrl serializes request query parameters cleanly", () => {
  const req: ConnectRequest = {
    app_id: "flight-booking-app",
    scope: "calendar.free_busy",
    purpose: "查询空闲时间以预订差旅航班",
    redirect_uri: "https://booking.example.com/callback",
    constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
  };

  const url = buildConnectAuthorizeUrl("http://127.0.0.1:8787", req);
  assert.equal(url.startsWith("http://127.0.0.1:8787/connect/authorize?"), true);

  const parsed = parseConnectRequestFromUrl(url);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.app_id, "flight-booking-app");
  assert.equal(parsed.request.scope, "calendar.free_busy");
  assert.equal(parsed.request.purpose, "查询空闲时间以预订差旅航班");
  assert.equal(parsed.request.redirect_uri, "https://booking.example.com/callback");
  assert.deepEqual(parsed.request.constraints, { date_from: "2026-10-05", date_to: "2026-10-09" });
});

test("parseConnectRequestFromUrl rejects unknown scope and invalid app_id", () => {
  const badScope = "http://127.0.0.1:8787/connect/authorize?app_id=app1&scope=admin.delete&purpose=test";
  assert.deepEqual(parseConnectRequestFromUrl(badScope), { ok: false, reason: "unknown_scope" });

  const missingApp = "http://127.0.0.1:8787/connect/authorize?scope=calendar.free_busy&purpose=test";
  assert.deepEqual(parseConnectRequestFromUrl(missingApp), { ok: false, reason: "missing_app_id" });

  const missingPurpose = "http://127.0.0.1:8787/connect/authorize?app_id=app1&scope=calendar.free_busy";
  assert.deepEqual(parseConnectRequestFromUrl(missingPurpose), { ok: false, reason: "missing_purpose" });
});

test("callback URLs reject scripts, credentials, nonlocal HTTP, and existing fragments", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,bad", "https://user:pass@example.com", "http://example.com", "https://example.com/#old"]) {
    assert.equal(validConnectRedirect(url), false);
  }
  assert.equal(validConnectRedirect("https://example.com/callback"), true);
  assert.equal(validConnectRedirect("http://127.0.0.1:5173/callback"), true);
});
