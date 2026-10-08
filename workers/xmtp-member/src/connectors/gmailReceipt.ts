import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { excerpt } from "./redact.ts";
import type { Connector, EmailReceiptConstraints, EmailReceiptPayload } from "./types.ts";

export interface GmailReceiptConnectorOptions {
  credentialPath: string;
  fetchImpl?: typeof fetch;
}

export class GmailReceiptConnector implements Connector {
  readonly id = "gmail-receipt";
  readonly scopes = ["email.receipt"];
  private readonly credentialPath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GmailReceiptConnectorOptions) {
    this.credentialPath = options.credentialPath;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async loadToken(): Promise<string> {
    const fileStat = await stat(this.credentialPath);
    const mode = fileStat.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `Insecure permissions on credential file: expected 0600, got 0${mode.toString(8)}`
      );
    }
    const raw = JSON.parse(await readFile(this.credentialPath, "utf8"));
    if (!raw?.access_token) {
      throw new Error("Missing access_token in credential file");
    }
    return raw.access_token;
  }

  async fetch(scope: string, constraints: unknown): Promise<EmailReceiptPayload> {
    if (scope !== "email.receipt") {
      throw new Error(`Unsupported scope: ${scope}`);
    }
    const { query, date_from, date_to } = (constraints || {}) as EmailReceiptConstraints;
    if (typeof query !== "string" || !query.trim() || query.length > 200 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date_from) || !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
      throw new Error("Invalid receipt query constraints");
    }
    const token = await this.loadToken();

    const qParts = [query || ""];
    if (date_from) qParts.push(`after:${date_from}`);
    if (date_to) qParts.push(`before:${date_to}`);
    const q = encodeURIComponent(qParts.join(" ").trim());

    const listRes = await this.fetchImpl(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=1`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!listRes.ok) {
      throw new Error(`Gmail list messages failed: ${listRes.status}`);
    }
    const listData: any = await listRes.json();
    const msgId = listData?.messages?.[0]?.id;
    if (!msgId) {
      throw new Error("No matching receipt email found");
    }

    const msgRes = await this.fetchImpl(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!msgRes.ok) {
      throw new Error(`Gmail get message failed: ${msgRes.status}`);
    }
    const msgData: any = await msgRes.json();

    const headers = msgData?.payload?.headers || [];
    const subjectHeader = headers.find(
      (h: any) => typeof h.name === "string" && h.name.toLowerCase() === "subject"
    );
    const subject = subjectHeader?.value || "无主题";

    const internalDate = msgData?.internalDate
      ? new Date(Number(msgData.internalDate)).toISOString()
      : new Date().toISOString();

    const parts: any[] = [];
    function collect(part: any): void {
      if (!part) return;
      parts.push(part);
      for (const nested of part.parts || []) collect(nested);
    }
    collect(msgData?.payload);
    const rawBody = parts.filter(p => !p.filename && p.body?.data)
      .map(p => Buffer.from(p.body.data, "base64url").toString("utf8")).join("\n");

    let attachmentName: string | null = null;
    let attachmentSha256: string | null = null;
    {
      for (const part of parts) {
        if (part?.filename && part.filename.length > 0) {
          attachmentName = excerpt(part.filename, 200);
          if (part.body?.size > 5 * 1024 * 1024) throw new Error("Receipt attachment is too large");
          let encoded = part.body?.data;
          if (!encoded && part.body?.attachmentId) {
            const attachmentResponse = await this.fetchImpl(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!attachmentResponse.ok) throw new Error(`Gmail attachment request failed: ${attachmentResponse.status}`);
            encoded = (await attachmentResponse.json() as any).data;
          }
          if (typeof encoded !== "string" || encoded.length > 7 * 1024 * 1024) {
            throw new Error("Receipt attachment data is missing or too large");
          }
          const bytes = Buffer.from(encoded, "base64url");
          if (bytes.length > 5 * 1024 * 1024) throw new Error("Receipt attachment is too large");
          attachmentSha256 = createHash("sha256").update(bytes).digest("hex");
          break;
        }
      }
    }

    return {
      scope: "email.receipt",
      subject: excerpt(subject, 200),
      sent_at: internalDate,
      attachment_name: attachmentName,
      attachment_sha256: attachmentSha256,
      body_excerpt: excerpt(rawBody, 500),
    };
  }
}
