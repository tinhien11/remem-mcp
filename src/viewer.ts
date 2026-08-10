import Database from "better-sqlite3";
import { createServer as createHttpServer, type Server } from "node:http";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Start a local web viewer for the memory database. */
export function startViewer(dbPath: string, port: number): Server {
  const db = new Database(dbPath, { readonly: true });

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
        sql += " WHERE " + conditions.join(" AND ");
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tdai-memory viewer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0d1117; color: #c9d1d9; }
  .header { padding: 16px 24px; border-bottom: 1px solid #30363d; display: flex; gap: 16px; align-items: center; }
  .header h1 { font-size: 18px; color: #58a6ff; }
  .header input { flex: 1; padding: 8px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 14px; }
  .header button { padding: 8px 16px; background: #238636; border: none; border-radius: 6px; color: #fff; cursor: pointer; font-size: 14px; }
  .header button:hover { background: #2ea043; }
  .filters { padding: 8px 24px; border-bottom: 1px solid #21262d; display: flex; gap: 8px; flex-wrap: wrap; }
  .filters select { padding: 4px 8px; background: #161b22; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; }
  .stats { padding: 8px 24px; font-size: 13px; color: #8b949e; }
  .list { padding: 0 24px; }
  .item { padding: 12px 0; border-bottom: 1px solid #21262d; }
  .item-meta { font-size: 12px; color: #8b949e; margin-bottom: 4px; display: flex; gap: 12px; }
  .item-type { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .type-decision { background: #1f6feb33; color: #58a6ff; }
  .type-learning { background: #23863633; color: #3fb950; }
  .type-error { background: #da363333; color: #f85149; }
  .type-task { background: #bf870033; color: #d29922; }
  .type-conversation { background: #8b949e33; color: #8b949e; }
  .type-atom { background: #bc8cff33; color: #bc8cff; }
  .item-content { font-size: 14px; line-height: 1.5; }
  .item-tags { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
  .tag { padding: 1px 6px; background: #21262d; border-radius: 4px; font-size: 11px; color: #8b949e; }
  .empty { padding: 48px; text-align: center; color: #8b949e; }
</style>
</head>
<body>
<div class="header">
  <h1>tdai-memory</h1>
  <input id="search" placeholder="Search memory..." />
  <button onclick="doSearch()">Search</button>
</div>
<div class="filters">
  <select id="typeFilter" onchange="loadCaptures()">
    <option value="">All types</option>
    <option value="decision">decision</option>
    <option value="learning">learning</option>
    <option value="error">error</option>
    <option value="task">task</option>
    <option value="conversation">conversation</option>
    <option value="atom">atom</option>
  </select>
</div>
<div class="stats" id="stats"></div>
<div class="list" id="list"></div>
<script>
async function loadStats() {
  const r = await fetch('/api/stats');
  const d = await r.json();
  document.getElementById('stats').textContent =
    d.total.count + ' captures in ' + d.sessions.count + ' session(s)';
}
async function loadCaptures() {
  const type = document.getElementById('typeFilter').value;
  const params = new URLSearchParams({ limit: 100 });
  if (type) params.set('type', type);
  const r = await fetch('/api/captures?' + params);
  const rows = await r.json();
  renderList(rows);
}
async function doSearch() {
  const q = document.getElementById('search').value.trim();
  if (!q) { loadCaptures(); return; }
  const r = await fetch('/api/search?q=' + encodeURIComponent(q));
  const rows = await r.json();
  renderList(rows);
}
function renderList(rows) {
  const el = document.getElementById('list');
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">No captures found.</div>';
    return;
  }
  el.innerHTML = rows.map(function(r) {
    var tags = r.tags ? JSON.parse(r.tags) : [];
    var date = new Date(r.created_at).toISOString().split('T')[0];
    return '<div class="item">'
      + '<div class="item-meta">'
      + '<span class="item-type type-' + r.type + '">' + r.type + '</span>'
      + '<span>' + date + '</span>'
      + '<span>' + r.agent_id + '</span>'
      + '<span>' + r.id + '</span>'
      + '</div>'
      + '<div class="item-content">' + escapeHtml(r.content) + '</div>'
      + (tags.length > 0 ? '<div class="item-tags">' + tags.map(function(t) {
        return '<span class="tag">' + escapeHtml(t) + '</span>';
      }).join('') + '</div>' : '')
      + '</div>';
  }).join('');
}
function escapeHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
document.getElementById('search').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doSearch();
});
loadStats();
loadCaptures();
</script>
</body>
</html>`;
}
