import { createServer as createHttpServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/** Start a local web viewer for the memory database. */
export function startViewer(dbPath: string, port: number): Server {
  const db = new Database(dbPath);

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderPage());
      return;
    }

    if (url.pathname === "/api/captures") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const type = url.searchParams.get("type");
      const sessionKey = url.searchParams.get("session");

      let sql = "SELECT * FROM captures";
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (type) {
        conditions.push("type = ?");
        params.push(type);
      }
      if (sessionKey) {
        conditions.push("session_key = ?");
        params.push(sessionKey);
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(" AND ")}`;
      }
      sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rows));
      return;
    }

    if (url.pathname === "/api/stats") {
      const total = db.prepare("SELECT COUNT(*) as count FROM captures").get();
      const byType = db
        .prepare("SELECT type, COUNT(*) as count FROM captures GROUP BY type ORDER BY count DESC")
        .all();
      const sessions = db
        .prepare("SELECT COUNT(DISTINCT session_key) as count FROM captures")
        .get();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ total, byType, sessions }));
      return;
    }

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q");
      if (!q) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing query parameter 'q'" }));
        return;
      }
      const ftsQuery = q
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(" ");
      const rows = db
        .prepare(
          "SELECT c.*, bm25(captures_fts) as score FROM captures_fts JOIN captures c ON c.id = captures_fts.id WHERE captures_fts MATCH ? ORDER BY score LIMIT 50",
        )
        .all(ftsQuery);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rows));
      return;
    }

    // Delete a single capture by ID
    if (url.pathname === "/api/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const { id } = JSON.parse(body) as { id: string };
          if (!id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'id'" }));
            return;
          }
          // FTS5 trigger auto-removes from search index
          const info = db.prepare("DELETE FROM captures WHERE id = ?").run(id);
          if (info.changes === 0) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Capture not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ deleted: id }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // Delete all captures of a given type
    if (url.pathname === "/api/delete-by-type" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const { type } = JSON.parse(body) as { type: string };
          if (!type) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'type'" }));
            return;
          }
          const info = db.prepare("DELETE FROM captures WHERE type = ?").run(type);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ deleted: info.changes }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // Delete all captures (clear memory)
    if (url.pathname === "/api/clear-all" && req.method === "POST") {
      const info = db.prepare("DELETE FROM captures").run();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ deleted: info.changes }));
      return;
    }

    // CodeGraph: list symbols
    if (url.pathname === "/api/codegraph/symbols") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const search = url.searchParams.get("q");
      let sql = "SELECT * FROM symbols";
      const params: unknown[] = [];
      if (search) {
        sql += " WHERE name LIKE ?";
        params.push(`%${search}%`);
      }
      sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);
      try {
        const rows = db.prepare(sql).all(...params);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
      }
      return;
    }

    // CodeGraph: stats
    if (url.pathname === "/api/codegraph/stats") {
      try {
        const symbols = db.prepare("SELECT COUNT(*) as count FROM symbols").get();
        const calls = db.prepare("SELECT COUNT(*) as count FROM calls").get();
        const imports = db.prepare("SELECT COUNT(*) as count FROM imports").get();
        const byLang = db
          .prepare(
            "SELECT language, COUNT(*) as count FROM symbols GROUP BY language ORDER BY count DESC",
          )
          .all();
        const byKind = db
          .prepare("SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind ORDER BY count DESC")
          .all();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ symbols, calls, imports, byLang, byKind }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            symbols: { count: 0 },
            calls: { count: 0 },
            imports: { count: 0 },
            byLang: [],
            byKind: [],
          }),
        );
      }
      return;
    }

    // CodeGraph: callers of a symbol
    if (url.pathname === "/api/codegraph/callers") {
      const symbolId = url.searchParams.get("id");
      if (!symbolId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'id'" }));
        return;
      }
      try {
        const rows = db
          .prepare(
            "SELECT s.*, c.line FROM calls c JOIN symbols s ON s.id = c.caller_id WHERE c.callee_id = ? ORDER BY c.line",
          )
          .all(symbolId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
      }
      return;
    }

    // CodeGraph: callees of a symbol
    if (url.pathname === "/api/codegraph/callees") {
      const symbolId = url.searchParams.get("id");
      if (!symbolId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'id'" }));
        return;
      }
      try {
        const rows = db
          .prepare(
            "SELECT s.*, c.line, c.callee_name FROM calls c LEFT JOIN symbols s ON s.id = c.callee_id WHERE c.caller_id = ? ORDER BY c.line",
          )
          .all(symbolId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
      }
      return;
    }

    // Wiki: list pages
    if (url.pathname === "/api/wiki/pages") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const search = url.searchParams.get("q");
      let sql = "SELECT * FROM wiki_pages";
      const params: unknown[] = [];
      if (search) {
        sql += " WHERE title LIKE ? OR content LIKE ?";
        params.push(`%${search}%`, `%${search}%`);
      }
      sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);
      try {
        const rows = db.prepare(sql).all(...params);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
      }
      return;
    }

    // Wiki: stats
    if (url.pathname === "/api/wiki/stats") {
      try {
        const pages = db.prepare("SELECT COUNT(*) as count FROM wiki_pages").get();
        const links = db.prepare("SELECT COUNT(*) as count FROM wiki_links").get();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pages, links }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pages: { count: 0 }, links: { count: 0 } }));
      }
      return;
    }

    if (url.pathname === "/api/token-stats") {
      try {
        const logPath =
          process.env.TDAI_HOOK_LOG_PATH ??
          join(homedir(), ".local", "share", "tdai-memory-mcp", "session.log");

        const captures = db
          .prepare("SELECT content FROM captures ORDER BY created_at ASC")
          .all() as { content: string }[];
        const sessions = db
          .prepare("SELECT COUNT(DISTINCT session_key) as count FROM captures")
          .get() as { count: number };

        // Estimate stored tokens (rough: 1 token ~ 4 chars)
        const totalStored = captures.reduce(
          (sum, c) => sum + Math.ceil((c.content?.length ?? 0) / 4),
          0,
        );

        let recallCount = 0;
        let totalInjected = 0;
        let captureCount = 0;

        if (existsSync(logPath)) {
          const log = readFileSync(logPath, "utf-8");
          const lines = log.split("\n");
          let inBlock = false;
          let blockChars = 0;

          for (const line of lines) {
            if (line.includes("SessionStart: loaded")) {
              recallCount++;
              inBlock = true;
              blockChars = 0;
            } else if (line.includes("SessionStart: no recent memory")) {
              inBlock = false;
            } else if (line.includes("SessionEnd: captured")) {
              captureCount++;
              inBlock = false;
            } else if (inBlock && line.startsWith("[2026")) {
              totalInjected += Math.ceil(blockChars / 4);
              inBlock = false;
            } else if (inBlock) {
              blockChars += line.length + 1;
            }
          }
        }

        const avgInjection =
          recallCount > 0 ? Math.round(totalInjected / recallCount) : 0;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            stored: totalStored,
            recalls: recallCount,
            injected: totalInjected,
            avgInjection,
            autoCaptured: captureCount,
            sessions: sessions.count,
          }),
        );
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            stored: 0,
            recalls: 0,
            injected: 0,
            avgInjection: 0,
            autoCaptured: 0,
            sessions: 0,
          }),
        );
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`\n  tdai-memory viewer running at http://localhost:${port}\n`);
    console.log(`  Press Ctrl+C to stop.\n`);
  });

  server.on("close", () => {
    db.close();
  });

  return server;
}

