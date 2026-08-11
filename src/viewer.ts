import { createServer as createHttpServer, type Server } from "node:http";
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
<title>tdai-memory — Memory Viewer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #050505;
    --glass: rgba(255,255,255,0.03);
    --glass-strong: rgba(255,255,255,0.06);
    --hairline: rgba(255,255,255,0.08);
    --hairline-strong: rgba(255,255,255,0.12);
    --text: rgba(255,255,255,0.92);
    --text-dim: rgba(255,255,255,0.5);
    --text-faint: rgba(255,255,255,0.3);
    --accent: #a78bfa;
    --accent-glow: rgba(167,139,250,0.15);
    --emerald: #34d399;
    --emerald-glow: rgba(52,211,153,0.12);
    --rose: #fb7185;
    --amber: #fbbf24;
    --sky: #38bdf8;
    --bezier: cubic-bezier(0.32, 0.72, 0, 1);
    --bezier-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html { scroll-behavior: smooth; }

  body {
    font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100dvh;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* ─── Radial mesh gradient background ─── */
  .bg-mesh {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background:
      radial-gradient(ellipse 60% 50% at 15% 10%, var(--accent-glow), transparent 60%),
      radial-gradient(ellipse 50% 40% at 85% 20%, var(--emerald-glow), transparent 55%),
      radial-gradient(ellipse 70% 60% at 50% 90%, rgba(56,189,248,0.08), transparent 60%);
  }

  /* ─── Film grain overlay ─── */
  .bg-grain {
    position: fixed;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    opacity: 0.025;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' /%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' /%3E%3C/svg%3E");
  }

  /* ─── Floating glass nav pill ─── */
  .nav {
    position: sticky;
    top: 1.5rem;
    z-index: 100;
    width: max-content;
    max-width: calc(100vw - 2rem);
    margin: 1.5rem auto 0;
    padding: 0.625rem 0.625rem 0.625rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    background: rgba(10,10,10,0.6);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid var(--hairline);
    border-radius: 9999px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4), inset 0 1px 1px rgba(255,255,255,0.06);
  }

  .nav-brand {
    font-size: 0.875rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .nav-brand-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 12px var(--accent);
    animation: pulse 3s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.6; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.15); }
  }

  .nav-search {
    flex: 1;
    min-width: 200px;
    padding: 0.5rem 1rem;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--hairline);
    border-radius: 9999px;
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
    outline: none;
    transition: all 0.4s var(--bezier);
  }

  .nav-search::placeholder { color: var(--text-faint); }
  .nav-search:focus {
    border-color: var(--hairline-strong);
    background: rgba(255,255,255,0.06);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  .nav-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.5rem 0.5rem 1.125rem;
    background: var(--text);
    color: #050505;
    border: none;
    border-radius: 9999px;
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.4s var(--bezier);
  }

  .nav-btn:hover { transform: scale(1.02); }
  .nav-btn:active { transform: scale(0.98); }

  .nav-tabs {
    display: flex;
    gap: 0.25rem;
  }
  .nav-tab {
    padding: 0.375rem 0.875rem;
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--hairline);
    border-radius: 9999px;
    font-size: 0.8125rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.3s var(--bezier);
  }
  .nav-tab:hover { color: var(--text); border-color: var(--hairline-strong); }
  .nav-tab.active { color: var(--accent); border-color: var(--accent); background: var(--accent-glow); }

  .nav-btn-icon {
    width: 28px; height: 28px;
    border-radius: 50%;
    background: rgba(0,0,0,0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    transition: all 0.4s var(--bezier);
  }

  .nav-btn:hover .nav-btn-icon {
    transform: translate(1px, -1px) scale(1.05);
  }

  /* ─── Hero stats section ─── */
  .hero {
    position: relative;
    z-index: 2;
    max-width: 1200px;
    margin: 0 auto;
    padding: 5rem 1.5rem 2rem;
  }

  .hero-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.875rem;
    background: var(--glass);
    border: 1px solid var(--hairline);
    border-radius: 9999px;
    font-size: 0.625rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--text-dim);
    margin-bottom: 1.5rem;
  }

  .hero-eyebrow-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--emerald);
    box-shadow: 0 0 8px var(--emerald);
  }

  .hero h1 {
    font-size: clamp(2.5rem, 6vw, 4.5rem);
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 0.95;
    margin-bottom: 1rem;
    background: linear-gradient(180deg, var(--text) 60%, var(--text-dim));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .hero-sub {
    font-size: 1.0625rem;
    color: var(--text-dim);
    max-width: 480px;
    line-height: 1.6;
    margin-bottom: 2.5rem;
  }

  /* ─── Stats bento (double-bezel) ─── */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1rem;
    margin-bottom: 3rem;
  }

  .stat-card {
    padding: 0.5rem;
    background: var(--glass);
    border: 1px solid var(--hairline);
    border-radius: 1.5rem;
    transition: all 0.5s var(--bezier);
  }

  .stat-card:hover {
    border-color: var(--hairline-strong);
    background: var(--glass-strong);
  }

  .stat-card-inner {
    padding: 1.25rem 1.5rem;
    background: rgba(255,255,255,0.02);
    border-radius: calc(1.5rem - 0.5rem);
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.04);
  }

  .stat-value {
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1;
    margin-bottom: 0.375rem;
  }

  .stat-label {
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: var(--text-faint);
  }

  /* ─── Filter bar ─── */
  .filter-bar {
    position: relative;
    z-index: 2;
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 1.5rem 2rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .filter-select {
    padding: 0.5rem 2rem 0.5rem 1rem;
    background: var(--glass);
    border: 1px solid var(--hairline);
    border-radius: 9999px;
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
    outline: none;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='rgba(255,255,255,0.4)' stroke-width='1.5'%3E%3Cpath d='M3 4.5l3 3 3-3'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    transition: all 0.4s var(--bezier);
  }

  .filter-select:hover { border-color: var(--hairline-strong); }

  .filter-select option {
    background: #0a0a0a;
    color: var(--text);
  }

  .danger-btn {
    padding: 0.5rem 1rem;
    background: rgba(251,113,133,0.08);
    border: 1px solid rgba(251,113,133,0.2);
    border-radius: 9999px;
    color: var(--rose);
    font-size: 0.75rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.4s var(--bezier);
  }

  .danger-btn:hover {
    background: rgba(251,113,133,0.14);
    border-color: rgba(251,113,133,0.35);
  }

  .danger-btn:active { transform: scale(0.97); }

  /* ─── Capture grid (asymmetrical bento) ─── */
  .capture-grid {
    position: relative;
    z-index: 2;
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 1.5rem 6rem;
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 1rem;
  }

  /* Bento spans — varied sizes */
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

  /* ─── Double-bezel capture card ─── */
  .capture-card {
    padding: 0.5rem;
    background: var(--glass);
    border: 1px solid var(--hairline);
    border-radius: 1.75rem;
    transition: all 0.6s var(--bezier);
    opacity: 0;
    transform: translateY(2rem) scale(0.98);
  }

  .capture-card.revealed {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .capture-card:hover {
    border-color: var(--hairline-strong);
    background: var(--glass-strong);
    transform: translateY(-2px);
  }

  .capture-card-inner {
    padding: 1.25rem 1.5rem 1.5rem;
    background: rgba(255,255,255,0.015);
    border-radius: calc(1.75rem - 0.5rem);
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.04);
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .capture-meta {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-bottom: 0.875rem;
  }

  .type-badge {
    padding: 0.25rem 0.625rem;
    border-radius: 9999px;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    border: 1px solid transparent;
  }

  .type-decision { background: rgba(56,189,248,0.1); color: var(--sky); border-color: rgba(56,189,248,0.2); }
  .type-learning { background: rgba(52,211,153,0.1); color: var(--emerald); border-color: rgba(52,211,153,0.2); }
  .type-error { background: rgba(251,113,133,0.1); color: var(--rose); border-color: rgba(251,113,133,0.2); }
  .type-task { background: rgba(251,191,36,0.1); color: var(--amber); border-color: rgba(251,191,36,0.2); }
  .type-conversation { background: rgba(255,255,255,0.06); color: var(--text-dim); border-color: var(--hairline); }
  .type-atom { background: rgba(167,139,250,0.1); color: var(--accent); border-color: rgba(167,139,250,0.2); }

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

  .capture-content.expanded {
    max-height: none;
  }

  .capture-content-fade {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 48px;
    background: linear-gradient(transparent, rgba(10,10,10,0.6));
    pointer-events: none;
    transition: opacity 0.4s var(--bezier);
  }

  .capture-content.expanded + .capture-content-fade { opacity: 0; }

  .capture-tags {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    margin-top: 0.875rem;
  }

  .tag {
    padding: 0.1875rem 0.5rem;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--hairline);
    border-radius: 9999px;
    font-size: 0.625rem;
    font-weight: 500;
    color: var(--text-dim);
    font-family: 'JetBrains Mono', monospace;
  }

  .capture-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--hairline);
  }

  .btn-expand {
    padding: 0.375rem 0.875rem;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--hairline);
    border-radius: 9999px;
    color: var(--text-dim);
    font-size: 0.6875rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.4s var(--bezier);
  }

  .btn-expand:hover {
    background: rgba(255,255,255,0.08);
    color: var(--text);
  }

  .btn-delete-card {
    margin-left: auto;
    width: 32px; height: 32px;
    background: rgba(251,113,133,0.06);
    border: 1px solid rgba(251,113,133,0.15);
    border-radius: 50%;
    color: var(--rose);
    font-size: 0.875rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.4s var(--bezier);
  }

  .btn-delete-card:hover {
    background: rgba(251,113,133,0.14);
    border-color: rgba(251,113,133,0.3);
    transform: scale(1.05);
  }

  .btn-delete-card:active { transform: scale(0.95); }

  /* ─── Empty state ─── */
  .empty-state {
    position: relative;
    z-index: 2;
    max-width: 1200px;
    margin: 0 auto;
    padding: 6rem 1.5rem;
    text-align: center;
  }

  .empty-state-icon {
    width: 64px; height: 64px;
    margin: 0 auto 1.5rem;
    border-radius: 50%;
    background: var(--glass);
    border: 1px solid var(--hairline);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    color: var(--text-faint);
  }

  .empty-state h3 {
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 0.5rem;
    color: var(--text);
  }

  .empty-state p {
    font-size: 0.875rem;
    color: var(--text-dim);
    max-width: 360px;
    margin: 0 auto;
    line-height: 1.6;
  }

  /* ─── Modal (confirm dialog) ─── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0,0,0,0.7);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.4s var(--bezier);
  }

  .modal-overlay.active {
    opacity: 1;
    pointer-events: auto;
  }

  .modal {
    width: 100%;
    max-width: 420px;
    padding: 0.5rem;
    background: rgba(15,15,15,0.9);
    border: 1px solid var(--hairline-strong);
    border-radius: 2rem;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
    transform: scale(0.95) translateY(1rem);
    transition: all 0.5s var(--bezier-spring);
  }

  .modal-overlay.active .modal {
    transform: scale(1) translateY(0);
  }

  .modal-inner {
    padding: 1.5rem;
    background: rgba(255,255,255,0.02);
    border-radius: calc(2rem - 0.5rem);
  }

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
    margin-bottom: 1.5rem;
  }

  .modal-actions {
    display: flex;
    gap: 0.625rem;
  }

  .modal-btn {
    flex: 1;
    padding: 0.625rem 1.25rem;
    border: 1px solid var(--hairline);
    border-radius: 9999px;
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.4s var(--bezier);
  }

  .modal-btn:active { transform: scale(0.97); }

  .modal-btn-cancel {
    background: rgba(255,255,255,0.04);
    color: var(--text-dim);
  }

  .modal-btn-cancel:hover {
    background: rgba(255,255,255,0.08);
    color: var(--text);
  }

  .modal-btn-confirm {
    background: var(--rose);
    border-color: var(--rose);
    color: #fff;
  }

  .modal-btn-confirm:hover { filter: brightness(1.1); }

  /* ─── Toast ─── */
  .toast {
    position: fixed;
    bottom: 2rem;
    left: 50%;
    transform: translateX(-50%) translateY(1rem);
    z-index: 300;
    padding: 0.75rem 1.25rem;
    background: rgba(15,15,15,0.9);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid var(--hairline-strong);
    border-radius: 9999px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text);
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    opacity: 0;
    pointer-events: none;
    transition: all 0.5s var(--bezier-spring);
  }

  .toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  /* ─── Mobile ─── */
  @media (max-width: 768px) {
    .nav {
      top: 0.75rem;
      margin: 0.75rem auto 0;
      width: calc(100vw - 1.5rem);
      flex-wrap: wrap;
      border-radius: 1.5rem;
      padding: 0.75rem;
    }
    .nav-search { min-width: 0; width: 100%; order: 3; }
    .hero { padding: 3rem 1rem 1.5rem; }
    .hero h1 { font-size: 2.25rem; }
    .filter-bar { padding: 0 1rem 1.5rem; }
    .capture-grid { padding: 0 1rem 4rem; gap: 0.75rem; }
    .stat-card-inner { padding: 1rem; }
    .stat-value { font-size: 1.5rem; }
  }
