import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findOutdatedPages,
  getWikiPage,
  ingestDirectory,
  ingestFile,
  searchWiki,
} from "../../src/wiki/engine.js";

const TMP = join(process.env.HOME ?? "/tmp", ".local", "share", "tdai-memory-mcp", "test-wiki");

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.exec(readFileSync(join(process.cwd(), "src/storage/schema.sql"), "utf-8"));
  return db;
}

function makeTmpDocs() {
  mkdirSync(TMP, { recursive: true });
  const files: Record<string, string> = {
    "getting-started.md": `---
title: Getting Started
tags: [intro, setup]
---

# Getting Started

Install the package with npm.

See [[Configuration]] for setup details.

For advanced usage, see [Advanced Guide](advanced.md).
`,
    "configuration.md": `---
title: Configuration
tags: [config]
---

# Configuration

Set the database path in the config file.

The [[Getting Started]] guide covers basic setup.

See [[Troubleshooting]] if you have problems.
`,
    "advanced.md": `# Advanced Guide

This covers advanced topics.

Refer to [[Configuration]] for settings.
`,
    "troubleshooting.md": `# Troubleshooting

Common issues and solutions.

Check [[Configuration]] first.
`,
    "not-doc.txt": "This is not a markdown file.",
  };

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(TMP, name), content.trim());
  }
}

