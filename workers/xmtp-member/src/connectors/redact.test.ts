import assert from "node:assert/strict";
import test from "node:test";
import { excerpt } from "./redact.ts";

test("excerpt strips email addresses and replaces with [EMAIL]", () => {
  const text = "尊敬的旅客，您的电子客票已发送至 user@example.com 和 12306@rails.cn，请查收。";
  const clean = excerpt(text, 500);
  assert.equal(clean.includes("user@example.com"), false);
  assert.equal(clean.includes("12306@rails.cn"), false);
  assert.equal(clean.includes("[EMAIL]"), true);
});

test("excerpt strips 11-digit Chinese phone numbers and replaces with [PHONE]", () => {
  const text = "乘车人手机号 13812345678，紧急联系电话 +86 13987654321，车票已出。";
  const clean = excerpt(text, 500);
  assert.equal(clean.includes("13812345678"), false);
  assert.equal(clean.includes("13987654321"), false);
  assert.equal(clean.includes("[PHONE]"), true);
});

test("excerpt truncates output to max length and appends ellipsis", () => {
  const longText = "这是一段非常长的客票通知信息。".repeat(50);
  const clean = excerpt(longText, 100);
  assert.equal(clean.length <= 100, true);
  assert.equal(clean.endsWith("..."), true);
});
