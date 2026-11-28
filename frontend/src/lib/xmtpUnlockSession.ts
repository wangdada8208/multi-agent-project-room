export const SESSION_UNLOCK_STORAGE_KEY = "mapr-xmtp-session-unlock";

let unlockedPrivateKey: string | null = null;

function sessionStorageOrNull(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  return typeof sessionStorage !== "undefined" ? sessionStorage : null;
}

function validPrivateKey(candidate: string | null): candidate is string {
  return Boolean(candidate && /^0x[0-9a-fA-F]{64}$/.test(candidate));
}

function readRememberedSessionKey(): string | null {
  const storage = sessionStorageOrNull();
  if (!storage) return null;
  try {
    const stored = storage.getItem(SESSION_UNLOCK_STORAGE_KEY);
    if (validPrivateKey(stored)) return stored;
    if (stored) storage.removeItem(SESSION_UNLOCK_STORAGE_KEY);
  } catch {
    return null;
  }
  return null;
}

export function rememberUnlockedXmtpKey(privateKey: string, keepInBrowserSession: boolean): void {
  unlockedPrivateKey = privateKey;
  const storage = sessionStorageOrNull();
  if (!storage) return;
  try {
    if (keepInBrowserSession) storage.setItem(SESSION_UNLOCK_STORAGE_KEY, privateKey);
    else storage.removeItem(SESSION_UNLOCK_STORAGE_KEY);
  } catch {
    // An in-memory unlock still works when browser storage is blocked.
  }
}

export function currentUnlockedXmtpKey(): string | null {
  if (validPrivateKey(unlockedPrivateKey)) return unlockedPrivateKey;
  unlockedPrivateKey = null;
  const remembered = readRememberedSessionKey();
  if (remembered) unlockedPrivateKey = remembered;
  return remembered;
}

export function lockXmtpIdentity(): void {
  unlockedPrivateKey = null;
  try {
    sessionStorageOrNull()?.removeItem(SESSION_UNLOCK_STORAGE_KEY);
  } catch {
    // Clearing remains best-effort when browser storage is blocked.
  }
}

export function setUnlockedXmtpKey(privateKey: string | null): void {
  unlockedPrivateKey = privateKey;
}

export function clearUnlockedXmtpKey(): void {
  unlockedPrivateKey = null;
}

export function hasUnlockedXmtpKey(): boolean {
  return currentUnlockedXmtpKey() !== null;
}