/** Render the viewer HTML page. */
function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>tdai-memory Memory Viewer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root,
  [data-theme="dark"] {
    --bg: #0a0a0b;
    --surface: #111113;
    --surface-hover: #161618;
    --hairline: rgba(255,255,255,0.07);
    --hairline-strong: rgba(255,255,255,0.14);
    --text: rgba(255,255,255,0.92);
    --text-dim: rgba(255,255,255,0.5);
    --text-faint: rgba(255,255,255,0.28);
    --accent: #a78bfa;
    --accent-dim: rgba(167,139,250,0.12);
    --emerald: #34d399;
    --rose: #fb7185;
    --amber: #fbbf24;
    --sky: #38bdf8;
    --btn-text: #0a0a0b;
    --modal-scrim: rgba(0,0,0,0.6);
    --bezier: cubic-bezier(0.16, 1, 0.3, 1);
  }

  [data-theme="light"] {
    --bg: #f4f1ec;
    --surface: #ebe7e0;
    --surface-hover: #e0dbd3;
    --hairline: rgba(60,50,40,0.10);
    --hairline-strong: rgba(60,50,40,0.18);
    --text: rgba(40,35,30,0.88);
    --text-dim: rgba(60,50,40,0.55);
    --text-faint: rgba(60,50,40,0.32);
    --accent: #6d28d9;
    --accent-dim: rgba(109,40,217,0.08);
    --emerald: #047857;
    --rose: #be123c;
    --amber: #b45309;
    --sky: #0369a1;
    --btn-text: #f4f1ec;
    --modal-scrim: rgba(40,35,30,0.35);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100dvh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* ─── Sticky nav bar ─── */
  .nav {
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--surface);
    border-bottom: 1px solid var(--hairline);
    padding: 0.75rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .nav-brand {
    font-size: 0.875rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
    white-space: nowrap;
  }

  .nav-tabs {
    display: flex;
    gap: 0.125rem;
  }
  .nav-tab {
    padding: 0.375rem 0.875rem;
    background: transparent;
    color: var(--text-dim);
    border: none;
    border-radius: 8px;
    font-size: 0.8125rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s var(--bezier);
  }
  .nav-tab:hover { color: var(--text); background: var(--surface-hover); }
  .nav-tab.active { color: var(--accent); background: var(--accent-dim); }

  .nav-search {
    flex: 1;
    max-width: 320px;
    margin-left: auto;
    padding: 0.5rem 0.875rem;
    background: var(--bg);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
    outline: none;
    transition: all 0.2s var(--bezier);
  }
  .nav-search::placeholder { color: var(--text-faint); }
  .nav-search:focus { border-color: var(--accent); }

  .nav-btn {
    padding: 0.5rem 1rem;
    background: var(--text);
    color: var(--btn-text);
    border: none;
    border-radius: 8px;
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.2s var(--bezier);
  }
  .nav-btn:hover { opacity: 0.9; }
  .nav-btn:active { transform: scale(0.97); }

  .theme-toggle {
    width: 34px; height: 34px;
    background: transparent;
    border: 1px solid var(--hairline);
    border-radius: 8px;
    color: var(--text-dim);
    font-size: 1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s var(--bezier);
    flex-shrink: 0;
  }
  .theme-toggle:hover {
    border-color: var(--hairline-strong);
    color: var(--text);
  }
  .theme-toggle:active { transform: scale(0.95); }

  /* ─── Global stats bar ─── */
  .stats-bar {
    background: var(--surface);
    padding: 0.625rem 1.5rem;
    display: flex;
    gap: 1.5rem;
    align-items: center;
    overflow-x: auto;
    white-space: nowrap;
  }
  .stats-bar-group {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .stats-bar-divider {
    width: 1px;
    height: 18px;
    background: var(--hairline);
    flex-shrink: 0;
  }
  .stats-bar-label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }
  .stats-bar-item {
    display: flex;
    gap: 0.3rem;
    align-items: baseline;
    font-size: 0.8125rem;
  }
  .stats-bar-value {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    color: var(--text);
  }
  .stats-bar-key {
    color: var(--text-dim);
  }

  /* ─── Page header ─── */
  .hero {
    max-width: 1200px;
    margin: 0 auto;
    padding: 4rem 1.5rem 1.5rem;
  }

  .hero-eyebrow {
    display: inline-block;
    padding: 0.25rem 0.625rem;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    font-size: 0.625rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-dim);
    margin-bottom: 1.25rem;
    font-family: 'JetBrains Mono', monospace;
  }

  .hero h1 {
    font-size: clamp(2rem, 5vw, 3.25rem);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.05;
    margin-bottom: 0.75rem;
    color: var(--text);
  }

  .hero-sub {
    font-size: 1rem;
    color: var(--text-dim);
    max-width: 520px;
    line-height: 1.6;
    margin-bottom: 2rem;
  }

  /* ─── Stats grid ─── */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 0.75rem;
  }

  .stat-card {
    padding: 1rem 1.25rem;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 12px;
    transition: border-color 0.2s var(--bezier);
  }
  .stat-card:hover { border-color: var(--hairline-strong); }

  .stat-value {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1;
    margin-bottom: 0.375rem;
    font-family: 'JetBrains Mono', monospace;
  }

  .stat-label {
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-faint);
  }

  /* ─── Filter bar ─── */
  .filter-bar {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 1.5rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-wrap: wrap;
  }

  .filter-select {
    padding: 0.5rem 2rem 0.5rem 0.875rem;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
    outline: none;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='rgba(255,255,255,0.4)' stroke-width='1.5'%3E%3Cpath d='M3 4.5l3 3 3-3'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    transition: border-color 0.2s var(--bezier);
  }
  .filter-select:hover { border-color: var(--hairline-strong); }
  .filter-select option { background: var(--surface); color: var(--text); }

  .filter-search {
    flex: 1;
    min-width: 200px;
    padding: 0.5rem 0.875rem;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s var(--bezier);
  }
  .filter-search:focus { border-color: var(--accent); }
  .filter-search::placeholder { color: var(--text-faint); }

  .filter-btn {
    padding: 0.5rem 1.125rem;
    background: var(--text);
    color: var(--btn-text);
    border: none;
    border-radius: 8px;
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.2s var(--bezier);
  }
  .filter-btn:hover { opacity: 0.9; }
  .filter-btn:active { transform: scale(0.97); }

  .danger-btn {
    padding: 0.5rem 0.875rem;
    background: transparent;
    border: 1px solid rgba(251,113,133,0.2);
    border-radius: 8px;
    color: var(--rose);
    font-size: 0.75rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s var(--bezier);
  }
  .danger-btn:hover {
    background: rgba(251,113,133,0.08);
    border-color: rgba(251,113,133,0.35);
  }
  .danger-btn:active { transform: scale(0.97); }

  /* ─── Item grid (CodeGraph + Wiki) ─── */
  .item-grid {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 1.5rem 5rem;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 0.625rem;
  }

  .item-card {
    padding: 0.875rem 1rem;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 12px;
    cursor: pointer;
    transition: all 0.2s var(--bezier);
  }
  .item-card:hover {
    border-color: var(--hairline-strong);
    background: var(--surface-hover);
  }

  .item-card-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.375rem;
  }
  .item-kind {
    padding: 0.125rem 0.5rem;
    border-radius: 6px;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: var(--accent-dim);
    color: var(--accent);
    font-family: 'JetBrains Mono', monospace;
  }
  .item-lang {
    font-size: 0.625rem;
    color: var(--text-faint);
    font-family: 'JetBrains Mono', monospace;
    margin-left: auto;
  }
  .item-name {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 0.25rem;
    word-break: break-word;
  }
  .item-file {
    font-size: 0.6875rem;
    color: var(--text-faint);
    font-family: 'JetBrains Mono', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ─── Capture grid (bento) ─── */
  .capture-grid {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 1.5rem 5rem;
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 0.75rem;
  }

  /* Bento spans - varied sizes */
  .capture-card:nth-child(6n+1) { grid-column: span 8; }
  .capture-card:nth-child(6n+2) { grid-column: span 4; }
  .capture-card:nth-child(6n+3) { grid-column: span 4; }
  .capture-card:nth-child(6n+4) { grid-column: span 4; }
  .capture-card:nth-child(6n+5) { grid-column: span 4; }
  .capture-card:nth-child(6n+6) { grid-column: span 8; }

  @media (max-width: 900px) {
    .capture-card:nth-child(n) { grid-column: span 6; }
  }

  @media (max-width: 640px) {
    .capture-card:nth-child(n) { grid-column: span 12; }
  }

  .capture-card {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 12px;
    padding: 1.25rem;
    transition: border-color 0.2s var(--bezier);
    display: flex;
    flex-direction: column;
  }
  .capture-card:hover { border-color: var(--hairline-strong); }

  .capture-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .type-badge {
    padding: 0.2rem 0.5rem;
    border-radius: 6px;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-family: 'JetBrains Mono', monospace;
  }

  .type-decision { background: rgba(56,189,248,0.1); color: var(--sky); }
  .type-learning { background: rgba(52,211,153,0.1); color: var(--emerald); }
  .type-error { background: rgba(251,113,133,0.1); color: var(--rose); }
  .type-task { background: rgba(251,191,36,0.1); color: var(--amber); }
  .type-conversation { background: rgba(255,255,255,0.05); color: var(--text-dim); }
  .type-atom { background: var(--accent-dim); color: var(--accent); }

  .capture-date {
    font-size: 0.6875rem;
    color: var(--text-faint);
    font-family: 'JetBrains Mono', monospace;
    margin-left: auto;
  }

  .capture-agent {
    font-size: 0.6875rem;
    color: var(--text-faint);
    font-family: 'JetBrains Mono', monospace;
  }

  .capture-content {
    font-size: 0.875rem;
    line-height: 1.65;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    flex: 1;
    max-height: 280px;
    overflow: hidden;
    position: relative;
  }
  .capture-content.expanded { max-height: none; }

  .capture-content-fade {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 40px;
    background: linear-gradient(transparent, var(--surface));
    pointer-events: none;
    transition: opacity 0.2s var(--bezier);
  }
  .capture-content.expanded + .capture-content-fade { opacity: 0; }

  .capture-tags {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }

  .tag {
    padding: 0.125rem 0.5rem;
    background: var(--bg);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    font-size: 0.625rem;
    font-weight: 500;
    color: var(--text-dim);
    font-family: 'JetBrains Mono', monospace;
  }

  .capture-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.875rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--hairline);
  }

  .btn-expand {
    padding: 0.3rem 0.75rem;
    background: transparent;
    border: 1px solid var(--hairline);
    border-radius: 8px;
    color: var(--text-dim);
    font-size: 0.6875rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s var(--bezier);
  }
  .btn-expand:hover {
    border-color: var(--hairline-strong);
    color: var(--text);
  }

  .btn-delete-card {
    margin-left: auto;
    width: 30px; height: 30px;
    background: transparent;
    border: 1px solid rgba(251,113,133,0.15);
    border-radius: 8px;
    color: var(--rose);
    font-size: 0.875rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s var(--bezier);
  }
  .btn-delete-card:hover {
    background: rgba(251,113,133,0.08);
    border-color: rgba(251,113,133,0.3);
  }
  .btn-delete-card:active { transform: scale(0.95); }

  /* ─── Empty state ─── */
  .empty-state {
    max-width: 1200px;
    margin: 0 auto;
    padding: 5rem 1.5rem;
    text-align: center;
  }

  .empty-state h3 {
    font-size: 1.125rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 0.375rem;
    color: var(--text);
  }

  .empty-state p {
    font-size: 0.875rem;
    color: var(--text-dim);
    max-width: 360px;
    margin: 0 auto;
    line-height: 1.6;
  }

  /* ─── Modal ─── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: var(--modal-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s var(--bezier);
  }
  .modal-overlay.active {
    opacity: 1;
    pointer-events: auto;
  }

  .modal {
    width: 100%;
    max-width: 480px;
    background: var(--surface);
    border: 1px solid var(--hairline-strong);
    border-radius: 12px;
    padding: 1.5rem;
    transform: scale(0.97);
    transition: transform 0.2s var(--bezier);
  }
  .modal-overlay.active .modal { transform: scale(1); }

  .modal h3 {
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 0.5rem;
  }

  .modal p {
    font-size: 0.875rem;
    color: var(--text-dim);
    line-height: 1.6;
    margin-bottom: 1.25rem;
  }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
  }

  .modal-btn {
    flex: 1;
    padding: 0.5rem 1rem;
    border: 1px solid var(--hairline);
    border-radius: 8px;
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s var(--bezier);
  }
  .modal-btn:active { transform: scale(0.97); }

  .modal-btn-cancel {
    background: transparent;
    color: var(--text-dim);
  }
  .modal-btn-cancel:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .modal-btn-confirm {
    background: var(--rose);
    border-color: var(--rose);
    color: #fff;
  }
  .modal-btn-confirm:hover { opacity: 0.9; }

  /* ─── Toast ─── */
  .toast {
    position: fixed;
    bottom: 1.5rem;
    left: 50%;
    transform: translateX(-50%) translateY(0.5rem);
    z-index: 300;
    padding: 0.625rem 1.125rem;
    background: var(--surface);
    border: 1px solid var(--hairline-strong);
    border-radius: 8px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text);
    opacity: 0;
    pointer-events: none;
    transition: all 0.2s var(--bezier);
  }
  .toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  /* ─── Symbol details modal content ─── */
  .symbol-detail {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    line-height: 1.7;
  }
  .symbol-detail h4 {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 0.5rem;
  }
  .symbol-detail h4:first-child { color: var(--accent); }
  .symbol-detail h4:nth-child(3) { color: var(--sky); margin-top: 1rem; }
  .symbol-detail .row { color: var(--text-dim); }
  .symbol-detail .row b { color: var(--text); font-weight: 600; }
  .symbol-detail .none { color: var(--text-faint); }

  /* ─── Reduced motion ─── */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
    }
  }

  /* ─── Mobile ─── */
  @media (max-width: 768px) {
    .nav {
      flex-wrap: wrap;
      padding: 0.625rem 1rem;
    }
    .nav-search { max-width: none; width: 100%; order: 3; }
    .hero { padding: 2.5rem 1rem 1rem; }
    .hero h1 { font-size: 1.875rem; }
    .filter-bar { padding: 0 1rem 1.25rem; }
    .capture-grid { padding: 0 1rem 3rem; gap: 0.625rem; }
    .item-grid { padding: 0 1rem 3rem; }
    .stat-value { font-size: 1.375rem; }
  }
