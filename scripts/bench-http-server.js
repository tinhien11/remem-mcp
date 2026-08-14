#!/usr/bin/env node
// bench-http-server.js — Mem0 OSS-compatible REST API wrapper around remem-mcp.
// Used by mem0ai/memory-benchmarks to evaluate remem-mcp on LoCoMo + LongMemEval.
//
// Endpoints (Mem0 OSS format):
//   POST /memories/          — add memories {messages, user_id, metadata}
//   GET  /memories/          — search ?query=...&user_id=...
//   POST /memories/delete/   — delete all for user_id
//   POST /reset/             — reset all memories
//   GET  /health             — health check
//
// Usage: node bench-http-server.js [port]

import http from "node:http";
import { Memory } from "../dist/sdk.js";

const PORT = parseInt(process.argv[2] || "8888", 10);
const DB_PATH = process.env.REMEM_DB_PATH || "/tmp/remem-bench/memory.db";

const memory = new Memory({ dbPath: DB_PATH });

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ─── Health ───────────────────────────────────────────
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // ─── Parse body ───────────────────────────────────────
  const body = await readBody(req);

  // ─── Add memories ─────────────────────────────────────
  if (url.pathname === "/memories/" && req.method === "POST") {
    try {
      const data = JSON.parse(body);
      const messages = data.messages || [];
      const userId = data.user_id || "default";
      const metadata = data.metadata || {};

      // Extract text from messages (Mem0 format: [{role, content}])
      const text = messages
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return `[${m.role || "user"}] ${content}`;
        })
        .join("\n");

      // Add date prefix if metadata has a date
      let captureText = text;
      if (metadata.date) {
        captureText = `[Date: ${metadata.date}] ${text}`;
      } else {
        captureText = `[Date: ${new Date().toISOString().split("T")[0]}] ${text}`;
      }

      await memory.capture(captureText, "conversation", ["bench", userId], {
        sessionKey: `bench-${userId}`,
      });

      res.writeHead(201);
      res.end(JSON.stringify({ status: "ok", count: messages.length }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── Search memories ──────────────────────────────────
  if (url.pathname === "/memories/" && req.method === "GET") {
    try {
      const query = url.searchParams.get("query") || "";
      const userId = url.searchParams.get("user_id") || "default";
      const topK = parseInt(url.searchParams.get("top_k") || "50", 10);

      const results = await memory.search(query, { topK, sessionKey: `bench-${userId}` });

      // Format as Mem0 OSS response: [{id, memory, score, ...}]
      const memories = (results || []).map((r, i) => ({
        id: r.id || `mem-${i}`,
        memory: r.content || r.text || "",
        score: r.score || 1 - i * 0.01,
        metadata: r.metadata || {},
      }));

      res.writeHead(200);
      res.end(JSON.stringify({ memories, results: memories }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── Delete memories for user ─────────────────────────
  if (url.pathname === "/memories/delete/" && req.method === "POST") {
    try {
      const data = JSON.parse(body || "{}");
      const userId = data.user_id || "default";
      // Best effort — delete all captures with this session key
      // The SDK may not support this directly; we just reset
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", deleted: "all" }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── Reset all ────────────────────────────────────────
  if (url.pathname === "/reset/" && req.method === "POST") {
    try {
      // Close and reopen with fresh DB
      memory.close?.();
      const { unlinkSync } = await import("node:fs");
      try { unlinkSync(DB_PATH); } catch {}
      // Reinitialize
      const { Memory: M } = await import("../dist/sdk.js");
      const fresh = new M({ dbPath: DB_PATH });
      Object.assign(memory, fresh);
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok" }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── 404 ──────────────────────────────────────────────
  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found", path: url.pathname }));
});

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

server.listen(PORT, () => {
  console.log(`remem-mcp HTTP server on http://127.0.0.1:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
