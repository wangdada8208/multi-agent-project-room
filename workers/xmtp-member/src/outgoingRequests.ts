import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { normalizeScope } from "./canonical.ts";
import { writeJsonSecure } from "./secureFile.ts";

/**
 * 出站请求登记：本机向别人 worker 发出的每个请求都落盘（0600 原子写）。
 * 收到 consent_pending / denial / disclosure / action_result 时按此核对
 * 「这条响应是不是我真正发过的那个请求的合法响应者给的」——
 * 没有登记的 request_id、响应者不符、scope/参数哈希不符、已过有效期，一律拒。
 */
export type OutgoingKind = "data" | "action" | "task";

export interface OutgoingRequestRecord {
  request_id: string;
  /** 预期响应者（小写地址）——只有它能给这个 request 回话。 */
  to: string;
  kind: OutgoingKind;
  /** data=scope；action=动作名；task=task.run。 */
  scope: string;
  /** action 请求的 canonical 参数哈希；响应的 params_hash 必须一致。 */
  params_hash?: string;
  created_at: string;
  expires_at: string;
  /** 首个有效终态响应的标记（disclosure/action_result/denial），重复响应幂等丢弃。 */
  responded_at?: string;
  response_grant_id?: string;
}

const MAX_ENTRIES = 1000;

function normalize(raw: any): OutgoingRequestRecord | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.request_id !== "string" || typeof raw.to !== "string") return null;
  if (raw.kind !== "data" && raw.kind !== "action" && raw.kind !== "task") return null;
  if (typeof raw.scope !== "string") return null;
  if (typeof raw.created_at !== "string" || !Number.isFinite(Date.parse(raw.created_at))) return null;
  if (typeof raw.expires_at !== "string" || !Number.isFinite(Date.parse(raw.expires_at))) return null;
  return {
    request_id: raw.request_id,
    to: raw.to.toLowerCase(),
    kind: raw.kind,
    scope: normalizeScope(raw.scope),
    params_hash: typeof raw.params_hash === "string" ? raw.params_hash : undefined,
    created_at: raw.created_at,
    expires_at: raw.expires_at,
    responded_at: typeof raw.responded_at === "string" ? raw.responded_at : undefined,
    response_grant_id: typeof raw.response_grant_id === "string" ? raw.response_grant_id : undefined,
  };
}

export class OutgoingRequests {
  private items: OutgoingRequestRecord[] = [];
  private readonly responseClaims = new Set<string>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    let raw: any;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      throw new Error("Outgoing request registry is corrupt; refusing to load");
    }
    if (!Array.isArray(raw)) throw new Error("Outgoing request registry is corrupt; refusing to load");
    const items = raw.flatMap((i) => {
      const n = normalize(i);
      return n ? [n] : [];
    });
    if (items.length !== raw.length) throw new Error("Outgoing request registry is corrupt; refusing to load");
    this.items = items;
  }

  get(requestId: string): OutgoingRequestRecord | null {
    return this.items.find((i) => i.request_id === requestId) ?? null;
  }

  /** 过期请求不再接受任何响应。 */
  isExpired(req: OutgoingRequestRecord, now: Date): boolean {
    return Date.parse(req.expires_at) <= now.getTime();
  }

  async register(
    input: Omit<OutgoingRequestRecord, "to" | "scope" | "responded_at" | "response_grant_id"> & {
      to: string;
      scope: string;
    }
  ): Promise<boolean> {
    if (this.get(input.request_id)) return false;
    if (!this.makeRoom()) return false;
    this.items.push({
      ...input,
      to: input.to.toLowerCase(),
      scope: normalizeScope(input.scope),
    });
    await this.save();
    return true;
  }

  /** 仅在内存认领处理权；崩溃后由 inbox 去重与重投完成恢复，不产生持久化半状态。 */
  claimResponse(requestId: string): boolean {
    const found = this.items.find((i) => i.request_id === requestId);
    if (!found || found.responded_at || this.responseClaims.has(requestId)) return false;
    this.responseClaims.add(requestId);
    return true;
  }

  releaseResponse(requestId: string): void {
    this.responseClaims.delete(requestId);
  }

  /**
   * 首个终态响应（disclosure/action_result/denial）落标记。
   * 返回 false = 已经响应过——重复响应幂等丢弃，不报错也不覆盖。
   */
  async markResponded(requestId: string, responseGrantId: string | null, now: Date): Promise<boolean> {
    const found = this.items.find((i) => i.request_id === requestId);
    if (!found || found.responded_at) return false;
    const previousRespondedAt = found.responded_at;
    const previousGrantId = found.response_grant_id;
    found.responded_at = now.toISOString();
    if (responseGrantId) found.response_grant_id = responseGrantId;
    try {
      await this.save();
      return true;
    } catch (error) {
      found.responded_at = previousRespondedAt;
      found.response_grant_id = previousGrantId;
      throw error;
    }
  }

  private makeRoom(): boolean {
    while (this.items.length >= MAX_ENTRIES) {
      const idx = this.items.findIndex((i) => i.responded_at || Date.parse(i.expires_at) <= Date.now());
      if (idx === -1) return false;
      this.items.splice(idx, 1);
    }
    return true;
  }

  private async save(): Promise<void> {
    await writeJsonSecure(this.file, this.items);
  }
}