</style>
</head>
<body>

<div class="bg-mesh"></div>
<div class="bg-grain"></div>

<!-- ─── Floating glass nav ─── -->
<nav class="nav">
  <div class="nav-brand">
    <span class="nav-brand-dot"></span>
    tdai-memory
  </div>
  <div class="nav-tabs">
    <button class="nav-tab active" data-tab="memory" onclick="switchTab('memory')">Memory</button>
    <button class="nav-tab" data-tab="codegraph" onclick="switchTab('codegraph')">CodeGraph</button>
    <button class="nav-tab" data-tab="wiki" onclick="switchTab('wiki')">Wiki</button>
  </div>
  <input class="nav-search" id="search" placeholder="Search captures..." autocomplete="off" />
  <button class="nav-btn" onclick="doSearch()">
    Search
    <span class="nav-btn-icon">&#8599;</span>
  </button>
</nav>

<!-- ─── Memory tab ─── -->
<div id="tab-memory" class="tab-content">
<!-- ─── Hero ─── -->
<section class="hero">
  <div class="hero-eyebrow">
    <span class="hero-eyebrow-dot"></span>
    Memory Database
  </div>
  <h1>Long-term memory<br>for coding agents.</h1>
  <p class="hero-sub">Every decision, learning, and error captured across sessions — searchable, persistent, and contextual.</p>

  <div class="stats-grid" id="statsGrid"></div>
