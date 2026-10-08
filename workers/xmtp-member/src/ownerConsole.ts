import { validConnectRedirect } from "./connectSdk.ts";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { Connector } from "./connectors/types.ts";
import { findConnector } from "./connectors/registry.ts";
import type { ConsentQueue } from "./consentQueue.ts";
import { buildGrant, signGrant } from "./grant.ts";
import type { InboxEntry } from "./inbox.ts";
import { buildLedgerEntry, type LedgerEntry } from "./ledger.ts";
import { checkLocalRequest, OWNER_HEADER } from "./localGuard.ts";
import { CONNECT_AUTHORIZE_HTML, OWNER_CONSOLE_HTML } from "./ownerConsoleHtml.ts";
import type { OwnerNote } from "./ownerNote.ts";
import { allowOwnerNotesOrigin, handleOwnerNotes } from "./ownerNotesHttp.ts";
import { scoreboard, type ScoreboardItem } from "./scoreboard.ts";
import type { TaskRecord } from "./taskStore.ts";

export interface OwnerConsoleDeps {
  selfAddress: string;
  privateKey?: string;
  role?: string;
  queue: ConsentQueue;
  connectors?: Connector[];
  readLedger: () => Promise<LedgerEntry[]>;
  readInbox: () => Promise<InboxEntry[]>;
  readOwnerNotes: () => Promise<OwnerNote[]>;
  appendLedger?: (entry: LedgerEntry) => Promise<void>;
  readScoreboard?: () => Promise<ScoreboardItem[]> | ScoreboardItem[];
  readTasks?: () => Promise<TaskRecord[]> | TaskRecord[];
  approve: (requestId: string) => Promise<{ ok: boolean; reason?: string }>;
  deny: (requestId: string) => Promise<{ ok: boolean; reason?: string }>;
  sendRequest: (body: any) => Promise<{ ok: boolean; reason?: string; request_id?: string }>;
  sendTask?: (body: any) => Promise<{ ok: boolean; reason?: string; request_id?: string }>;
}

const MAX_BODY = 16 * 1024;

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function createOwnerConsoleServer(deps: OwnerConsoleDeps): http.Server {
  return http.createServer(async (req, res) => {
    const host = req.headers.host || "";
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = (req.method || "GET").toUpperCase();

    if (url.pathname === "/owner-notes") {
      const allowed = allowOwnerNotesOrigin(origin);
      if (allowed) {
        res.setHeader("Access-Control-Allow-Origin", allowed);
        res.setHeader("Vary", "Origin");
      }
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const result = await handleOwnerNotes({ host, notes: await deps.readOwnerNotes() });
      sendJson(res, result.status, result.body);
      return;
    }

    const ownerHeader = req.headers[OWNER_HEADER];
    if (
      !checkLocalRequest({
        method,
        host,
        origin,
        ownerHeader: Array.isArray(ownerHeader) ? ownerHeader[0] : ownerHeader,
      })
    ) {
      sendJson(res, 403, { ok: false, reason: "forbidden" });
      return;
    }

    try {
      if (method === "GET" && url.pathname === "/") {
        const script = OWNER_CONSOLE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
        const scriptHash = createHash("sha256").update(script).digest("base64");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'self'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
        });
        res.end(OWNER_CONSOLE_HTML);
        return;
      }
      if (method === "GET" && url.pathname === "/connect/authorize") {
        const script = CONNECT_AUTHORIZE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
        const scriptHash = createHash("sha256").update(script).digest("base64");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'self'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
        });
        res.end(CONNECT_AUTHORIZE_HTML);
        return;
      }
      if (method === "GET" && url.pathname === "/api/state") {
        const ledger = await deps.readLedger();
        sendJson(res, 200, {
          self: deps.selfAddress,
          role: deps.role || "member",
          consents: deps.queue.list(),
          inbox: await deps.readInbox(),
          ledger,
          scoreboard: deps.readScoreboard ? await deps.readScoreboard() : scoreboard(ledger),
          tasks: deps.readTasks ? await deps.readTasks() : [],
        });
        return;
      }
      const consentMatch = url.pathname.match(/^\/api\/consents\/([^/]+)\/(approve|deny)$/);
      if (method === "POST" && consentMatch) {
        const id = decodeURIComponent(consentMatch[1]);
        const result = consentMatch[2] === "approve" ? await deps.approve(id) : await deps.deny(id);
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }
      if (method === "POST" && url.pathname === "/api/connect/approve") {
        if (deps.role === "observer") {
          sendJson(res, 403, { ok: false, reason: "observer_readonly" });
          return;
        }
        const body = await readJson(req);
        if (!validConnectRedirect(body.redirect_uri)) {
          sendJson(res, 400, { ok: false, reason: "invalid_redirect" });
          return;
        }
        const appId = String(body.app_id || "unknown-app");
        const scope = String(body.scope || "");
        const connector = findConnector(scope, deps.connectors || []);
        if (!connector || !deps.privateKey) {
          sendJson(res, 400, { ok: false, reason: "no_connector" });
          return;
        }
        const payload = await connector.fetch(scope, body.constraints);
        const grant = buildGrant({
          owner: deps.selfAddress,
          audience: appId,
          requestId: randomUUID(),
          scope,
          constraints: body.constraints || { date_from: "", date_to: "" },
          payload,
          now: new Date(),
        });
        const signature = await signGrant(grant, deps.privateKey);
        if (deps.appendLedger) {
          await deps.appendLedger(
            buildLedgerEntry({
              now: new Date(),
              kind: "consent_approved",
              peer: appId,
              scope,
              payloadHash: grant.payload_hash,
            })
          );
        }
        const redirect_uri = body.redirect_uri;
        const redirect_url = redirect_uri
          ? `${redirect_uri}#grant=${encodeURIComponent(JSON.stringify(grant))}&signature=${encodeURIComponent(signature)}&data=${encodeURIComponent(JSON.stringify(payload))}`
          : undefined;
        sendJson(res, 200, { ok: true, grant, signature, payload, redirect_url });
        return;
      }
      if (method === "POST" && url.pathname === "/api/connect/deny") {
        const body = await readJson(req);
        if (!validConnectRedirect(body.redirect_uri)) {
          sendJson(res, 400, { ok: false, reason: "invalid_redirect" });
          return;
        }
        const appId = String(body.app_id || "unknown-app");
        const scope = String(body.scope || "");
        if (deps.appendLedger) {
          await deps.appendLedger(
            buildLedgerEntry({
              now: new Date(),
              kind: "consent_denied",
              peer: appId,
              scope,
              reason: "user_denied",
            })
          );
        }
        const redirect_uri = body.redirect_uri;
        const redirect_url = redirect_uri ? `${redirect_uri}#error=user_denied` : undefined;
        sendJson(res, 200, { ok: false, reason: "user_denied", redirect_url });
        return;
      }
      if (method === "POST" && url.pathname === "/api/requests") {
        if (deps.role === "observer") {
          sendJson(res, 403, { ok: false, reason: "observer_readonly" });
          return;
        }
        const result = await deps.sendRequest(await readJson(req));
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      if (method === "POST" && url.pathname === "/api/tasks") {
        if (deps.role === "observer") {
          sendJson(res, 403, { ok: false, reason: "observer_readonly" });
          return;
        }
        if (!deps.sendTask) {
          sendJson(res, 501, { ok: false, reason: "not_implemented" });
          return;
        }
        const result = await deps.sendTask(await readJson(req));
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      sendJson(res, 404, { ok: false, reason: "not_found" });
    } catch (err: any) {
      sendJson(res, 500, { ok: false, reason: err.message || "server_error" });
    }
  });
}
