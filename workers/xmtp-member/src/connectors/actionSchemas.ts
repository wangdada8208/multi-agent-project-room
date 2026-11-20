import { normalizeScope } from "../canonical.ts";

/**
 * 每动作参数校验注册表——action_request 入队前的最后一道形状检查。
 * decode 层只保证 params 是可解析、不超深的 JSON；这里按动作定义
 * 「哪些键合法、每个值什么形状」，未知键一律拒（白名单制，不透传）。
 * 校验返回的 reason 只含字段级机械描述（会进账本），绝不回显参数值。
 */

export type ParamCheck = { ok: true } | { ok: false; reason: string };

export type ActionParamValidator = (params: unknown) => ParamCheck;

const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
// 邮件正文允许 \t \r \n（真实换行），其余控制字符（\x00-\x08 \x0B \x0C \x0E-\x1F \x7F）拒绝。
const BODY_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
// RFC5322 常用形态的务实子集：本域允许点分 atom，域名要求点分标签、不以连字符开头结尾。
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const ACCOUNT_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_EMAIL_LEN = 254;
const MAX_TO = 20;

function fail(reason: string): ParamCheck {
  return { ok: false, reason };
}

function isEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_EMAIL_LEN &&
    !CONTROL_CHARS.test(value) &&
    EMAIL_RE.test(value)
  );
}

function checkEmailList(value: unknown, key: string, min: number): ParamCheck {
  if (!Array.isArray(value)) return fail(`${key}_not_list`);
  if (value.length < min || value.length > MAX_TO) return fail(`${key}_count`);
  for (const entry of value) {
    if (!isEmail(entry)) return fail(`${key}_invalid_email`);
  }
  return { ok: true };
}

export function validateGmailSendParams(params: unknown): ParamCheck {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return fail("params_not_object");
  }
  const record = params as Record<string, unknown>;
  const ALLOWED = new Set(["to", "cc", "bcc", "subject", "body", "account"]);
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) return fail(`unknown_key:${key}`);
  }

  const to = checkEmailList(record.to, "to", 1);
  if (!to.ok) return to;
  if (record.cc !== undefined) {
    const cc = checkEmailList(record.cc, "cc", 0);
    if (!cc.ok) return cc;
  }
  if (record.bcc !== undefined) {
    const bcc = checkEmailList(record.bcc, "bcc", 0);
    if (!bcc.ok) return bcc;
  }

  if (typeof record.subject !== "string" || record.subject.length < 1 || record.subject.length > 200) {
    return fail("subject_length");
  }
  if (CONTROL_CHARS.test(record.subject)) return fail("subject_control_chars");

  if (typeof record.body !== "string" || record.body.length < 1) return fail("body_empty");
  if (Buffer.byteLength(record.body, "utf8") > 32 * 1024) return fail("body_too_large");
  if (BODY_CONTROL_CHARS.test(record.body)) return fail("body_control_chars");

  if (record.account !== undefined) {
    if (typeof record.account !== "string" || !ACCOUNT_RE.test(record.account)) {
      return fail("account_invalid");
    }
  }
  return { ok: true };
}

const SCHEMAS: Record<string, ActionParamValidator> = {
  "gmail.send": validateGmailSendParams,
};

export function hasActionSchema(action: string): boolean {
  return normalizeScope(action) in SCHEMAS;
}

/**
 * 动作参数校验：schema 缺失即拒（写动作必须显式登记校验器，不能裸跑任意 params）。
 * action 预期已规范化；这里再 normalize 一次防大小写绕过。
 */
export function validateActionParams(action: string, params: unknown): ParamCheck {
  const validator = SCHEMAS[normalizeScope(action)];
  if (!validator) return fail("no_schema");
  return validator(params);
}