</section>

<!-- ─── Filter bar ─── -->
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

<!-- ─── Capture grid ─── -->
<div class="capture-grid" id="list"></div>
</div>

<!-- ─── CodeGraph tab ─── -->
<div id="tab-codegraph" class="tab-content" style="display:none">
  <section class="hero">
    <div class="hero-eyebrow">
      <span class="hero-eyebrow-dot"></span>
      Code Symbol Index
    </div>
    <h1>CodeGraph<br>Tree-sitter powered.</h1>
    <p class="hero-sub">Functions, classes, methods, and call relationships — indexed from 9 languages, searchable and traceable.</p>
    <div class="stats-grid" id="cgStatsGrid"></div>
  </section>
  <div class="filter-bar">
    <input class="nav-search" id="cgSearch" placeholder="Search symbols..." autocomplete="off" onkeydown="if(event.key==='Enter')loadSymbols()" />
    <button class="nav-btn" onclick="loadSymbols()">Search</button>
  </div>
  <div class="capture-grid" id="cgList"></div>
</div>

<!-- ─── Wiki tab ─── -->
<div id="tab-wiki" class="tab-content" style="display:none">
  <section class="hero">
    <div class="hero-eyebrow">
      <span class="hero-eyebrow-dot"></span>
      Documentation Index
    </div>
    <h1>Wiki<br>Markdown knowledge graph.</h1>
    <p class="hero-sub">Pages, headings, frontmatter, and links — indexed from your docs, searchable and cross-referenced.</p>
    <div class="stats-grid" id="wikiStatsGrid"></div>
  </section>
  <div class="filter-bar">
    <input class="nav-search" id="wikiSearch" placeholder="Search wiki..." autocomplete="off" onkeydown="if(event.key==='Enter')loadWiki()" />
    <button class="nav-btn" onclick="loadWiki()">Search</button>
  </div>
  <div class="capture-grid" id="wikiList"></div>
