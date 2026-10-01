import assert from "node:assert/strict";
import test from "node:test";
import { checkLocalRequest } from "./localGuard.ts";

test("loopback GET without origin is allowed", () => {
  assert.equal(checkLocalRequest({ method: "GET", host: "127.0.0.1:8787" }), true);
  assert.equal(checkLocalRequest({ method: "GET", host: "localhost:8787" }), true);
  assert.equal(checkLocalRequest({ method: "GET", host: "[::1]:8787" }), true);
});

test("a rebinding host name is refused", () => {
  assert.equal(checkLocalRequest({ method: "GET", host: "evil.example:8787" }), false);
  assert.equal(checkLocalRequest({ method: "GET", host: null }), false);
});

test("a page from another site cannot call the console", () => {
  assert.equal(
    checkLocalRequest({ method: "GET", host: "127.0.0.1:8787", origin: "https://evil.example" }),
    false
  );
});

test("POST needs the owner header", () => {
  assert.equal(checkLocalRequest({ method: "POST", host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }), false);
  assert.equal(
    checkLocalRequest({ method: "POST", host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", ownerHeader: "1" }),
    true
  );
});
