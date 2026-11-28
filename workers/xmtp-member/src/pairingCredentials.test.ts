import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearRevokedPairing, recordPairingKeys } from "./pairingCredentials.ts";

test("revocation removes this pairing's generated keys and leaves unrelated settings and keys", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parlor-pairing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, ".env");
  const stateDir = path.join(dir, ".state");
  const original = "# keep\nXMTP_WALLET_KEY=shared\nXMTP_DB_ENCRYPTION_KEY=generated\n" +
    "HUB_TOKEN=previous\nMAPR_AGENT_TOKEN=previous\nMAPR_SEAT_ID=seat-1\nUSER_SETTING=keep-this\n";
  await writeFile(envFile, original, { mode: 0o600 });
  await recordPairingKeys(stateDir, "seat-1", new Map([["XMTP_DB_ENCRYPTION_KEY", "generated"]]), ["XMTP_DB_ENCRYPTION_KEY"]);
  const pairing = { envFile, stateDir, seatId: "seat-1", token: "previous" };
  await clearRevokedPairing({ ...pairing, token: "unrelated" });
  assert.equal(await readFile(envFile, "utf8"), original);
  await clearRevokedPairing(pairing);
  assert.equal(await readFile(envFile, "utf8"), "# keep\nXMTP_WALLET_KEY=shared\nUSER_SETTING=keep-this\n");
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  await clearRevokedPairing(pairing);
  assert.equal(await readFile(envFile, "utf8"), "# keep\nXMTP_WALLET_KEY=shared\nUSER_SETTING=keep-this\n");
});
