/**
 * Wiki engine: parse markdown docs into structured pages with a link graph.
 *
 * Extracts frontmatter, headings, [[wikilinks]], and [text](url) links.
 * Builds an adjacency list for the link graph.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import type { Database } from "better-sqlite3";
import { generateId } from "../utils/ulid.js";

/** A parsed wiki page. */
export interface WikiPage {
  id: string;
  title: string;
  content: string;
  sourceFile: string;
  section: string | null;
  tags: string | null;
  frontmatter: string | null;
  contentHash: string;
}

/** A link between wiki pages. */
export interface WikiLink {
  fromPageId: string;
  toPageId: string | null;
  toTitle: string;
  linkText: string;
  linkType: string;
  line: number;
}

/** Result of ingesting a file. */
export interface IngestResult {
  file: string;
  pages: number;
  links: number;
  skipped: boolean;
  reason?: string;
}

/** Parse frontmatter (YAML-like) from markdown content. */
function parseFrontmatter(content: string): { frontmatter: string | null; body: string } {
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: null, body: content };
  }
  const frontmatter = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  return { frontmatter, body };
}

/** Extract tags from frontmatter (simple key: value parsing). */
function extractTags(frontmatter: string | null): string | null {
  if (!frontmatter) return null;
  const match = frontmatter.match(/^tags:\s*(.+)$/m);
  if (!match) return null;
  return match[1].replace(/[[\]]/g, "").trim();
}

/** Extract title from frontmatter or first heading. */
function extractTitle(frontmatter: string | null, body: string, fileName: string): string {
  if (frontmatter) {
    const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
    if (titleMatch) return titleMatch[1].replace(/["']/g, "").trim();
  }
  // First H1 heading
  const h1Match = body.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  // Fallback: file name without extension
  return basename(fileName, extname(fileName));
}

/** Extract [[wikilinks]] from content. Returns array of { target, text, line }. */
function extractWikilinks(content: string): Array<{ target: string; text: string; line: number }> {
  const links: Array<{ target: string; text: string; line: number }> = [];
  const lines = content.split("\n");
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    match = regex.exec(lines[i]);
    while (match !== null) {
      links.push({
        target: match[1].trim(),
        text: (match[2] ?? match[1]).trim(),
        line: i + 1,
      });
      match = regex.exec(lines[i]);
    }
  }
  return links;
}

/** Extract [text](url) markdown links from content. */
function extractMarkdownLinks(
  content: string,
): Array<{ target: string; text: string; line: number }> {
  const links: Array<{ target: string; text: string; line: number }> = [];
  const lines = content.split("\n");
  // Match [text](path) but not ![alt](url) (images)
  const regex = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    match = regex.exec(lines[i]);
    while (match !== null) {
      const target = match[2].trim();
      // Only include local .md links (not http URLs)
      if (!target.startsWith("http") && !target.startsWith("mailto:")) {
        links.push({
          target: target.replace(/\.md$/i, ""),
          text: match[1].trim(),
          line: i + 1,
        });
      }
      match = regex.exec(lines[i]);
    }
  }
  return links;
}