</style>
</head>
<body>

<!-- ─── Nav ─── -->
<nav class="nav">
  <div class="nav-brand">tdai-memory</div>
  <div class="nav-tabs">
    <button class="nav-tab active" data-tab="memory" onclick="switchTab('memory')">Memory</button>
    <button class="nav-tab" data-tab="codegraph" onclick="switchTab('codegraph')">CodeGraph</button>
    <button class="nav-tab" data-tab="wiki" onclick="switchTab('wiki')">Wiki</button>
  </div>
  <input class="nav-search" id="search" placeholder="Search captures..." autocomplete="off" />
  <button class="nav-btn" onclick="doSearch()">Search</button>
  <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle theme">&#9680;</button>
</nav>

<!-- ─── Global stats bar ─── -->
<div class="stats-bar" id="statsBar"></div>

<!-- ─── Memory tab ─── -->
<div id="tab-memory" class="tab-content">
<section class="hero">
  <div class="hero-eyebrow">Memory Database</div>
  <h1>Long-term memory<br>for coding agents.</h1>
  <p class="hero-sub">Decisions, learnings, and errors captured across sessions. Searchable, persistent, contextual.</p>
  <div class="stats-grid" id="statsGrid"></div>
</section>

<div class="filter-bar">
  <select class="filter-select" id="typeFilter" onchange="loadCaptures()">
    <option value="">All types</option>
    <option value="decision">Decision</option>
    <option value="learning">Learning</option>
    <option value="error">Error</option>
    <option value="task">Task</option>
    <option value="conversation">Conversation</option>
    <option value="atom">Atom</option>
  </select>
  <button class="danger-btn" onclick="deleteByType()">Delete type</button>
  <button class="danger-btn" onclick="clearAll()">Clear all</button>
