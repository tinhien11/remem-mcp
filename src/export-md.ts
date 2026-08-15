import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

interface MdExportRow {
  id: string;
  session_key: string;
  agent_id: string;
  type: string;
  content: string;
  tags: string | null;
  created_at: number;
  trust_state: string | null;
}

/** Ordered list of capture types for grouping in the export. */
const TYPE_ORDER = [
  "learning",
  "decision",
  "error",
  "task",
  "conversation",
  "atom",
  "pattern",
];

/** Escape a string so it is safe to embed in a Markdown document body. */
function escapeMd(text: string): string {
  // Collapse 3+ newlines so we never accidentally produce section breaks
  // that would split a capture entry across `---` dividers.
  return text.replace(/\n{3,}/g, "\n\n");
}

/** Format a created_at epoch-ms value as a YYYY-MM-DD date. */
function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse a JSON tags column into a string array. */
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Export captures to a human-readable Markdown file, grouped by type and
 * sorted newest-first within each group.
 */
export function exportMarkdown(
  dbPath: string,
  outputPath: string,
  filters?: { sessionKey?: string; type?: string; tag?: string },
): void {
  const db = new Database(dbPath, { readonly: true });

  let sql =
    "SELECT id, session_key, agent_id, type, content, tags, created_at, trust_state FROM captures WHERE deleted_at IS NULL";
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filters?.sessionKey) {
    conditions.push("session_key = ?");
    params.push(filters.sessionKey);
  }
  if (filters?.type) {
    conditions.push("type = ?");
    params.push(filters.type);
  }
  if (filters?.tag) {
    // tags is stored as a JSON array string; match as a substring so a tag
    // like "arch" does not match "architecture" — we wrap the filter in quotes.
    conditions.push("tags LIKE ?");
    params.push(`%"${filters.tag.replace(/"/g, '\\"')}"%`);
  }
  if (conditions.length > 0) {
    sql += ` AND ${conditions.join(" AND ")}`;
  }

  sql += " ORDER BY created_at DESC";

  const rows = db.prepare(sql).all(...params) as MdExportRow[];
  db.close();

  const total = rows.length;
  const generatedAt = new Date().toISOString();

  // Group by type, preserving TYPE_ORDER; unknown types go last alphabetically.
  const byType = new Map<string, MdExportRow[]>();
  for (const row of rows) {
    const group = byType.get(row.type) ?? [];
    group.push(row);
    byType.set(row.type, group);
  }

  const orderedTypes = [
    ...TYPE_ORDER.filter((t) => byType.has(t)),
    ...[...byType.keys()]
      .filter((t) => !TYPE_ORDER.includes(t))
      .sort((a, b) => a.localeCompare(b)),
  ];

  const lines: string[] = [];
  lines.push("# remem-mcp Memory Export");
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Total captures: ${total}`);
  if (filters?.sessionKey) lines.push(`Session filter: ${filters.sessionKey}`);
  if (filters?.type) lines.push(`Type filter: ${filters.type}`);
  if (filters?.tag) lines.push(`Tag filter: ${filters.tag}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const type of orderedTypes) {
    const group = byType.get(type)!;
    lines.push(`# ${type} (${group.length})`);
    lines.push("");

    for (const row of group) {
      const tags = parseTags(row.tags);
      lines.push(`## [${row.type}] ${row.id}`);
      lines.push(`**Date:** ${formatDate(row.created_at)}`);
      if (tags.length > 0) lines.push(`**Tags:** ${tags.join(", ")}`);
      lines.push(`**Session:** ${row.session_key}`);
      if (row.trust_state && row.trust_state !== "candidate") {
        lines.push(`**Trust:** ${row.trust_state}`);
      }
      lines.push("");
      lines.push(escapeMd(row.content));
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  const markdown = lines.join("\n");

  if (outputPath === "-") {
    process.stdout.write(`${markdown}\n`);
  } else {
    writeFileSync(outputPath, markdown, "utf-8");
    console.log(
      `Exported ${total} captures (${orderedTypes.length} type${orderedTypes.length === 1 ? "" : "s"}) to ${outputPath}`,
    );
  }
}
