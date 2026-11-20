import { readFile, stat } from "node:fs/promises";
import { validateGmailSendParams } from "./actionSchemas.ts";
import type { ActionReceipt, Connector, ExecuteContext } from "./types.ts";

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface GmailSendConnectorOptions {
  credentialPath: string;
  fetchImpl?: typeof fetch;
  /** 单次 HTTP 调用超时（含 token 刷新）；默认 15s。 */
  timeoutMs?: number;
  /** 本凭据文件对应的账户 id；params.account 与之不符时 fail-closed。 */
  accountId?: string;
}

interface GmailCredentials {
  access_token?: string;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  /** epoch ms 或 ISO 字符串；缺省视为「不知道何时过期」，靠 401 兜底。 */
  expires_at?: number | string;
}

function failed(summary: string): ActionReceipt {
  return { status: "failed", summary };
}

function uncertain(summary: string): ActionReceipt {
  return { status: "uncertain", summary };
}

/** 头字段只允许可见 ASCII：request_id 是协议外输入，注入 CR/LF 即丢头。 */
function headerSafe(value: string): string {
  return /^[\x21-\x7E]{1,128}$/.test(value) ? value : "";
}

function encodeSubject(subject: string): string {
  // 一律 RFC2047 base64 编码：非 ASCII 与特殊字符都不需要手工折叠，
  // 且 schema 已保证无控制字符，编码后不可能产生头部注入。
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function encodeBodyBase64(body: string): string {
  const b64 = Buffer.from(body, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

export function buildRawMessage(
  params: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string },
  requestId?: string
): string {
  const headerLines = [
    `To: ${params.to.join(", ")}`,
    ...(params.cc && params.cc.length > 0 ? [`Cc: ${params.cc.join(", ")}`] : []),
    ...(params.bcc && params.bcc.length > 0 ? [`Bcc: ${params.bcc.join(", ")}`] : []),
    `Subject: ${encodeSubject(params.subject)}`,
    "MIME-Version: 1.0",
    ...(requestId && headerSafe(requestId) ? [`X-MAPR-Request-Id: ${headerSafe(requestId)}`] : []),
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return `${headerLines.join("\r\n")}\r\n\r\n${encodeBodyBase64(params.body)}`;
}

/**
 * gmail.send 写动作连接器：审批链批准后调用 users.messages.send。
 * 安全语义：0600 凭据缺失/损坏/权限过宽 → failed(auth_required)；
 * 4xx 前置失败 → failed；网络错误/超时/5xx/歧义响应 → uncertain，
 * 绝不自动重试（外部副作用可能已生效）。
 */
export class GmailSendConnector implements Connector {
  readonly id: string;
  readonly scopes = ["gmail.send"];
  readonly accountId?: string;
  private readonly credentialPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GmailSendConnectorOptions) {
    this.id = options.accountId ? `gmail-send:${options.accountId}` : "gmail-send";
    this.credentialPath = options.credentialPath;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.accountId = options.accountId;
  }

  /** fetch 是数据披露接口——发信连接器只实现 execute。 */
  async fetch(scope: string): Promise<never> {
    throw new Error(`Unsupported scope: ${scope}`);
  }

  private async loadCredentials(): Promise<GmailCredentials | null> {
    let fileStat;
    try {
      fileStat = await stat(this.credentialPath);
    } catch {
      return null;
    }
    if ((fileStat.mode & 0o777) !== 0o600) return null;
    let raw: any;
    try {
      raw = JSON.parse(await readFile(this.credentialPath, "utf8"));
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.access_token !== "string" && typeof raw.refresh_token !== "string") {
      return null;
    }
    return raw as GmailCredentials;
  }

  private canRefresh(creds: GmailCredentials): boolean {
    return (
      typeof creds.refresh_token === "string" &&
      typeof creds.client_id === "string" &&
      typeof creds.client_secret === "string"
    );
  }

  private tokenExpired(creds: GmailCredentials, now: number): boolean {
    if (creds.expires_at === undefined) return false;
    const ms =
      typeof creds.expires_at === "number" ? creds.expires_at : Date.parse(creds.expires_at);
    return Number.isFinite(ms) && ms <= now + 30_000;
  }

  /** 刷新 access token；失败返回 null。任何错误都不把 secret/token 写日志或返回值。 */
  private async refreshAccessToken(creds: GmailCredentials): Promise<string | null> {
    if (!this.canRefresh(creds)) return null;
    try {
      const res = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: creds.refresh_token!,
          client_id: creds.client_id!,
          client_secret: creds.client_secret!,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      return typeof data?.access_token === "string" && data.access_token.length > 0
        ? data.access_token
        : null;
    } catch {
      return null;
    }
  }

  /** 取可用 token：过期先刷新；返回 null = 需要主人重新授权。 */
  private async accessToken(creds: GmailCredentials): Promise<string | null> {
    if (typeof creds.access_token === "string" && !this.tokenExpired(creds, Date.now())) {
      return creds.access_token;
    }
    const refreshed = await this.refreshAccessToken(creds);
    if (refreshed) return refreshed;
    return typeof creds.access_token === "string" && !this.canRefresh(creds)
      ? creds.access_token // 无刷新条件时拿现有 token 试一次——可能服务端仍有效
      : null;
  }

  private async postSend(raw: string, token: string): Promise<Response> {
    return this.fetchImpl(SEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async execute(
    action: string,
    params: Record<string, unknown>,
    context?: ExecuteContext
  ): Promise<ActionReceipt> {
    if (action !== "gmail.send") return failed("unsupported_action");
    const check = validateGmailSendParams(params);
    if (!check.ok) return failed(`invalid_params:${check.reason}`);
    if (this.accountId && typeof params.account === "string" && params.account !== this.accountId) {
      return failed("unknown_account");
    }

    const creds = await this.loadCredentials();
    if (!creds) return failed("auth_required");
    let token = await this.accessToken(creds);
    if (!token) return failed("auth_required");

    const raw = Buffer.from(
      buildRawMessage(
        {
          to: params.to as string[],
          cc: params.cc as string[] | undefined,
          bcc: params.bcc as string[] | undefined,
          subject: params.subject as string,
          body: params.body as string,
        },
        context?.request_id
      ),
      "utf8"
    ).toString("base64url");

    let res: Response;
    try {
      res = await this.postSend(raw, token);
      if (res.status === 401) {
        // 服务端判 token 失效：有刷新条件就刷一次重试，没有直接收 auth_required。
        const refreshed = await this.refreshAccessToken(creds);
        if (!refreshed) return failed("auth_required");
        token = refreshed;
        res = await this.postSend(raw, token);
        if (res.status === 401) return failed("auth_required");
      }
    } catch (err: any) {
      const name = err && typeof err === "object" ? String(err.name) : "";
      return uncertain(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error");
    }

    if (res.status >= 200 && res.status < 300) {
      let data: any;
      try {
        data = await res.json();
      } catch {
        return uncertain("unreadable_response");
      }
      const messageId = typeof data?.id === "string" && data.id.length > 0 ? data.id : null;
      if (!messageId) return uncertain("missing_message_id");
      return { status: "executed", external_id: messageId, summary: "sent" };
    }
    // 400/401/403 是发送前的确定性拒绝；其余一律按「结果不明」收口，绝不自动重试。
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return failed(res.status === 401 ? "auth_required" : `gmail_rejected_${res.status}`);
    }
    return uncertain(`gmail_status_${res.status}`);
  }
}
