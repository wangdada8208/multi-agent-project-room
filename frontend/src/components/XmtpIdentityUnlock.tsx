import { useState } from "react";
import { hasEncryptedVault, LEGACY_STORAGE_KEY, unlockOrCreateInboxKey } from "../lib/xmtpLocalIdentity";

export function XmtpIdentityUnlock({ onUnlock }: { onUnlock: (key: string) => void }) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const creating = !hasEncryptedVault();
  const migrating = creating && Boolean(localStorage.getItem(LEGACY_STORAGE_KEY));
  return <form className="owner-note-row" style={{ padding: 16 }} onSubmit={async event => {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const key = await unlockOrCreateInboxKey(password);
      setPassword("");
      onUnlock(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法解锁身份");
    } finally { setPending(false); }
  }}>
    <p>{creating ? "为本机加密身份设置口令" : "解锁本机加密身份"}</p>
    <p>{migrating ? "现有身份会加密迁移，保留原群访问权限。请妥善保存口令。" :
      "口令和私钥仅在本机使用。忘记口令后无法解锁，请妥善保存。"}</p>
    <label>身份口令 <input type="password" value={password}
      onChange={event => setPassword(event.target.value)}
      autoComplete={creating ? "new-password" : "current-password"}
      minLength={creating ? 10 : undefined} required disabled={pending} /></label>
    <button type="submit" disabled={pending}>{pending ? "正在解锁…" : creating ? "保存并进入" : "解锁"}</button>
    {error && <p className="chat-error" role="alert">{error}</p>}
  </form>;
}