</div>

<!-- ─── Modal ─── -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-inner">
      <h3 id="modalTitle">Confirm</h3>
      <p id="modalBody">Are you sure?</p>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="modal-btn modal-btn-confirm" id="modalConfirm">Delete</button>
      </div>
    </div>
  </div>
</div>

<!-- ─── Toast ─── -->
<div class="toast" id="toast"></div>

<script>
  // ─── State ───
  let modalCallback = null;
  let observer = null;

  // ─── IntersectionObserver for scroll reveals ───
  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.05, rootMargin: '0px 0px -40px 0px' });
  }

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
    document.getElementById('modalBody').textContent = body;
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
      return '<div class="stat-card"><div class="stat-card-inner">'
        + '<div class="stat-value" style="' + (c.color ? 'color:' + c.color : '') + '">' + c.value + '</div>'
        + '<div class="stat-label">' + c.label + '</div>'
        + '</div></div>';
    }).join('');
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
        return '<div class="stat-card"><div class="stat-card-inner">'
          + '<div class="stat-value" style="' + (c.color ? 'color:' + c.color : '') + '">' + c.value + '</div>'
          + '<div class="stat-label">' + c.label + '</div>'
          + '</div></div>';
      }).join('');
    } catch(e) { document.getElementById('cgStatsGrid').innerHTML = '<p style="color:var(--text-dim);padding:2rem">No CodeGraph data. Run: tdai-memory-mcp index --path src --repo .</p>'; }
  }

  async function loadSymbols() {
    var q = document.getElementById('cgSearch').value;
    var url = '/api/codegraph/symbols?limit=100' + (q ? '&q=' + encodeURIComponent(q) : '');
    var r = await fetch(url);
    var rows = await r.json();
    var list = document.getElementById('cgList');
    if (!rows || rows.length === 0) {
      list.innerHTML = '<p style="color:var(--text-dim);padding:2rem">No symbols found.</p>';
      return;
    }
    list.innerHTML = rows.map(function(s) {
      return '<div class="card" onclick="showSymbolDetails(\\''+s.id+'\\')">'
        + '<div class="card-header">'
        + '<span class="card-type" style="color:var(--accent)">' + s.kind + '</span>'
        + '<span class="card-time">' + s.language + '</span>'
        + '</div>'
        + '<div class="card-content">' + s.name + '</div>'
        + '<div class="card-meta">' + s.file_path + ':' + s.line_start + '</div>'
        + '</div>';
    }).join('');
  }

  async function showSymbolDetails(id) {
    var r1 = await fetch('/api/codegraph/callers?id=' + id);
    var callers = await r1.json();
    var r2 = await fetch('/api/codegraph/callees?id=' + id);
    var callees = await r2.json();
    var html = '<div style="font-family:JetBrains Mono,monospace;font-size:0.8rem;line-height:1.6">'
      + '<h4 style="color:var(--accent);margin-bottom:0.5rem">Callers (' + callers.length + ')</h4>'
      + (callers.length ? callers.map(function(c) { return '<div>' + c.kind + ' <b>' + c.name + '</b> — ' + c.file_path + ':' + c.line + '</div>'; }).join('') : '<div style="color:var(--text-dim)">None</div>')
      + '<h4 style="color:var(--sky);margin:1rem 0 0.5rem">Callees (' + callees.length + ')</h4>'
      + (callees.length ? callees.map(function(c) { return '<div>' + (c.name ? c.kind + ' <b>' + c.name + '</b> — ' + c.file_path + ':' + c.line : '<b>' + c.callee_name + '</b> — <i style="color:var(--text-dim)">unresolved</i>') + '</div>'; }).join('') : '<div style="color:var(--text-dim)">None</div>')
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
        return '<div class="stat-card"><div class="stat-card-inner">'
          + '<div class="stat-value" style="color:' + c.color + '">' + c.value + '</div>'
          + '<div class="stat-label">' + c.label + '</div>'
          + '</div></div>';
      }).join('');
    } catch(e) { document.getElementById('wikiStatsGrid').innerHTML = '<p style="color:var(--text-dim);padding:2rem">No Wiki data. Run: tdai-memory-mcp wiki ingest --path docs --repo .</p>'; }
  }

  async function loadWiki() {
    var q = document.getElementById('wikiSearch').value;
    var url = '/api/wiki/pages?limit=100' + (q ? '&q=' + encodeURIComponent(q) : '');
    var r = await fetch(url);
    var rows = await r.json();
    var list = document.getElementById('wikiList');
    if (!rows || rows.length === 0) {
      list.innerHTML = '<p style="color:var(--text-dim);padding:2rem">No wiki pages found.</p>';
      return;
    }
    list.innerHTML = rows.map(function(p) {
      return '<div class="card">'
        + '<div class="card-header">'
        + '<span class="card-type" style="color:var(--accent)">page</span>'
        + '</div>'
        + '<div class="card-content">' + p.title + '</div>'
        + '<div class="card-meta">' + p.source_file + '</div>'
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
      el.innerHTML = '';
      el.className = '';
      el.innerHTML = '<div class="empty-state">'
        + '<div class="empty-state-icon">&#8709;</div>'
        + '<h3>No captures found</h3>'
        + '<p>Try adjusting your filters or search query. Captures will appear here as your agent learns.</p>'
        + '</div>';
      return;
    }
    el.className = 'capture-grid';
    el.innerHTML = rows.map(function(r, i) {
      var tags = r.tags ? JSON.parse(r.tags) : [];
      var date = new Date(r.created_at).toISOString().split('T')[0];
      var needsExpand = r.content.length > 500;
      return '<div class="capture-card" data-idx="' + i + '">'
        + '<div class="capture-card-inner">'
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
        + '<button class="btn-delete-card" onclick="deleteCapture(\\'' + r.id + '\\')" title="Delete">&#215;</button>'
        + '</div>'
        + '</div>'
        + '</div>';
    }).join('');

    // Observe new cards for scroll reveal
    setupObserver();
    document.querySelectorAll('.capture-card').forEach(function(card) {
      observer.observe(card);
    });
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
      'Delete all "' + type + '" captures?',
      'All captures of type "' + type + '" will be permanently deleted.',
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

  // ─── Init ───
  document.getElementById('search').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doSearch();
  });

  loadStats();
  loadCaptures();
</script>
</body>
</html>`;
}
