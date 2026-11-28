import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, lstat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { MemberAccess } from "./capabilities.ts";
import type { RoomInbox } from "./roomInbox.ts";
import { writeJsonSecure } from "./secureFile.ts";

export const MCP_CONNECTION_FILE = "mcp.json";
const approvalId = z.uuid();
const sendArgs = { roomId: z.string().min(1), text: z.string().min(1).max(4000) };
const approvedSend = z.object({ ...sendArgs, expiresAt: z.number() });
const approvalPath = (dir: string, id: string) => path.join(dir, "mcp-approvals", id + ".json");

export async function authorizeMcpSend(dir: string, roomId: string, text: string): Promise<string> {
  const approved = approvedSend.parse({ roomId, text, expiresAt: Date.now() + 5 * 60_000 });
  const id = globalThis.crypto.randomUUID();
  await writeJsonSecure(approvalPath(dir, id), approved);
  return id;
}

async function consumeApproval(dir: string, id: string, roomId: string, text: string): Promise<boolean> {
  const file = approvalPath(dir, id);
  try {
    const info = await lstat(file);
    if (!info.isFile() || (info.mode & 0o077)) return false;
    const record = approvedSend.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!record.success) return false;
    if (record.data.expiresAt <= Date.now()) {
      await unlink(file);
      return false;
    }
    if (record.data.roomId !== roomId || record.data.text !== text) return false;
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

type Room = { id: string; name: string; inbox: RoomInbox };
type McpOptions = MemberAccess & {
  stateDir: string;
  room: () => Promise<Room | null>;
  connected: () => boolean;
  send: (roomId: string, text: string) => Promise<void>;
  audit: (reason: string) => void;
};

const roomArgs = { roomId: z.string().optional() };
const inboxArgs = {
  ...roomArgs,
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  peek: z.boolean().optional(),
  ack: z.boolean().optional(),
  summary: z.boolean().optional(),
};
const toolCall = z.object({ method: z.literal("tools/call"), params: z.object({ name: z.string() }) });

function result(value: unknown, isError = false) {
  return { isError, content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > 32_768) throw new Error("request_too_large");
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startLocalMcp(options: McpOptions) {
  if (!options.caps.has("mcp")) {
    options.audit("capability_denied:mcp");
    throw new Error("capability_denied:mcp");
  }

  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const stopped = new AbortController();
  const makeTools = (signal: AbortSignal) => {
    const mcp = new McpServer({ name: "parlor", version: "0.1.0" });
    const withRoom = async (roomId: string | undefined, run: (room: Room) => Promise<unknown>) => {
      try {
        const room = await options.room();
        if (signal.aborted || !room || (roomId && room.id !== roomId)) return result({ reason: "room_unavailable" }, true);
        return result(await run(room));
      } catch (error) {
        const publicReasons = ["invalid_cursor", "peek_cannot_ack", "wait_cancelled",
          "send_rejected", "capability_denied:watch", "approval_required", "room_unavailable"];
        const reason = error instanceof Error && publicReasons.includes(error.message) ?
          error.message : "local_operation_failed";
        options.audit(reason);
        return result({ reason }, true);
      }
    };
    mcp.registerTool("parlor_status", { description: "Read this local Parlor seat status and capabilities" }, async () => {
      const room = await options.room();
      return result({ connected: options.connected(), caps: [...options.caps],
        roomCount: room ? 1 : 0, mode: options.mode, cursor: room?.inbox.status ?? null });
    });
    mcp.registerTool("parlor_rooms", { description: "List encryption groups available to this Parlor seat" }, async () => {
      const room = await options.room();
      return result(room ? [{ id: room.id, name: room.name, mode: options.mode, ...room.inbox.status }] : []);
    });
    mcp.registerTool("parlor_inbox", { description: "Read local trust-framed room messages", inputSchema: inboxArgs },
      (args) => withRoom(args.roomId, async (room) => {
        if (args.summary) {
          if (!options.caps.has("watch")) throw new Error("capability_denied:watch");
          if (args.ack) throw new Error("peek_cannot_ack");
          return { summary: room.inbox.summary() };
        }
        return room.inbox.read(args);
      }));
    mcp.registerTool("parlor_inbox_ack", { description: "Acknowledge a delivered room cursor",
      inputSchema: { ...roomArgs, cursor: z.number().int().nonnegative() } },
    (args) => withRoom(args.roomId, async (room) => ({ acknowledged: await room.inbox.ack(args.cursor) })));
    mcp.registerTool("parlor_wait", { description: "Wait for trust-framed room messages",
      inputSchema: { ...inboxArgs, timeoutMs: z.number().int().min(0).max(30_000).optional() } },
    (args, extra) => withRoom(args.roomId, async (room) => {
      if (args.summary && !options.caps.has("watch")) throw new Error("capability_denied:watch");
      if (args.summary && args.ack) throw new Error("peek_cannot_ack");
      const waited = await room.inbox.wait(args.summary ? { ...args, peek: true } : args,
        args.timeoutMs ?? 25_000, AbortSignal.any([signal, extra.signal]));
      return args.summary ? { summary: room.inbox.summary() } : waited;
    }));
    if (options.caps.has("send")) {
      mcp.registerTool("parlor_reply", { description: "Send owner-approved text through the local XMTP seat",
        inputSchema: { ...sendArgs, approval: approvalId } },
      (args) => withRoom(args.roomId, async (room) => {
        if (!(await consumeApproval(options.stateDir, args.approval, room.id, args.text))) {
          throw new Error("approval_required");
        }
        if (signal.aborted) throw new Error("room_unavailable");
        await options.send(room.id, args.text);
        return { sent: true };
      }));
    }
    return mcp;
  };

  let inFlight = 0;
  let host = "";
  const server = createServer({ requestTimeout: 35_000, headersTimeout: 5_000 }, async (req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403).end();
      return;
    }
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (inFlight >= 16 || stopped.signal.aborted) {
      res.writeHead(503).end();
      return;
    }
    inFlight++;
    const disconnected = new AbortController();
    res.once("close", () => disconnected.abort());
    const mcp = makeTools(AbortSignal.any([stopped.signal, disconnected.signal]));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      const body = await parseBody(req);
      const call = toolCall.safeParse(body);
      if (call.success && call.data.params.name === "parlor_reply" && !options.caps.has("send")) {
        options.audit("capability_denied:send");
      }
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
      else res.end();
    } finally {
      await mcp.close();
      inFlight--;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mcp_bind_failed");
  host = `127.0.0.1:${addr.port}`;
  const connection = { url: `http://${host}/mcp`, token };
  const file = path.join(options.stateDir, MCP_CONNECTION_FILE);
  try {
    await writeJsonSecure(file, connection);
  } catch {
    server.close();
    throw new Error("mcp_write_connection_failed");
  }

  return {
    async stop() {
      if (stopped.signal.aborted) return;
      stopped.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await unlink(file).catch(() => {});
    },
  };
}
