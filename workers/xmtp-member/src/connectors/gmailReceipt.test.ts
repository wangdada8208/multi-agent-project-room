import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GmailReceiptConnector } from "./gmailReceipt.ts";

test("GmailReceiptConnector rejects credentials if permissions are not 0600", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-insecure-"));
  const credFile = path.join(dir, "token.json");
  await writeFile(credFile, JSON.stringify({ access_token: "mock-token" }));
  await chmod(credFile, 0o644);

  const connector = new GmailReceiptConnector({ credentialPath: credFile });
  await assert.rejects(
    connector.fetch("email.receipt", {
      query: "from:12306",
      date_from: "2026-10-01",
      date_to: "2026-10-10",
    }),
    /insecure permissions/i
  );
});

test("GmailReceiptConnector searches message, extracts receipt, and sanitizes personal info", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-secure-"));
  const credFile = path.join(dir, "token.json");
  await writeFile(credFile, JSON.stringify({ access_token: "mock-token" }));
  await chmod(credFile, 0o600);

  const mockRawBody = [
    "铁路电子客票通知：",
    "乘车人电话：13812345678",
    "通知邮箱：buyer@private.com",
    "G102 次 08 车 12F 号 北京南 -> 上海虹桥，票价 553.00 元。",
    "其他机密商务信息：" + "私人行程安排。".repeat(30),
  ].join("\n");

  const mockFetch = async (url: any) => {
    const urlStr = String(url);
    if (urlStr.includes("/attachments/")) {
      return { ok: true, json: async () => ({ data: Buffer.from("synthetic PDF content").toString("base64url") }) } as any;
    }
    if (urlStr.includes("/messages?")) {
      return {
        ok: true,
        json: async () => ({ messages: [{ id: "msg-123" }] }),
      } as any;
    }
    if (urlStr.includes("/messages/msg-123")) {
      return {
        ok: true,
        json: async () => ({
          id: "msg-123",
          internalDate: "1790851200000",
          payload: {
            headers: [{ name: "Subject", value: "客票 13812345678 buyer@private.com" }],
            body: {
              data: Buffer.from(mockRawBody).toString("base64url"),
            },
            parts: [
              {
                filename: "buyer@private.com.pdf",
                body: {
                  attachmentId: "att-1",
                  size: 1024,
                },
              },
            ],
          },
        }),
      } as any;
    }
    throw new Error(`Unexpected url: ${urlStr}`);
  };

  const connector = new GmailReceiptConnector({
    credentialPath: credFile,
    fetchImpl: mockFetch,
  });

  const payload: any = await connector.fetch("email.receipt", {
    query: "from:12306 subject:电子客票",
    date_from: "2026-10-01",
    date_to: "2026-10-10",
  });

  assert.equal(payload.scope, "email.receipt");
  assert.equal(payload.subject, "客票 [PHONE] [EMAIL]");
  assert.equal(payload.attachment_name.includes("buyer@private.com"), false);
  assert.equal(payload.attachment_sha256, createHash("sha256").update("synthetic PDF content").digest("hex"));

  // 必须剔除手机号与邮箱
  assert.equal(payload.body_excerpt.includes("13812345678"), false);
  assert.equal(payload.body_excerpt.includes("buyer@private.com"), false);
  assert.equal(payload.body_excerpt.includes("[PHONE]"), true);
  assert.equal(payload.body_excerpt.includes("[EMAIL]"), true);

  // 长度不超过 500
  assert.equal(payload.body_excerpt.length <= 500, true);
});
