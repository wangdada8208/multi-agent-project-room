const EMAIL_REGEX = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
const PHONE_REGEX = /(?:\+?86[- ]?)?1[3-9]\d{1}[- ]?\d{4}[- ]?\d{4}/g;

export function excerpt(text: string, max: number): string {
  if (!text) return "";
  let sanitized = text
    .replace(EMAIL_REGEX, "[EMAIL]")
    .replace(PHONE_REGEX, "[PHONE]");

  if (sanitized.length <= max) {
    return sanitized;
  }
  const sliceLen = Math.max(0, max - 3);
  return sanitized.slice(0, sliceLen) + "...";
}
