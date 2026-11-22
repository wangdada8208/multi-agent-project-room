import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify } from "./canonical.ts";

export type LedgerKind =
  | "sender_dropped"
  | "request_sent"
  | "request_denied"
  | "request_queued"
  | "consent_approved"
  | "consent_denied"
  | "consent_expired"
  | "send_failed"
  | "disclosure_stored"
  | "disclosure_rejected"
  | "denial_received"
  | "pending_received"
  | "task_sent"
  | "verdict_sent"
  | "task_escalated"
  | "member_revoked_received"
  | "auto_approved"
  | "auto_approve_failed"
  | "action_queued"
  | "action_finished"
  | "action_tampered"
  | "action_result_received"
  | "action_result_rejected"
  | "receipt_resent"
  | "recovered_uncertain"
  | "unmatched_response";

export interface LedgerEntry {
  at: string;
  kind: LedgerKind;
  request_id: string | null;
  peer: string | null;
  /** 事件的发送者（如 member_revoked 的广播者）；与 peer（事件对象）区分。 */
  sender?: string | null;
  scope: string | null;
  reason: string | null;
  payload_hash: string | null;
  /** 防篡改链字段：由 appendLedger 写入，历史遗留行没有这些字段。 */
  seq?: number;
  prev_hash?: string;
  entry_hash?: string;
}

/** 链起点占位：第一条带链 entry 的 prev_hash，seq 视同为 0。 */
export const LEDGER_GENESIS_PREV_HASH = "GENESIS";

export function buildLedgerEntry(input: {
  now: Date;
  kind: LedgerKind;
  requestId?: string | null;
  peer?: string | null;
  sender?: string | null;
  scope?: string | null;
  reason?: string | null;
  payloadHash?: string | null;
}): LedgerEntry {
  return {
    at: input.now.toISOString(),
    kind: input.kind,
    request_id: input.requestId ?? null,
    peer: input.peer ? input.peer.toLowerCase() : null,
    sender: input.sender ? input.sender.toLowerCase() : null,
    scope: input.scope ?? null,
    reason: input.reason ?? null,
    payload_hash: input.payloadHash ?? null,
  };
}

/**
 * 单条 entry 的链上哈希：sha256(prev_hash + "|" + canonical(entry 去掉 entry_hash))。
 * seq 与 prev_hash 也在哈希覆盖范围内，改序号本身就会破坏哈希。
 */
export function computeEntryHash(prevHash: string, entry: LedgerEntry): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key !== "entry_hash") body[key] = value;
  }
  return createHash("sha256")
    .update(prevHash + "|" + canonicalStringify(body))
    .digest("hex");
}

const appendChains = new Map<string, Promise<void>>();

async function lastChainedEntry(file: string): Promise<{ seq: number; entry_hash: string }> {
  const genesis = { seq: 0, entry_hash: LEDGER_GENESIS_PREV_HASH };
  if (!existsSync(file)) return genesis;
  const content = await readFile(file, "utf8");
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        Number.isInteger(parsed.seq) &&
        typeof parsed.prev_hash === "string" &&
        typeof parsed.entry_hash === "string"
      ) {
        return { seq: parsed.seq, entry_hash: parsed.entry_hash };
      }
    } catch {
      // 行损坏不影响找上一条带链 entry；verify 阶段会如实上报。
    }
  }
  return genesis;
}

