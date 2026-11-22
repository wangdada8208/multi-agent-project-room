/**
 * 规范化序列化与输入形状上限。
 * canonicalStringify 递归排序对象键——跨语言实现都能复现同一哈希；
 * paramsShapeOk 防深层/超宽参数让 JSON.stringify 或哈希计算变成投递面。
 */

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** 与 JSON.stringify 一样丢弃 undefined 对象键，但键序稳定。 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** scope/action 一律小写去空白后才进裁决与持久化，杜绝 "PAYMENT.send"/" payment.x" 绕过。 */
export function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase();
}

export const MAX_PARAM_DEPTH = 8;
export const MAX_PARAM_KEYS = 128;
export const MAX_PARAM_ARRAY = 200;
export const MAX_PARAM_BYTES = 8192;

/** 参数形状上限：嵌套深度、总键数（共享预算）、单数组长度。 */
export function paramsShapeOk(value: unknown): boolean {
  return checkShape(value, 0, { keys: MAX_PARAM_KEYS });
}

function checkShape(value: unknown, depth: number, budget: { keys: number }): boolean {
  if (depth > MAX_PARAM_DEPTH) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) {
    if (value.length > MAX_PARAM_ARRAY) return false;
    return value.every((v) => checkShape(v, depth + 1, budget));
  }
  const keys = Object.keys(value as Record<string, unknown>);
  budget.keys -= keys.length;
  if (budget.keys < 0) return false;
  for (const k of keys) {
    if (!checkShape((value as Record<string, unknown>)[k], depth + 1, budget)) return false;
  }
  return true;
}
