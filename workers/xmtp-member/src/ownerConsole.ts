import http from "node:http";
import type { ConsentQueue } from "./consentQueue.ts";
import type { InboxEntry } from "./inbox.ts";
import type { LedgerEntry } from "./ledger.ts";
import { checkLocalRequest, OWNER_HEADER } from "./localGuard.ts";
import { OWNER_CONSOLE_HTML } from "./ownerConsoleHtml.ts";
import type { OwnerNote } from "./ownerNote.ts";
import { allowOwnerNotesOrigin, handleOwnerNotes } from "./ownerNotesHttp.ts";

export interface OwnerConsoleDeps {
  selfAddress: string;
  queue: ConsentQueue;
  readLedger: () => Promise<LedgerEntry[]>;
  readInbox: () => Promise<InboxEntry[]>;
  readOwnerNotes: () => Promise<OwnerNote[]>;
  approve: (requestId: string) => Promise<{ ok: boolean; reason?: string }>;
  deny: (requestId: string) => Promise<{ ok: boolean; reason?: string }>;
  sendRequest: (body: any) => Promise<{ ok: boolean; reason?: string; request_id?: string }>;
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
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        });
        res.end(OWNER_CONSOLE_HTML);
        return;
      }
      if (method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, {
          self: deps.selfAddress,
          consents: deps.queue.list(),
          inbox: await deps.readInbox(),
          ledger: await deps.readLedger(),
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
      if (method === "POST" && url.pathname === "/api/requests") {
        const result = await deps.sendRequest(await readJson(req));
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      sendJson(res, 404, { ok: false, reason: "not_found" });
    } catch (err: any) {
      sendJson(res, 400, { ok: false, reason: err?.message === "body too large" ? "body_too_large" : "bad_request" });
    }
  });
}