async function appendChained(file: string, entry: LedgerEntry): Promise<void> {
  const prev = await lastChainedEntry(file);
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    // 调用方传入的旧链字段一律丢弃，链字段只能由本函数按文件现状生成。
    if (key === "seq" || key === "prev_hash" || key === "entry_hash") continue;
    base[key] = value;
  }
  const chained: LedgerEntry = {
    ...(base as unknown as LedgerEntry),
    seq: prev.seq + 1,
    prev_hash: prev.entry_hash,
  };
  chained.entry_hash = computeEntryHash(chained.prev_hash as string, chained);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await appendFile(file, JSON.stringify(chained) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

/** 同文件追加按解析后的路径串行，避免并发追加把链写成两条分叉。 */
export async function appendLedger(file: string, entry: LedgerEntry): Promise<void> {
  const key = path.resolve(file);
  const previous = appendChains.get(key) ?? Promise.resolve();
  const run = previous.then(() => appendChained(file, entry));
  const tail = run.catch(() => {});
  appendChains.set(key, tail);
  try {
    await run;
  } finally {
    if (appendChains.get(key) === tail) appendChains.delete(key);
  }
}

export async function readLedger(file: string): Promise<LedgerEntry[]> {
  if (!existsSync(file)) return [];
  const content = await readFile(file, "utf8");
  const out: LedgerEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** 锚定检查点里 verifyLedger 真正消费的部分；完整签名结构见 activity.ts。 */
export interface LedgerAnchor {
  head_seq: number;
  head_hash: string;
}

export type LedgerIntegrityCode =
  | "malformed_line"
  | "chain_fields_incomplete"
  | "entry_hash_mismatch"
  | "prev_link_mismatch"
  | "sequence_gap"
  | "unchained_after_chain"
  | "anchor_truncated"
  | "anchor_missing"
  | "anchor_hash_mismatch";

export interface LedgerIntegrityIssue {
  code: LedgerIntegrityCode;
  /** 1-based 行号（数组校验时为 1-based 下标）。 */
  line: number;
  detail?: string;
}

export interface LedgerVerifyResult {
  ok: boolean;
  /** 非空行总数（含无法解析的行）。 */
  total_lines: number;
  chained_entries: number;
  /** 没有链字段的 entry：只能如实标为未验证，不能宣称追溯防篡改。 */
  legacy_unverified_entries: number;
  malformed_lines: number;
  head: { seq: number; entry_hash: string } | null;
  issues: LedgerIntegrityIssue[];
}

interface SequenceVerifyOut {
  chained: number;
  legacy: number;
  head: { seq: number; entry_hash: string } | null;
  issues: LedgerIntegrityIssue[];
}

function verifySequence(
  entries: LedgerEntry[],
  opts?: { anchoredCheckpoint?: LedgerAnchor; firstLine?: number },
): SequenceVerifyOut {
  const issues: LedgerIntegrityIssue[] = [];
  const bySeq = new Map<number, string>();
  let chained = 0;
  let legacy = 0;
  let chainStarted = false;
  let prevSeq = 0;
  let prevHash = LEDGER_GENESIS_PREV_HASH;
  entries.forEach((entry, i) => {
    const line = (opts?.firstLine ?? 1) + i;
    const hasSeq = Number.isInteger(entry.seq);
    const hasPrev = typeof entry.prev_hash === "string";
    const hasHash = typeof entry.entry_hash === "string";
    if (!(hasSeq && hasPrev && hasHash)) {
      if (hasSeq || hasPrev || hasHash) {
        issues.push({ code: "chain_fields_incomplete", line, detail: "entry has some but not all chain fields" });
      } else if (chainStarted) {
        // 链已开始后出现无链字段的行：无法证明它与链的先后关系。
        issues.push({ code: "unchained_after_chain", line });
        legacy += 1;
      } else {
        legacy += 1;
      }
      return;
    }
    chainStarted = true;
    chained += 1;
    const seq = entry.seq as number;
    const prev = entry.prev_hash as string;
    const hash = entry.entry_hash as string;
    if (seq !== prevSeq + 1) {
      issues.push({ code: "sequence_gap", line, detail: `expected seq ${prevSeq + 1}, got ${seq}` });
    }
    if (prev !== prevHash) {
      issues.push({ code: "prev_link_mismatch", line, detail: `prev_hash does not match entry_hash of seq ${prevSeq}` });
    }
    if (hash !== computeEntryHash(prev, entry)) {
      issues.push({ code: "entry_hash_mismatch", line });
    }
    bySeq.set(seq, hash);
    prevSeq = seq;
    prevHash = hash;
  });
  const head = chained > 0 ? { seq: prevSeq, entry_hash: prevHash } : null;
  const anchor = opts?.anchoredCheckpoint;
  if (anchor && anchor.head_seq > 0) {
    if (!head || head.seq < anchor.head_seq) {
      issues.push({
        code: "anchor_truncated",
        line: entries.length,
        detail: `ledger head seq ${head?.seq ?? 0} is behind anchored head_seq ${anchor.head_seq}`,
      });
    } else {
      const anchoredHash = bySeq.get(anchor.head_seq);
      if (anchoredHash === undefined) {
        issues.push({ code: "anchor_missing", line: entries.length, detail: `no chained entry at anchored seq ${anchor.head_seq}` });
      } else if (anchoredHash !== anchor.head_hash) {
        issues.push({ code: "anchor_hash_mismatch", line: entries.length, detail: "entry at anchored seq does not match anchored head_hash" });
      }
    }
  }
  return { chained, legacy, head, issues };
}

/** 校验已解析的 entry 数组（不含原始行，故无法报告 malformed_lines）。 */
export function verifyLedgerEntries(
  entries: LedgerEntry[],
  opts?: { anchoredCheckpoint?: LedgerAnchor },
): LedgerVerifyResult {
  const out = verifySequence(entries, opts);
  return {
    ok: out.issues.length === 0,
    total_lines: entries.length,
    chained_entries: out.chained,
    legacy_unverified_entries: out.legacy,
    malformed_lines: 0,
    head: out.head,
    issues: out.issues,
  };
}

/**
 * 校验账本文件：
 * - 无链字段的旧 entry 如实归为 legacy_unverified，不宣称追溯防篡改；
 * - 检测篡改（entry_hash 不匹配）、重排/断链（prev_hash 不匹配）、序号缺口；
 * - 传入 anchoredCheckpoint 时检测相对锚点的截断与锚点后历史改写。
 */
export async function verifyLedger(
  file: string,
  opts?: { anchoredCheckpoint?: LedgerAnchor },
): Promise<LedgerVerifyResult> {
  if (!existsSync(file)) {
    return {
      ok: true,
      total_lines: 0,
      chained_entries: 0,
      legacy_unverified_entries: 0,
      malformed_lines: 0,
      head: null,
      issues: [],
    };
  }
  const content = await readFile(file, "utf8");
  const entries: LedgerEntry[] = [];
  const issues: LedgerIntegrityIssue[] = [];
  let total = 0;
  let malformed = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total += 1;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      malformed += 1;
      issues.push({ code: "malformed_line", line: total, detail: "line is not valid JSON" });
    }
  }
  const out = verifySequence(entries, { ...opts, firstLine: 1 });
  // verifySequence 的 line 基于解析后下标；损坏行会让行号偏移，逐条重算成本不值，
  // 行号语义注释已写明是解析序号，损坏行本身单列。
  issues.push(...out.issues);
  return {
    ok: issues.length === 0,
    total_lines: total,
    chained_entries: out.chained,
    legacy_unverified_entries: out.legacy,
    malformed_lines: malformed,
    head: out.head,
    issues,
  };
}
