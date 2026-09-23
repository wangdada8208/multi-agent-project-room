import http from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { OwnerNote } from "./ownerNote.ts";

export function ownerNotesBindAddress(): string {
  return "127.0.0.1";
}

export interface HandleOwnerNotesInput {
  host?: string | null;
  notes: OwnerNote[];
}

export interface HandleOwnerNotesResponse {
  status: number;
  body: {
    notes: OwnerNote[];
  };
}

export async function handleOwnerNotes(input: HandleOwnerNotesInput): Promise<HandleOwnerNotesResponse> {
  const rawHost = input.host ?? "";
  const host = rawHost.split(":")[0].trim().toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost";
  if (!isLoopback) {
    return {
      status: 403,
      body: {
        notes: [],
      },
    };
  }

  const safeNotes: OwnerNote[] = (input.notes || []).map((n) => ({
    self_name: n.self_name,
    turns_seen: n.turns_seen,
    action: n.action,
    block_reason: n.block_reason ?? null,
  }));

  return {
    status: 200,
    body: {
      notes: safeNotes,
    },
  };
}

export async function readOwnerNotesFile(filePath: string): Promise<OwnerNote[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").map((s) => s.trim()).filter(Boolean);
    const notes: OwnerNote[] = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        notes.push(item);
      } catch {
        // ignore malformed lines
      }
    }
    return notes;
  } catch {
    return [];
  }
}

export function createOwnerNotesServer(
  notesPathOrGetter: string | (() => Promise<OwnerNote[]> | OwnerNote[])
): http.Server {
  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || "";
    const parsedUrl = new URL(req.url || "/", `http://${host || "127.0.0.1"}`);

    if (req.method === "GET" && parsedUrl.pathname === "/owner-notes") {
      let notes: OwnerNote[] = [];
      if (typeof notesPathOrGetter === "function") {
        notes = await notesPathOrGetter();
      } else {
        notes = await readOwnerNotesFile(notesPathOrGetter);
      }

      const result = await handleOwnerNotes({ host, notes });
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });
}