</div>

<div class="capture-grid" id="list"></div>
</div>

<!-- ─── CodeGraph tab ─── -->
<div id="tab-codegraph" class="tab-content" style="display:none">
<section class="hero">
  <h1>CodeGraph<br>Tree-sitter powered.</h1>
  <p class="hero-sub">Symbols and call relationships from 9 languages. Click any symbol for callers and callees.</p>
  <div class="stats-grid" id="cgStatsGrid"></div>
</section>
<div class="filter-bar">
  <input class="filter-search" id="cgSearch" placeholder="Search symbols by name..." autocomplete="off" onkeydown="if(event.key==='Enter')loadSymbols()" />
  <button class="filter-btn" onclick="loadSymbols()">Search</button>
</div>
<div class="item-grid" id="cgList"></div>
</div>

<!-- ─── Wiki tab ─── -->
<div id="tab-wiki" class="tab-content" style="display:none">
<section class="hero">
  <h1>Wiki<br>Markdown knowledge graph.</h1>
  <p class="hero-sub">Pages, headings, and links from your docs. Searchable and cross-referenced.</p>
  <div class="stats-grid" id="wikiStatsGrid"></div>
</section>
<div class="filter-bar">
  <input class="filter-search" id="wikiSearch" placeholder="Search wiki pages..." autocomplete="off" onkeydown="if(event.key==='Enter')loadWiki()" />
  <button class="filter-btn" onclick="loadWiki()">Search</button>
