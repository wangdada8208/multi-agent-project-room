import { existsSync } from "node:fs";
import { readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { writeJsonSecure } from "./secureFile.ts";

/**
 * 多外部账户登记（WP7）：.state/accounts.json 只保存账户元数据
 * {id, service, label, cred_path}——绝不存 token/secret，凭据本体在
 * credentials/ 目录下的独立 0600 JSON 文件里。
 */

export const ACCOUNT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
export const ACCOUNT_SERVICES = ["gmail", "google_calendar"] as const;
export type AccountService = (typeof ACCOUNT_SERVICES)[number];

export interface AccountEntry {
  id: string;
  service: AccountService;
  /** 给人看的账户名（如 "工作邮箱"），审批卡上展示。 */
  label: string;
  /** 凭据文件名——只允许相对凭据目录的纯文件名，绝不存绝对路径。 */
  cred_path: string;
}

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_RE.test(value);
}

export function isAccountService(value: unknown): value is AccountService {
  return typeof value === "string" && (ACCOUNT_SERVICES as readonly string[]).includes(value);
}

/** 凭据文件名字形：纯文件名 + .json，杜绝 ../、绝对路径与目录穿越。 */
export const CRED_FILE_RE = /^[a-zA-Z0-9._-]{1,128}\.json$/;

const LABEL_MAX = 64;
const LABEL_CONTROL_CHARS = /[\x00-\x1F\x7F]/;

function normalizeEntry(raw: any): AccountEntry | null {
  if (!raw || typeof raw !== "object") return null;
  if (!isAccountId(raw.id) || !isAccountService(raw.service)) return null;
  if (
    typeof raw.label !== "string" ||
    raw.label.length < 1 ||
    raw.label.length > LABEL_MAX ||
    LABEL_CONTROL_CHARS.test(raw.label)
  ) {
    return null;
  }
  if (typeof raw.cred_path !== "string" || !CRED_FILE_RE.test(raw.cred_path)) return null;
  // 只保留白名单四字段——就算有人往 accounts.json 里塞 token，load/add 都会把它剥掉。
  return { id: raw.id, service: raw.service, label: raw.label, cred_path: raw.cred_path };
}

/**
 * cred_path 的安全解析：resolve 后必须严格落在 credDir 内；
 * 调用方已先过 CRED_FILE_RE（纯文件名），这里是纵深防御。
 */
export function resolveCredentialPath(credDir: string, credPath: string): string {
  if (typeof credPath !== "string" || !CRED_FILE_RE.test(credPath)) {
    throw new Error("invalid_cred_path");
  }
  const root = path.resolve(credDir);
  const resolved = path.resolve(root, credPath);
  if (resolved !== path.join(root, path.basename(credPath)) || !resolved.startsWith(root + path.sep)) {
    throw new Error("cred_path_escapes_root");
  }
  return resolved;
}

/**
 * 加载凭据前的硬性校验：真实文件、0600、符号链接解析后仍落在凭据目录内。
 * 任何一项不满足都抛错——调用方按 auth_required/cred_unusable 收口。
 */
export async function verifyCredentialFile(credDir: string, credPath: string): Promise<string> {
  const resolved = resolveCredentialPath(credDir, credPath);
  const rootReal = await realpath(path.resolve(credDir));
  const real = await realpath(resolved); // 文件不存在时此处先抛 ENOENT
  if (!real.startsWith(rootReal + path.sep)) throw new Error("cred_symlink_escapes_root");
  const st = await stat(resolved);
  if (!st.isFile()) throw new Error("cred_not_file");
  if ((st.mode & 0o777) !== 0o600) throw new Error("cred_insecure_mode");
  return resolved;
}

/** 读账户凭据 JSON（已过全部路径/权限校验）。返回的是 secret 材料——绝不写日志。 */
export async function readAccountCredentials(
  credDir: string,
  credPath: string
): Promise<Record<string, unknown>> {
  const file = await verifyCredentialFile(credDir, credPath);
  const raw = JSON.parse(await readFile(file, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("cred_malformed");
  return raw as Record<string, unknown>;
}

export type AccountAddResult = "added" | "duplicate" | "invalid";

export class AccountStore {
  private items: AccountEntry[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** 损坏的 accounts.json 一律 fail closed——静默丢账户比报错更危险。 */
  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    let raw: any;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      throw new Error("Accounts store is corrupt; refusing to load");
    }
    if (!Array.isArray(raw)) throw new Error("Accounts store is corrupt; refusing to load");
    const items = raw.flatMap((e) => {
      const n = normalizeEntry(e);
      return n ? [n] : [];
    });
    if (items.length !== raw.length) throw new Error("Accounts store is corrupt; refusing to load");
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) throw new Error("Accounts store is corrupt; refusing to load");
      seen.add(item.id);
    }
    this.items = items;
  }

  list(): AccountEntry[] {
    return this.items.map((i) => ({ ...i }));
  }

  get(id: string): AccountEntry | null {
    const found = this.items.find((i) => i.id === id);
    return found ? { ...found } : null;
  }

  /** 同一 cred_path 可能被多个账户行共享——删凭据文件前先确认没人引用。 */
  credPathInUse(credPath: string): boolean {
    return this.items.some((i) => i.cred_path === credPath);
  }

  async add(entry: AccountEntry): Promise<AccountAddResult> {
    const normalized = normalizeEntry(entry);
    if (!normalized) return "invalid";
    if (this.items.some((i) => i.id === normalized.id)) return "duplicate";
    this.items.push(normalized);
    await writeJsonSecure(this.file, this.items);
    return "added";
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    await writeJsonSecure(this.file, this.items);
    return true;
  }
}

/**
 * 删除账户对应的凭据文件——只在能通过全部路径校验时动手，
 * 文件已被外部挪走/换成目录时如实放弃，不追删。
 */
export async function removeCredentialFile(credDir: string, credPath: string): Promise<void> {
  try {
    const resolved = resolveCredentialPath(credDir, credPath);
    const rootReal = await realpath(path.resolve(credDir));
    const real = await realpath(resolved).catch(() => null);
    if (real === null || !real.startsWith(rootReal + path.sep)) return;
    await unlink(resolved);
  } catch {
    // 凭据清理是尽力而为：accounts.json 已去掉引用，残留文件由主人手工清。
  }
}