/** Parse a markdown file into a wiki page with links. */
function parseMarkdownFile(
  filePath: string,
  repoPath: string,
): {
  page: WikiPage;
  links: Array<{ target: string; text: string; line: number; type: string }>;
} | null {
  const ext = extname(filePath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") return null;

  let source: string;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const relPath = relative(repoPath, filePath).split(sep).join("/");
  const { frontmatter, body } = parseFrontmatter(source);
  const title = extractTitle(frontmatter, body, filePath);
  const tags = extractTags(frontmatter);
  const contentHash = createHash("sha256").update(source).digest("hex");

  const page: WikiPage = {
    id: generateId(),
    title,
    content: body,
    sourceFile: relPath,
    section: null,
    tags,
    frontmatter,
    contentHash,
  };

  const wikilinks = extractWikilinks(body).map((l) => ({ ...l, type: "wikilink" }));
  const mdlinks = extractMarkdownLinks(body).map((l) => ({ ...l, type: "markdown" }));
  const links = [...wikilinks, ...mdlinks];

  return { page, links };
}

/** Ingest a single markdown file into the database. */
export function ingestFile(
  db: Database,
  filePath: string,
  repoPath: string,
  teamId: string | null,
): IngestResult {
  const ext = extname(filePath).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") {
    return { file: filePath, pages: 0, links: 0, skipped: true, reason: "not markdown" };
  }

  const parsed = parseMarkdownFile(filePath, repoPath);
  if (!parsed) {
    return { file: filePath, pages: 0, links: 0, skipped: true, reason: "parse failed" };
  }

  const relPath = relative(repoPath, filePath).split(sep).join("/");
  const now = Date.now();

  // Check if page already exists (by source_file)
  const existing = db
    .prepare("SELECT id FROM wiki_pages WHERE source_file = ? AND team_id IS ?")
    .get(relPath, teamId) as { id: string } | undefined;

  let pageId = parsed.page.id;
  if (existing) {
    // Update existing page
    pageId = existing.id;
    db.prepare(
      "UPDATE wiki_pages SET title = ?, content = ?, tags = ?, frontmatter = ?, content_hash = ?, updated_at = ? WHERE id = ?",
    ).run(
      parsed.page.title,
      parsed.page.content,
      parsed.page.tags,
      parsed.page.frontmatter,
      parsed.page.contentHash,
      now,
      pageId,
    );
    // Delete old links
    db.prepare("DELETE FROM wiki_links WHERE from_page_id = ?").run(pageId);
  } else {
    // Insert new page
    db.prepare(
      `INSERT INTO wiki_pages (id, title, content, source_file, section, tags, frontmatter, content_hash, team_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.page.id,
      parsed.page.title,
      parsed.page.content,
      parsed.page.sourceFile,
      parsed.page.section,
      parsed.page.tags,
      parsed.page.frontmatter,
      parsed.page.contentHash,
      teamId,
      now,
      now,
    );
  }

  // Insert links (resolve targets later)
  const linkStmt = db.prepare(
    "INSERT INTO wiki_links (from_page_id, to_page_id, to_title, link_text, link_type, line) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const link of parsed.links) {
    // Try to resolve target by title
    const target = db
      .prepare("SELECT id FROM wiki_pages WHERE title = ? AND team_id IS ? LIMIT 1")
      .get(link.target, teamId) as { id: string } | undefined;
    linkStmt.run(pageId, target?.id ?? null, link.target, link.text, link.type, link.line);
  }

  return {
    file: relPath,
    pages: 1,
    links: parsed.links.length,
    skipped: false,
  };
}

/** Ingest a directory of markdown files. */
export function ingestDirectory(
  db: Database,
  dirPath: string,
  repoPath: string,
  teamId: string | null,
  maxFiles = 200,
): IngestResult[] {
  const results: IngestResult[] = [];
  const files: string[] = [];

  const walk = (dir: string) => {
    if (files.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "vendor") continue;
        walk(fullPath);
      } else if (stat.isFile()) {
        const ext = extname(fullPath).toLowerCase();
        if (ext === ".md" || ext === ".markdown") {
          files.push(fullPath);
        }
      }
    }
  };

  walk(dirPath);

  for (const file of files) {
    const result = ingestFile(db, file, repoPath, teamId);
    results.push(result);
  }

  // Re-resolve links now that all pages are indexed
  const unresolved = db
    .prepare("SELECT id, to_title FROM wiki_links WHERE to_page_id IS NULL")
    .all() as { id: number; to_title: string }[];
  if (unresolved.length > 0) {
    const updateStmt = db.prepare("UPDATE wiki_links SET to_page_id = ? WHERE id = ?");
    for (const u of unresolved) {
      const target = db
        .prepare("SELECT id FROM wiki_pages WHERE title = ? AND team_id IS ? LIMIT 1")
        .get(u.to_title, teamId) as { id: string } | undefined;
      if (target) {
        updateStmt.run(target.id, u.id);
      }
    }
  }

  return results;
}

/** Search wiki pages using FTS5. */
export function searchWiki(
  db: Database,
  query: string,
  opts: { teamId?: string; limit?: number } = {},
): Array<{ id: string; title: string; sourceFile: string; snippet: string }> {
  const limit = opts.limit ?? 10;
  let sql = `
    SELECT w.id, w.title, w.source_file, snippet(wiki_fts, 1, '<b>', '</b>', '...', 20) as snippet
    FROM wiki_fts f
    JOIN wiki_pages w ON w.id = f.id
    WHERE wiki_fts MATCH ?
  `;
  const params: unknown[] = [query];
  if (opts.teamId !== undefined) {
    sql += " AND w.team_id IS ?";
    params.push(opts.teamId);
  }
  sql += " LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    title: string;
    source_file: string;
    snippet: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sourceFile: r.source_file,
    snippet: r.snippet,
  }));
}

/** Get a wiki page by ID, including linked pages. */
export function getWikiPage(
  db: Database,
  pageId: string,
): { page: WikiPage; links: WikiLink[]; backlinks: WikiLink[] } | null {
  const row = db.prepare("SELECT * FROM wiki_pages WHERE id = ?").get(pageId) as
    | {
        id: string;
        title: string;
        content: string;
        source_file: string;
        section: string | null;
        tags: string | null;
        frontmatter: string | null;
        content_hash: string;
      }
    | undefined;

  if (!row) return null;

  const page: WikiPage = {
    id: row.id,
    title: row.title,
    content: row.content,
    sourceFile: row.source_file,
    section: row.section,
    tags: row.tags,
    frontmatter: row.frontmatter,
    contentHash: row.content_hash,
  };

  const linkRows = db
    .prepare("SELECT * FROM wiki_links WHERE from_page_id = ? ORDER BY line")
    .all(pageId) as Array<{
    from_page_id: string;
    to_page_id: string | null;
    to_title: string;
    link_text: string;
    link_type: string;
    line: number;
  }>;

  const links: WikiLink[] = linkRows.map((r) => ({
    fromPageId: r.from_page_id,
    toPageId: r.to_page_id,
    toTitle: r.to_title,
    linkText: r.link_text,
    linkType: r.link_type,
    line: r.line,
  }));

  const backlinkRows = db
    .prepare("SELECT * FROM wiki_links WHERE to_page_id = ? ORDER BY line")
    .all(pageId) as Array<{
    from_page_id: string;
    to_page_id: string | null;
    to_title: string;
    link_text: string;
    link_type: string;
    line: number;
  }>;

  const backlinks: WikiLink[] = backlinkRows.map((r) => ({
    fromPageId: r.from_page_id,
    toPageId: r.to_page_id,
    toTitle: r.to_title,
    linkText: r.link_text,
    linkType: r.link_type,
    line: r.line,
  }));

  return { page, links, backlinks };
}

/** Find pages whose source file has changed (content_hash mismatch). */
export function findOutdatedPages(
  db: Database,
  repoPath: string,
  opts: { teamId?: string } = {},
): Array<{ id: string; title: string; sourceFile: string; reason: string }> {
  const pages = db
    .prepare("SELECT id, title, source_file, content_hash FROM wiki_pages WHERE team_id IS ?")
    .all(opts.teamId ?? null) as Array<{
    id: string;
    title: string;
    source_file: string;
    content_hash: string;
  }>;

  const outdated: Array<{ id: string; title: string; sourceFile: string; reason: string }> = [];

  for (const page of pages) {
    const fullPath = join(repoPath, page.source_file);
    if (!existsSync(fullPath)) {
      outdated.push({
        id: page.id,
        title: page.title,
        sourceFile: page.source_file,
        reason: "file deleted",
      });
      continue;
    }
    try {
      const content = readFileSync(fullPath, "utf-8");
      const hash = createHash("sha256").update(content).digest("hex");
      if (hash !== page.content_hash) {
        outdated.push({
          id: page.id,
          title: page.title,
          sourceFile: page.source_file,
          reason: "content changed",
        });
      }
    } catch {
      outdated.push({
        id: page.id,
        title: page.title,
        sourceFile: page.source_file,
        reason: "read error",
      });
    }
  }

  return outdated;
}