function cleanup() {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("Integration: Wiki engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    cleanup();
    makeTmpDocs();
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it("ingests a single markdown file", () => {
    const result = ingestFile(db, join(TMP, "getting-started.md"), TMP, null);
    expect(result.skipped).toBe(false);
    expect(result.pages).toBe(1);
    expect(result.links).toBeGreaterThanOrEqual(2); // [[Configuration]] + [Advanced Guide](advanced.md)
  });

  it("skips non-markdown files", () => {
    const result = ingestFile(db, join(TMP, "not-doc.txt"), TMP, null);
    expect(result.skipped).toBe(true);
    expect(result.pages).toBe(0);
  });

  it("ingests a directory recursively", () => {
    const results = ingestDirectory(db, TMP, TMP, null, 50);
    const ingested = results.filter((r) => !r.skipped);
    expect(ingested.length).toBe(4); // 4 .md files
    // .txt is filtered by extension in walk(), so it never appears in results
  });

  it("extracts frontmatter title", () => {
    ingestFile(db, join(TMP, "getting-started.md"), TMP, null);
    const results = searchWiki(db, "Getting Started");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe("Getting Started");
  });

  it("extracts tags from frontmatter", () => {
    ingestFile(db, join(TMP, "getting-started.md"), TMP, null);
    const results = searchWiki(db, "Getting Started");
    const page = getWikiPage(db, results[0].id);
    expect(page).not.toBeNull();
    expect(page?.page.tags).toContain("intro");
    expect(page?.page.tags).toContain("setup");
  });

  it("extracts [[wikilinks]] and resolves them after directory ingest", () => {
    ingestDirectory(db, TMP, TMP, null, 50);
    const results = searchWiki(db, "Getting Started");
    const gsPage = results.find((r) => r.title === "Getting Started");
    expect(gsPage).toBeDefined();
    const page = getWikiPage(db, gsPage!.id);
    expect(page).not.toBeNull();
    // Should have a link to Configuration
    const configLink = page?.links.find((l) => l.toTitle === "Configuration");
    expect(configLink).toBeDefined();
    expect(configLink?.linkType).toBe("wikilink");
    expect(configLink?.toPageId).not.toBeNull(); // resolved
  });

  it("extracts [text](url) markdown links", () => {
    ingestDirectory(db, TMP, TMP, null, 50);
    const results = searchWiki(db, "Getting Started");
    const gsPage = results.find((r) => r.title === "Getting Started");
    expect(gsPage).toBeDefined();
    const page = getWikiPage(db, gsPage!.id);
    expect(page).not.toBeNull();
    const mdLink = page?.links.find((l) => l.linkType === "markdown");
    expect(mdLink).toBeDefined();
    expect(mdLink?.toTitle).toBe("advanced");
  });

  it("returns backlinks", () => {
    ingestDirectory(db, TMP, TMP, null, 50);
    const results = searchWiki(db, "Configuration");
    const configPage = results.find((r) => r.title === "Configuration");
    expect(configPage).toBeDefined();
    const page = getWikiPage(db, configPage!.id);
    expect(page).not.toBeNull();
    // Configuration should have backlinks from Getting Started, Advanced, Troubleshooting
    expect(page?.backlinks.length).toBeGreaterThanOrEqual(2);
    // backlinks have fromPageId pointing to the source page
    // toTitle is the link target (Configuration), not the source
    expect(page?.backlinks.some((l) => l.toTitle === "Configuration")).toBe(true);
  });

  it("searches wiki pages by content", () => {
    ingestDirectory(db, TMP, TMP, null, 50);
    const results = searchWiki(db, "database path config");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Configuration page should match
    expect(results.some((r) => r.title === "Configuration")).toBe(true);
  });

  it("updates existing page on re-ingest", () => {
    // First ingest
    ingestFile(db, join(TMP, "getting-started.md"), TMP, null);
    const r1 = searchWiki(db, "Getting Started");
    expect(r1.length).toBe(1);

    // Modify the file
    writeFileSync(
      join(TMP, "getting-started.md"),
      "---\ntitle: Getting Started\n---\n\n# Getting Started\n\nUpdated content.",
    );

    // Re-ingest
    ingestFile(db, join(TMP, "getting-started.md"), TMP, null);
    const r2 = searchWiki(db, "Getting Started");
    expect(r2.length).toBe(1); // still 1, not 2
    const page = getWikiPage(db, r2[0].id);
    expect(page?.page.content).toContain("Updated content");
  });

  it("finds outdated pages after source changes", () => {
    ingestDirectory(db, TMP, TMP, null, 50);

    // Modify a file
    writeFileSync(
      join(TMP, "configuration.md"),
      "---\ntitle: Configuration\n---\n\n# Configuration\n\nUpdated config content.",
    );

    const outdated = findOutdatedPages(db, TMP, {});
    expect(outdated.length).toBeGreaterThanOrEqual(1);
    expect(outdated.some((o) => o.title === "Configuration")).toBe(true);
    expect(outdated[0].reason).toBe("content changed");
  });

  it("detects deleted source files", () => {
    ingestDirectory(db, TMP, TMP, null, 50);

    // Delete a file
    rmSync(join(TMP, "troubleshooting.md"));

    const outdated = findOutdatedPages(db, TMP, {});
    expect(outdated.some((o) => o.title === "Troubleshooting")).toBe(true);
    expect(outdated.find((o) => o.title === "Troubleshooting")?.reason).toBe("file deleted");
  });

  it("returns empty when all pages are current", () => {
    ingestDirectory(db, TMP, TMP, null, 50);
    const outdated = findOutdatedPages(db, TMP, {});
    expect(outdated.length).toBe(0);
  });

  it("isolates pages by team_id", () => {
    ingestFile(db, join(TMP, "getting-started.md"), TMP, "team-a");
    ingestFile(db, join(TMP, "getting-started.md"), TMP, "team-b");

    const teamA = searchWiki(db, "Getting Started", { teamId: "team-a" });
    const teamB = searchWiki(db, "Getting Started", { teamId: "team-b" });
    const all = searchWiki(db, "Getting Started");

    expect(teamA.length).toBe(1);
    expect(teamB.length).toBe(1);
    expect(teamA[0].id).not.toBe(teamB[0].id);
    expect(all.length).toBe(2);
  });

  it("returns null for non-existent page", () => {
    const page = getWikiPage(db, "NONEXISTENT_ID");
    expect(page).toBeNull();
  });

  it("uses first H1 as title when no frontmatter", () => {
    ingestFile(db, join(TMP, "advanced.md"), TMP, null);
    const results = searchWiki(db, "Advanced Guide");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe("Advanced Guide");
  });
});
