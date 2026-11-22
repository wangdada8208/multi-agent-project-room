import assert from "node:assert/strict";
import { chmod, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AccountStore,
  readAccountCredentials,
  removeCredentialFile,
  resolveCredentialPath,
  verifyCredentialFile,
} from "./accounts.ts";

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acct-"));
  const stateDir = path.join(dir, ".state");
  const credDir = path.join(stateDir, "credentials");
  const store = new AccountStore(path.join(stateDir, "accounts.json"));
  await store.load();
  return { dir, stateDir, credDir, store };
}

const ENTRY = { id: "work-mail", service: "gmail" as const, label: "工作邮箱", cred_path: "work.json" };

test("add/list/get round-trips metadata only; file is 0600 inside a 0700 dir", async () => {
  const { stateDir, store } = await setup();
  assert.equal(await store.add(ENTRY), "added");
  assert.equal(await store.add(ENTRY), "duplicate");
  assert.deepEqual(store.list(), [ENTRY]);
  assert.deepEqual(store.get("work-mail"), ENTRY);
  assert.equal(store.get("nope"), null);

  const fileStat = await stat(path.join(stateDir, "accounts.json"));
  assert.equal(fileStat.mode & 0o777, 0o600);
  const dirStat = await stat(stateDir);
  assert.equal(dirStat.mode & 0o777, 0o700);
  const onDisk = JSON.parse(
    await import("node:fs/promises").then((m) => m.readFile(path.join(stateDir, "accounts.json"), "utf8"))
  );
  assert.deepEqual(onDisk, [ENTRY]); // 只有四个白名单字段落盘
});

test("load survives restart and strips nothing valid", async () => {
  const { stateDir, store } = await setup();
  await store.add(ENTRY);
  await store.add({ id: "personal", service: "google_calendar", label: "私人日历", cred_path: "p.json" });
  const reloaded = new AccountStore(path.join(stateDir, "accounts.json"));
  await reloaded.load();
  assert.equal(reloaded.list().length, 2);
});

test("invalid entries are rejected at add: bad id, bad service, bad cred_path, extra secrets dropped", async () => {
  const { store } = await setup();
  for (const bad of [
    { ...ENTRY, id: "bad id" },
    { ...ENTRY, id: "" },
    { ...ENTRY, id: "x".repeat(65) },
    { ...ENTRY, id: "../escape" },
    { ...ENTRY, service: "bank" },
    { ...ENTRY, label: "" },
    { ...ENTRY, label: "a\nb" },
    { ...ENTRY, label: "x".repeat(65) },
    { ...ENTRY, cred_path: "../outside.json" },
    { ...ENTRY, cred_path: "/etc/passwd" },
    { ...ENTRY, cred_path: "no-ext" },
    { ...ENTRY, cred_path: "sub/dir.json" },
  ]) {
    assert.equal(await store.add(bad as any), "invalid", JSON.stringify(bad));
  }
  // 带 secret 键的条目：归一化后只剩白名单字段
  assert.equal(
    await store.add({ ...ENTRY, access_token: "LEAK", secret: 1 } as any),
    "added"
  );
  assert.deepEqual(store.get("work-mail"), ENTRY);
});

test("corrupt accounts.json refuses to load", async () => {
  const { stateDir, store } = await setup();
  await store.add(ENTRY);
  await writeFile(path.join(stateDir, "accounts.json"), "{oops");
  const again = new AccountStore(path.join(stateDir, "accounts.json"));
  await assert.rejects(again.load(), /corrupt/);
  // 混入非法条目同样拒绝
  await writeFile(
    path.join(stateDir, "accounts.json"),
    JSON.stringify([ENTRY, { id: "x", service: "evil", label: "l", cred_path: "x.json" }])
  );
  await assert.rejects(new AccountStore(path.join(stateDir, "accounts.json")).load(), /corrupt/);
});

test("resolveCredentialPath rejects traversal and non-filename paths", async () => {
  const { credDir } = await setup();
  assert.throws(() => resolveCredentialPath(credDir, "../outside.json"), /invalid_cred_path/);
  assert.throws(() => resolveCredentialPath(credDir, "a/b.json"), /invalid_cred_path/);
  assert.throws(() => resolveCredentialPath(credDir, "/abs.json"), /invalid_cred_path/);
  assert.equal(
    resolveCredentialPath(credDir, "gmail.json"),
    path.join(path.resolve(credDir), "gmail.json")
  );
});

test("verifyCredentialFile enforces 0600 and refuses symlink escapes", async () => {
  const { dir, credDir, stateDir } = await setup();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(credDir, { recursive: true });
  const credFile = path.join(credDir, "gmail.json");
  await writeFile(credFile, JSON.stringify({ access_token: "t" }));
  await chmod(credFile, 0o600);
  assert.equal(await verifyCredentialFile(credDir, "gmail.json"), credFile);

  // 权限过宽 → 拒
  await chmod(credFile, 0o644);
  await assert.rejects(verifyCredentialFile(credDir, "gmail.json"), /cred_insecure_mode/);
  await chmod(credFile, 0o600);

  // 目录外真实文件 + 目录内符号链接 → 拒
  const outside = path.join(dir, "outside.json");
  await writeFile(outside, JSON.stringify({ access_token: "t" }));
  await chmod(outside, 0o600);
  const link = path.join(credDir, "linked.json");
  await symlink(outside, link);
  await assert.rejects(verifyCredentialFile(credDir, "linked.json"), /cred_symlink_escapes_root/);

  // 缺失文件 → 拒
  await assert.rejects(verifyCredentialFile(credDir, "missing.json"), /not_file|ENOENT/);
  void stateDir;
});

test("readAccountCredentials parses a verified file; malformed json throws", async () => {
  const { credDir } = await setup();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(credDir, { recursive: true });
  const credFile = path.join(credDir, "gmail.json");
  await writeFile(credFile, JSON.stringify({ access_token: "tok", refresh_token: "rt" }));
  await chmod(credFile, 0o600);
  const creds = await readAccountCredentials(credDir, "gmail.json");
  assert.equal(creds.access_token, "tok");
  await writeFile(credFile, "[1,2]");
  await assert.rejects(readAccountCredentials(credDir, "gmail.json"), /cred_malformed/);
});

test("credPathInUse tracks remaining references to a shared credential file (L7)", async () => {
  const { store } = await setup();
  await store.add(ENTRY);
  await store.add({ id: "personal", service: "gmail", label: "私人邮箱", cred_path: "work.json" });
  assert.equal(store.credPathInUse("work.json"), true);
  assert.equal(store.credPathInUse("other.json"), false);
  await store.remove("work-mail");
  assert.equal(store.credPathInUse("work.json"), true); // personal 仍引用
  await store.remove("personal");
  assert.equal(store.credPathInUse("work.json"), false);
});

test("remove drops the entry; removeCredentialFile unlinks inside-root files only", async () => {
  const { credDir, store } = await setup();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(credDir, { recursive: true });
  const credFile = path.join(credDir, "work.json");
  await writeFile(credFile, "{}");
  await chmod(credFile, 0o600);
  await store.add(ENTRY);
  assert.equal(await store.remove("work-mail"), true);
  assert.equal(store.get("work-mail"), null);
  assert.equal(await store.remove("work-mail"), false);
  await removeCredentialFile(credDir, "work.json");
  assert.equal((await stat(credFile).catch(() => null)), null);
});
