import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { writeJsonSecure } from "./secureFile.ts";

const ownershipFile = "pairing-keys.json";
const ownedKeys = ["XMTP_WALLET_KEY", "XMTP_DB_ENCRYPTION_KEY"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function recordPairingKeys(stateDir: string, seatId: string, values: ReadonlyMap<string, string>,
  generated: readonly string[]) {
  const keys = Object.fromEntries(generated.map((key) => [key, digest(values.get(key) || "")]));
  await writeJsonSecure(path.join(stateDir, ownershipFile), { seatId, keys });
}

export async function clearRevokedPairing(options: { envFile: string; stateDir: string; seatId: string; token: string }) {
  const { envFile, stateDir, seatId, token } = options;
  const ownership = path.join(stateDir, ownershipFile);
  let recorded: unknown;
  try {
    const st = await lstat(ownership);
    if (st.isFile() && !(st.mode & 0o077)) recorded = JSON.parse(await readFile(ownership, "utf8"));
  } catch { /* older pairings did not record which keys they generated */ }
  const owned = recorded && typeof recorded === "object" && "seatId" in recorded && recorded.seatId === seatId &&
    "keys" in recorded && recorded.keys && typeof recorded.keys === "object" ? recorded.keys : {};

  const info = await lstat(envFile).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (!info.isFile() || (info.mode & 0o077)) throw new Error("insecure_pairing_file");
  const original = await readFile(envFile, "utf8");
  const lines = original.split(/(?<=\n)/).map((line) => {
    const assignment = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    return { line, key: assignment?.[1], value: assignment?.[2] };
  });
  const values = new Map(lines.map(({ key, value }) => [key, value]));
  const valueOf = (key: string) => values.get(key);
  if (!seatId || !token || valueOf("MAPR_SEAT_ID") !== seatId ||
      (valueOf("MAPR_AGENT_TOKEN") !== token && valueOf("HUB_TOKEN") !== token)) return;

  const contents = lines.filter(({ key, value }) => {
    if (!key || !value) return true;
    if (key === "MAPR_SEAT_ID" && value === seatId) return false;
    if ((key === "MAPR_AGENT_TOKEN" || key === "HUB_TOKEN") && value === token) return false;
    const ownedHash = Object.getOwnPropertyDescriptor(owned, key)?.value;
    return !ownedKeys.includes(key) || ownedHash !== digest(value);
  }).map(({ line }) => line).join("");
  const tmp = path.join(path.dirname(envFile), `.mapr-revoked-${randomUUID()}`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await readFile(envFile, "utf8") !== original) throw new Error("pairing_changed");
    await rename(tmp, envFile);
  } finally {
    await unlink(tmp).catch(() => {});
  }
  if (recorded && typeof recorded === "object" && "seatId" in recorded && recorded.seatId === seatId) {
    await unlink(ownership).catch(() => {});
  }
}

export function explicitRevocation(status: number, body: unknown): boolean {
  if ((status !== 401 && status !== 403) || !body || typeof body !== "object" || !("detail" in body)) return false;
  const detail = body.detail;
  if (typeof detail === "string") {
    return ["Helper token invalid", "Invalid token", "Inactive account", "User not found", "Account type mismatch",
      "revoked", "invalidated"].includes(detail);
  }
  return Boolean(detail && typeof detail === "object" && "code" in detail &&
    (detail.code === "revoked" || detail.code === "invalidated"));
}