</div>
<div class="item-grid" id="wikiList"></div>
</div>

<!-- ─── Modal ─── -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <h3 id="modalTitle">Confirm</h3>
    <div id="modalBody"><p>Are you sure?</p></div>
    <div class="modal-actions">
      <button class="modal-btn modal-btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="modal-btn modal-btn-confirm" id="modalConfirm">Delete</button>
    </div>
  </div>
</div>

<!-- ─── Toast ─── -->
<div class="toast" id="toast"></div>

<script>
  // ─── State ───
  let modalCallback = null;

  // ─── Toast ───
  function showToast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); }, 3000);
  }

  // ─── Modal ───
  function showModal(title, body, onConfirm) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = '<p>' + body + '</p>';
    document.getElementById('modalConfirm').style.display = '';
    modalCallback = onConfirm;
    document.getElementById('modalOverlay').classList.add('active');
  }

  function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
    modalCallback = null;
  }

  document.getElementById('modalConfirm').addEventListener('click', function() {
    if (modalCallback) modalCallback();
    closeModal();
  });

  document.getElementById('modalOverlay').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeModal();
  });

  // ─── Stats ───
  async function loadStats() {
    var r = await fetch('/api/stats');
    var d = await r.json();
    var grid = document.getElementById('statsGrid');
    var typeColors = {
      decision: 'var(--sky)',
      learning: 'var(--emerald)',
      error: 'var(--rose)',
      task: 'var(--amber)',
      conversation: 'var(--text-dim)',
      atom: 'var(--accent)'
    };
    var cards = [
      { value: d.total.count, label: 'Total Captures' },
      { value: d.sessions.count, label: 'Sessions' },
      { value: d.byType.length, label: 'Types' }
    ];
    d.byType.forEach(function(t) {
      cards.push({ value: t.count, label: t.type, color: typeColors[t.type] || 'var(--text)' });
    });
    grid.innerHTML = cards.map(function(c) {
      return '<div class="stat-card">'
        + '<div class="stat-value" style="' + (c.color ? 'color:' + c.color : '') + '">' + c.value + '</div>'
        + '<div class="stat-label">' + c.label + '</div>'
        + '</div>';
    }).join('');
  }

  // ─── Global stats bar ───
  function fmtTok(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
  async function loadStatsBar() {
    try {
      var [memR, cgR, wikiR, tokR] = await Promise.all([
        fetch('/api/stats').then(function(r) { return r.json(); }),
        fetch('/api/codegraph/stats').then(function(r) { return r.json(); }),
        fetch('/api/wiki/stats').then(function(r) { return r.json(); }),
        fetch('/api/token-stats').then(function(r) { return r.json(); })
      ]);
      var bar = document.getElementById('statsBar');
      var html = ''
        + '<div class="stats-bar-group">'
        +   '<span class="stats-bar-label">Memory</span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + memR.total.count + '</span><span class="stats-bar-key">captures</span></span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + memR.sessions.count + '</span><span class="stats-bar-key">sessions</span></span>'
        + '</div>'
        + '<div class="stats-bar-divider"></div>'
        + '<div class="stats-bar-group">'
        +   '<span class="stats-bar-label">CodeGraph</span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + cgR.symbols.count + '</span><span class="stats-bar-key">symbols</span></span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + cgR.calls.count + '</span><span class="stats-bar-key">calls</span></span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + cgR.imports.count + '</span><span class="stats-bar-key">imports</span></span>'
        + '</div>'
        + '<div class="stats-bar-divider"></div>'
        + '<div class="stats-bar-group">'
        +   '<span class="stats-bar-label">Wiki</span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + wikiR.pages.count + '</span><span class="stats-bar-key">pages</span></span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + wikiR.links.count + '</span><span class="stats-bar-key">links</span></span>'
        + '</div>'
        + '<div class="stats-bar-divider"></div>'
        + '<div class="stats-bar-group">'
        +   '<span class="stats-bar-label">Tokens</span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + fmtTok(tokR.stored) + '</span><span class="stats-bar-key">stored</span></span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + fmtTok(tokR.injected) + '</span><span class="stats-bar-key">injected</span></span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + tokR.recalls + '</span><span class="stats-bar-key">recalls</span></span>'
        +   '<span class="stats-bar-item"><span class="stats-bar-value">' + tokR.autoCaptured + '</span><span class="stats-bar-key">auto-captured</span></span>'
        + '</div>';
      bar.innerHTML = html;
    } catch(e) {
      document.getElementById('statsBar').innerHTML = '';
    }
  }

  // ─── Tab switching ───
  function switchTab(tab) {
    document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelector('[data-tab="' + tab + '"]').classList.add('active');
    document.querySelectorAll('.tab-content').forEach(function(c) { c.style.display = 'none'; });
    var el = document.getElementById('tab-' + tab);
    if (el) el.style.display = '';
    if (tab === 'codegraph') { loadCgStats(); loadSymbols(); }
    if (tab === 'wiki') { loadWikiStats(); loadWiki(); }
  }

  // ─── CodeGraph ───
  async function loadCgStats() {
    try {
      var r = await fetch('/api/codegraph/stats');
      var d = await r.json();
      var grid = document.getElementById('cgStatsGrid');
      var cards = [
        { value: d.symbols.count, label: 'Symbols', color: 'var(--accent)' },
        { value: d.calls.count, label: 'Calls', color: 'var(--sky)' },
        { value: d.imports.count, label: 'Imports', color: 'var(--emerald)' }
      ];
      (d.byLang || []).forEach(function(l) {
        cards.push({ value: l.count, label: l.language, color: 'var(--text-dim)' });
      });
      grid.innerHTML = cards.map(function(c) {
        return '<div class="stat-card">'
          + '<div class="stat-value" style="' + (c.color ? 'color:' + c.color : '') + '">' + c.value + '</div>'
          + '<div class="stat-label">' + c.label + '</div>'
          + '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('cgStatsGrid').innerHTML = '<p style="color:var(--text-dim);padding:1.5rem 0">No CodeGraph data. Run: tdai-memory-mcp index --path src --repo .</p>';
    }
  }

  async function loadSymbols() {
    var q = document.getElementById('cgSearch').value;
    var url = '/api/codegraph/symbols?limit=100' + (q ? '&q=' + encodeURIComponent(q) : '');
    var r = await fetch(url);
    var rows = await r.json();
    var list = document.getElementById('cgList');
    if (!rows || rows.length === 0) {
      list.innerHTML = '<p style="color:var(--text-dim);padding:2rem 0;text-align:center;grid-column:1/-1">No symbols found.</p>';
      return;
    }
    list.innerHTML = rows.map(function(s) {
      return '<div class="item-card" onclick="showSymbolDetails(\\''+s.id+'\\')">'
        + '<div class="item-card-head">'
        + '<span class="item-kind">' + s.kind + '</span>'
        + '<span class="item-lang">' + s.language + '</span>'
        + '</div>'
        + '<div class="item-name">' + escapeHtml(s.name) + '</div>'
        + '<div class="item-file">' + escapeHtml(s.file_path) + ':' + s.line_start + '</div>'
        + '</div>';
    }).join('');
  }

  async function showSymbolDetails(id) {
    var r1 = await fetch('/api/codegraph/callers?id=' + id);
    var callers = await r1.json();
    var r2 = await fetch('/api/codegraph/callees?id=' + id);
    var callees = await r2.json();
    var html = '<div class="symbol-detail">'
      + '<h4>Callers (' + callers.length + ')</h4>'
      + (callers.length ? callers.map(function(c) {
          return '<div class="row">' + c.kind + ' <b>' + escapeHtml(c.name) + '</b> ' + escapeHtml(c.file_path) + ':' + c.line + '</div>';
        }).join('') : '<div class="none">None</div>')
      + '<h4>Callees (' + callees.length + ')</h4>'
      + (callees.length ? callees.map(function(c) {
          return c.name
            ? '<div class="row">' + c.kind + ' <b>' + escapeHtml(c.name) + '</b> ' + escapeHtml(c.file_path) + ':' + c.line + '</div>'
            : '<div class="row"><b>' + escapeHtml(c.callee_name) + '</b> <span class="none">unresolved</span></div>';
        }).join('') : '<div class="none">None</div>')
      + '</div>';
    document.getElementById('modalTitle').textContent = 'Symbol Details';
    document.getElementById('modalBody').innerHTML = html;
    document.getElementById('modalConfirm').style.display = 'none';
    document.getElementById('modalOverlay').classList.add('active');
  }

  // ─── Wiki ───
  async function loadWikiStats() {
    try {
      var r = await fetch('/api/wiki/stats');
      var d = await r.json();
      var grid = document.getElementById('wikiStatsGrid');
      var cards = [
        { value: d.pages.count, label: 'Pages', color: 'var(--accent)' },
        { value: d.links.count, label: 'Links', color: 'var(--sky)' }
      ];
      grid.innerHTML = cards.map(function(c) {
        return '<div class="stat-card">'
          + '<div class="stat-value" style="color:' + c.color + '">' + c.value + '</div>'
          + '<div class="stat-label">' + c.label + '</div>'
          + '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('wikiStatsGrid').innerHTML = '<p style="color:var(--text-dim);padding:1.5rem 0">No Wiki data. Run: tdai-memory-mcp wiki ingest --path docs --repo .</p>';
    }
  }

  async function loadWiki() {
    var q = document.getElementById('wikiSearch').value;
    var url = '/api/wiki/pages?limit=100' + (q ? '&q=' + encodeURIComponent(q) : '');
    var r = await fetch(url);
    var rows = await r.json();
    var list = document.getElementById('wikiList');
    if (!rows || rows.length === 0) {
      list.innerHTML = '<p style="color:var(--text-dim);padding:2rem 0;text-align:center;grid-column:1/-1">No wiki pages found.</p>';
      return;
    }
    list.innerHTML = rows.map(function(p) {
      return '<div class="item-card">'
        + '<div class="item-card-head">'
        + '<span class="item-kind">page</span>'
        + '</div>'
        + '<div class="item-name">' + escapeHtml(p.title) + '</div>'
        + '<div class="item-file">' + escapeHtml(p.source_file) + '</div>'
        + '</div>';
    }).join('');
  }

  // ─── Captures ───
  async function loadCaptures() {
    var type = document.getElementById('typeFilter').value;
    var params = new URLSearchParams({ limit: 100 });
    if (type) params.set('type', type);
    var r = await fetch('/api/captures?' + params);
    var rows = await r.json();
    renderList(rows);
  }

  async function doSearch() {
    var q = document.getElementById('search').value.trim();
    if (!q) { loadCaptures(); return; }
    var r = await fetch('/api/search?q=' + encodeURIComponent(q));
    var rows = await r.json();
    renderList(rows);
  }

  function renderList(rows) {
    var el = document.getElementById('list');
    if (rows.length === 0) {
      el.className = '';
      el.innerHTML = '<div class="empty-state">'
        + '<h3>No captures found</h3>'
        + '<p>Try adjusting your filters or search query. Captures will appear here as your agent learns.</p>'
        + '</div>';
      return;
    }
    el.className = 'capture-grid';
    el.innerHTML = rows.map(function(r) {
      var tags = r.tags ? JSON.parse(r.tags) : [];
      var date = new Date(r.created_at).toISOString().split('T')[0];
      var needsExpand = r.content.length > 500;
      return '<div class="capture-card" data-id="' + r.id + '">'
        + '<div class="capture-meta">'
        + '<span class="type-badge type-' + r.type + '">' + r.type + '</span>'
        + '<span class="capture-agent">' + escapeHtml(r.agent_id || '') + '</span>'
        + '<span class="capture-date">' + date + '</span>'
        + '</div>'
        + '<div class="capture-content" id="content-' + r.id + '">' + escapeHtml(r.content) + '</div>'
        + (needsExpand ? '<div class="capture-content-fade" id="fade-' + r.id + '"></div>' : '')
        + (tags.length > 0 ? '<div class="capture-tags">' + tags.map(function(t) {
          return '<span class="tag">' + escapeHtml(t) + '</span>';
        }).join('') + '</div>' : '')
        + '<div class="capture-actions">'
        + (needsExpand ? '<button class="btn-expand" onclick="toggleExpand(\\'' + r.id + '\\')">Show more</button>' : '<span></span>')
        + '<button class="btn-delete-card" onclick="deleteCapture(\\'' + r.id + '\\')" title="Delete">x</button>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  function toggleExpand(id) {
    var content = document.getElementById('content-' + id);
    var fade = document.getElementById('fade-' + id);
    var btn = content.parentElement.querySelector('.btn-expand');
    if (content.classList.contains('expanded')) {
      content.classList.remove('expanded');
      if (fade) fade.style.opacity = '1';
      if (btn) btn.textContent = 'Show more';
    } else {
      content.classList.add('expanded');
      if (fade) fade.style.opacity = '0';
      if (btn) btn.textContent = 'Show less';
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ─── Delete actions ───
  async function deleteCapture(id) {
    showModal('Delete capture?', 'This capture will be permanently removed from memory.', async function() {
      var r = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id }),
      });
      if (r.ok) {
        showToast('Capture deleted');
        loadStats();
        loadCaptures();
      } else {
        var err = await r.json();
        showToast('Delete failed: ' + (err.error || 'unknown error'));
      }
    });
  }

  async function deleteByType() {
    var type = document.getElementById('typeFilter').value;
    if (!type) {
      showToast('Select a type first');
      return;
    }
    showModal(
      'Delete all ' + type + ' captures?',
      'All captures of type ' + type + ' will be permanently deleted.',
      async function() {
        var r = await fetch('/api/delete-by-type', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: type }),
        });
        if (r.ok) {
          var d = await r.json();
          showToast('Deleted ' + d.deleted + ' capture(s)');
          loadStats();
          loadCaptures();
        } else {
          var err = await r.json();
          showToast('Delete failed: ' + (err.error || 'unknown error'));
        }
      }
    );
  }

  async function clearAll() {
    showModal(
      'Clear all memory?',
      'All captures will be permanently deleted. This action cannot be undone.',
      async function() {
        var r = await fetch('/api/clear-all', { method: 'POST' });
        if (r.ok) {
          var d = await r.json();
          showToast('Deleted ' + d.deleted + ' capture(s)');
          loadStats();
          loadCaptures();
        } else {
          var err = await r.json();
          showToast('Clear failed: ' + (err.error || 'unknown error'));
        }
      }
    );
  }

  // ─── Theme ───
  function getStoredTheme() {
    try { return localStorage.getItem('tdai-theme'); } catch(e) { return null; }
  }
  function setStoredTheme(t) {
    try { localStorage.setItem('tdai-theme', t); } catch(e) {}
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var btn = document.getElementById('themeToggle');
    if (btn) btn.innerHTML = t === 'dark' ? '&#9728;' : '&#9680;';
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }
  (function() {
    var stored = getStoredTheme();
    if (stored) {
      applyTheme(stored);
    } else {
      var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      applyTheme(prefersLight ? 'light' : 'dark');
    }
  })();

  // ─── Init ───
  document.getElementById('search').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doSearch();
  });

  loadStatsBar();
  loadStats();
  loadCaptures();
  loadCgStats();
  loadSymbols();
  loadWikiStats();
  loadWiki();
</script>
</body>
</html>`;
}
