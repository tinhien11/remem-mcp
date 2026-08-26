/**
 * CodeGraph engine: parse code, extract symbols, build call graph, impact analysis.
 *
 * Uses @kreuzberg/tree-sitter-language-pack for multi-language parsing.
 * Supports: TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, C#.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { Database } from "better-sqlite3";
import { generateId } from "../utils/ulid.js";

// Lazy-load the language pack (CommonJS interop)
let _pack: unknown = null;
async function getPack(): Promise<Record<string, unknown>> {
  if (!_pack) {
    const mod = await import("@kreuzberg/tree-sitter-language-pack");
    // Handle both ESM default and CJS module.exports
    _pack = mod.default ?? mod;
  }
  return _pack as Record<string, unknown>;
}

/** Supported languages mapped to file extensions. */
const EXTENSION_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
};

/** Languages we support for symbol extraction. */
export const SUPPORTED_LANGUAGES = new Set(Object.values(EXTENSION_MAP));

/** Detect language from file extension. Returns null if unsupported. */
export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

/** A symbol extracted from code. */
export interface SymbolInfo {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: string;
  signature: string | null;
  docstring: string | null;
  parentId: string | null;
  contentHash: string;
}

/** A call relationship. */
export interface CallInfo {
  callerId: string;
  calleeName: string;
  calleeId: string | null;
  line: number;
  kind: string;
  callType?: string;
}

/** An import relationship. */
export interface ImportInfo {
  filePath: string;
  symbolName: string;
  sourcePath: string | null;
  line: number;
  language: string;
}

/** Result of indexing a file. */
export interface IndexResult {
  file: string;
  language: string;
  symbols: number;
  calls: number;
  imports: number;
  skipped: boolean;
}

/** Impact analysis result. */
export interface ImpactResult {
  rootSymbol: SymbolInfo;
  affected: Array<{ symbol: SymbolInfo; depth: number; path: string[] }>;
}

/** Parse a file and extract symbols, calls, and imports. */
export async function parseFile(
  filePath: string,
  repoPath: string,
): Promise<{ symbols: SymbolInfo[]; calls: CallInfo[]; imports: ImportInfo[] } | null> {
  const language = detectLanguage(filePath);
  if (!language) return null;

  const pack = (await getPack()) as {
    hasLanguage: (lang: string) => boolean;
    process: (
      source: string,
      opts: { language: string },
    ) => {
      structure: Array<{
        kind?: string;
        name?: string;
        span?: { startLine?: number; endLine?: number };
        signature?: string;
        docComment?: string;
        children?: Array<{
          kind?: string;
          name?: string;
          span?: { startLine?: number; endLine?: number };
          signature?: string;
          docComment?: string;
        }>;
      }>;
      imports: Array<{
        items?: string[];
        source?: string;
        span?: { startLine?: number };
      }>;
    } | null;
  };
  if (!pack.hasLanguage(language)) return null;

  let source: string;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // Skip files that are too large — tree-sitter parsing + regex extraction
  // scales O(n) with file size, and very large files are usually generated/vendored
  const MAX_FILE_LINES = 3000;
  const MAX_FILE_BYTES = 200_000; // 200KB
  if (source.length > MAX_FILE_BYTES || source.split("\n").length > MAX_FILE_LINES) {
    return null;
  }

  const result = pack.process(source, { language });
  if (!result) return null;

  const relPath = relative(repoPath, filePath).split(sep).join("/");
  const symbols: SymbolInfo[] = [];
  const calls: CallInfo[] = [];
  const imports: ImportInfo[] = [];

  // Cache source lines once — used for offset calculation in extractSymbols
  const sourceLines = source.split("\n");
  // Precompute cumulative line start offsets for O(1) line→offset lookup
  const lineOffsets: number[] = [0];
  for (let i = 0; i < sourceLines.length; i++) {
    lineOffsets.push(lineOffsets[i] + sourceLines[i].length + 1); // +1 for \n
  }

  // Extract symbols from structure
  const extractSymbols = (
    items: Array<{
      kind?: string;
      name?: string;
      span?: { startLine?: number; endLine?: number };
      signature?: string;
      docComment?: string;
      children?: Array<{
        kind?: string;
        name?: string;
        span?: { startLine?: number; endLine?: number };
        signature?: string;
        docComment?: string;
      }>;
    }>,
    parentId: string | null,
  ) => {
    for (const item of items) {
      if (!item.name) continue;
      const id = generateId();
      const lineStart = (item.span?.startLine ?? 0) + 1; // 1-indexed
      const lineEnd = (item.span?.endLine ?? lineStart) + 1;
      // Use cached lineOffsets instead of source.split("\n") per symbol
      const bodyStart = item.span?.startLine !== undefined ? lineOffsets[item.span.startLine] : 0;
      const bodyEnd =
        item.span?.endLine !== undefined ? lineOffsets[item.span.endLine + 1] - 1 : source.length;
      const bodyText = source.slice(bodyStart, bodyEnd);
      symbols.push({
        id,
        name: item.name,
        kind: item.kind ?? "unknown",
        filePath: relPath,
        lineStart,
        lineEnd,
        language,
        signature: item.signature ?? null,
        docstring: item.docComment ?? null,
        parentId,
        contentHash: createHash("sha256")
          .update(item.name + relPath + lineStart)
          .digest("hex"),
      });

      // Extract calls within this symbol's body — single-pass on body text
      // Captures: foo(), obj.method(), <Component/>, Class.create()
      // Uses cached bodyText + offset→line map (no per-line regex)
      const bodyStartLine = lineStart;

      // Build offset→line map for this body using cached lineOffsets
      const offsetToLine = (offset: number): number => {
        // offset is relative to bodyText which starts at bodyStart in source
        const sourceOffset = bodyStart + offset;
        // Binary search in lineOffsets
        let lo = 0,
          hi = lineOffsets.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (lineOffsets[mid] <= sourceOffset) lo = mid;
          else hi = mid - 1;
        }
        return lo + 1; // 1-indexed
      };

      // Track offsets already captured to avoid duplicates
      const capturedOffsets = new Set<number>();

      // Pass 1: JSX components <Component> — capitalized identifiers
      const jsxRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g;
      let jMatch: RegExpExecArray | null;
      while ((jMatch = jsxRegex.exec(bodyText)) !== null) {
        const calleeName = jMatch[1];
        const offset = jMatch.index;
        if (!isKeywordOrSelf(calleeName, item.name) && !capturedOffsets.has(offset)) {
          calls.push({
            callerId: id,
            calleeName,
            calleeId: null,
            line: offsetToLine(offset),
            kind: "call",
            callType: "jsx",
          });
          capturedOffsets.add(offset);
        }
      }

      // Pass 2: Method calls (obj.method) — captures full qualified name
      const methodCallRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
      let mMatch: RegExpExecArray | null;
      while ((mMatch = methodCallRegex.exec(bodyText)) !== null) {
        const receiver = mMatch[1];
        const methodName = mMatch[2];
        const calleeName = `${receiver}.${methodName}`;
        const offset = mMatch.index;
        if (
          !isKeywordOrSelf(methodName, item.name) &&
          !isKeywordOrSelf(receiver, item.name) &&
          !isStdlibCall(calleeName, language) &&
          !capturedOffsets.has(offset)
        ) {
          calls.push({
            callerId: id,
            calleeName,
            calleeId: null,
            line: offsetToLine(offset),
            kind: "call",
            callType: "method",
          });
          capturedOffsets.add(offset);
        }
      }

      // Pass 3: Simple calls (foo) — skip if offset already captured or stdlib
      const simpleCallRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = simpleCallRegex.exec(bodyText)) !== null) {
        const calleeName = match[1];
        const offset = match.index;
        if (
          !isKeywordOrSelf(calleeName, item.name) &&
          !isStdlibCall(calleeName, language) &&
          !capturedOffsets.has(offset)
        ) {
          calls.push({
            callerId: id,
            calleeName,
            calleeId: null,
            line: offsetToLine(offset),
            kind: "call",
            callType: "direct",
          });
          capturedOffsets.add(offset);
        }
      }

      // Recurse into children
      if (item.children && item.children.length > 0) {
        extractSymbols(item.children, id);
      }
    }
  };

  extractSymbols(result.structure ?? [], null);

  // Extract imports
  for (const imp of result.imports ?? []) {
    imports.push({
      filePath: relPath,
      symbolName: imp.items?.join(", ") ?? imp.source ?? "unknown",
      sourcePath: imp.source ?? null,
      line: (imp.span?.startLine ?? 0) + 1,
      language,
    });
  }

  return { symbols, calls, imports };
}

/** Check if a name is a language keyword or the symbol itself (should be skipped in call extraction). */
function isKeywordOrSelf(name: string, symbolName: string): boolean {
  if (name === symbolName) return true;
  const keywords = new Set([
    "if",
    "for",
    "while",
    "switch",
    "return",
    "function",
    "def",
    "func",
    "fn",
    "print",
    "console",
    "require",
    "import",
    "export",
    "class",
    "struct",
    "enum",
    "interface",
    "type",
    "const",
    "let",
    "var",
    "new",
    "delete",
    "typeof",
    "instanceof",
    "void",
    "in",
    "of",
    "await",
    "async",
    "yield",
    "throw",
    "try",
    "catch",
    "finally",
    "break",
    "continue",
    "do",
    "else",
    "case",
    "default",
    "extends",
    "implements",
    "super",
    "this",
    "self",
    "true",
    "false",
    "null",
    "undefined",
    "nil",
    "None",
    "True",
    "False",
    "println",
    "printf",
    "fmt",
    "err",
    "panic",
    "recover",
  ]);
  return keywords.has(name);
}

/** Stdlib prefixes per language — calls to these are skipped (not indexed). */
const STDLIB_PREFIXES: Record<string, Set<string>> = {
  go: new Set([
    "fmt",
    "json",
    "os",
    "io",
    "strings",
    "strconv",
    "time",
    "errors",
    "sync",
    "context",
    "path",
    "filepath",
    "sort",
    "bytes",
    "bufio",
    "encoding",
    "net",
    "http",
    "url",
    "regexp",
    "math",
    "log",
    "reflect",
    "runtime",
    "unsafe",
    "atomic",
    "crypto",
    "hash",
    "base64",
    "hex",
    "ioutil",
    "filepath",
    "unicode",
    "testing",
    "flag",
    "env",
  ]),
  typescript: new Set([
    "console",
    "JSON",
    "Math",
    "Date",
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Promise",
    "Symbol",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Error",
    "RegExp",
    "Buffer",
    "process",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "fetch",
    "URL",
    "URLSearchParams",
    "FormData",
    "Headers",
    "Request",
    "Response",
    "AbortController",
    "Event",
    "EventTarget",
    "CustomEvent",
    "TextEncoder",
    "TextDecoder",
    "crypto",
    "performance",
    "queueMicrotask",
    "atob",
    "btoa",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "decodeURIComponent",
    "encodeURI",
    "decodeURI",
  ]),
  javascript: new Set([
    "console",
    "JSON",
    "Math",
    "Date",
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Promise",
    "Symbol",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Error",
    "RegExp",
    "Buffer",
    "process",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "fetch",
    "URL",
    "URLSearchParams",
    "FormData",
    "Headers",
    "Request",
    "Response",
    "AbortController",
    "Event",
    "EventTarget",
    "CustomEvent",
    "TextEncoder",
    "TextDecoder",
    "crypto",
    "performance",
    "queueMicrotask",
    "atob",
    "btoa",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "decodeURIComponent",
    "encodeURI",
    "decodeURI",
  ]),
  python: new Set([
    "print",
    "len",
    "range",
    "str",
    "int",
    "float",
    "bool",
    "list",
    "dict",
    "set",
    "tuple",
    "type",
    "isinstance",
    "issubclass",
    "id",
    "hash",
    "dir",
    "vars",
    "globals",
    "locals",
    "exec",
    "eval",
    "compile",
    "open",
    "input",
    "repr",
    "format",
    "chr",
    "ord",
    "hex",
    "oct",
    "bin",
    "abs",
    "min",
    "max",
    "sum",
    "round",
    "pow",
    "divmod",
    "sorted",
    "reversed",
    "enumerate",
    "zip",
    "map",
    "filter",
    "any",
    "all",
    "next",
    "iter",
    "getattr",
    "setattr",
    "hasattr",
    "delattr",
    "property",
    "staticmethod",
    "classmethod",
    "super",
    "object",
    "Exception",
    "ValueError",
    "TypeError",
    "KeyError",
    "IndexError",
    "AttributeError",
    "RuntimeError",
    "StopIteration",
    "os",
    "sys",
    "json",
    "re",
    "time",
    "datetime",
    "pathlib",
    "typing",
    "collections",
    "itertools",
    "functools",
    "subprocess",
    "argparse",
    "logging",
    "unittest",
    "asyncio",
    "threading",
    "multiprocessing",
    "pickle",
    "shutil",
    "tempfile",
    "glob",
    "fnmatch",
    "csv",
    "io",
    "base64",
    "hashlib",
    "hmac",
    "secrets",
    "uuid",
    "copy",
    "math",
    "random",
    "statistics",
    "decimal",
    "fractions",
    "sqlite3",
  ]),
  rust: new Set([
    "println",
    "print",
    "eprintln",
    "eprint",
    "format",
    "vec",
    "String",
    "Vec",
    "Option",
    "Result",
    "Some",
    "None",
    "Ok",
    "Err",
    "Box",
    "Rc",
    "Arc",
    "RefCell",
    "Cell",
    "Mutex",
    "RwLock",
    "HashMap",
    "HashSet",
    "BTreeMap",
    "BTreeSet",
    "VecDeque",
    "LinkedList",
    "std",
    "core",
    "alloc",
    "macro",
    "todo",
    "unimplemented",
    "panic",
    "assert",
    "assert_eq",
    "assert_ne",
    "debug_assert",
    "debug_assert_eq",
    "cfg",
    "env",
    "include",
    "concat",
    "stringify",
    "file",
    "line",
    "module_path",
    "column",
    "format_args",
    "write",
    "writeln",
  ]),
};

/** Check if a callee name is a stdlib call for the given language. */
function isStdlibCall(calleeName: string, language: string): boolean {
  const prefixes = STDLIB_PREFIXES[language];
  if (!prefixes) return false;
  // Check direct match (e.g. "println", "len")
  if (prefixes.has(calleeName)) return true;
  // Check prefix match (e.g. "fmt.Printf" → prefix "fmt")
  const dotIdx = calleeName.indexOf(".");
  if (dotIdx > 0) {
    const prefix = calleeName.slice(0, dotIdx);
    if (prefixes.has(prefix)) return true;
  }
  return false;
}

/** Index a single file into the database. */
export async function indexFile(
  db: Database,
  filePath: string,
  repoPath: string,
  teamId: string | null,
): Promise<IndexResult> {
  const language = detectLanguage(filePath);
  if (!language) {
    return { file: filePath, language: "unknown", symbols: 0, calls: 0, imports: 0, skipped: true };
  }

  const parsed = await parseFile(filePath, repoPath);
  if (!parsed) {
    return { file: filePath, language, symbols: 0, calls: 0, imports: 0, skipped: true };
  }

  const relPath = relative(repoPath, filePath).split(sep).join("/");
  const now = Date.now();

  // Delete existing symbols for this file
  const existingIds = db
    .prepare("SELECT id FROM symbols WHERE file_path = ? AND team_id IS ?")
    .all(relPath, teamId) as { id: string }[];
  if (existingIds.length > 0) {
    const placeholders = existingIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM calls WHERE caller_id IN (${placeholders})`).run(
      ...existingIds.map((e) => e.id),
    );
    db.prepare("DELETE FROM symbols WHERE file_path = ? AND team_id IS ?").run(relPath, teamId);
  }
  db.prepare("DELETE FROM imports WHERE file_path = ? AND team_id IS ?").run(relPath, teamId);

  // Insert symbols
  const symbolStmt = db.prepare(
    `INSERT INTO symbols (id, name, kind, file_path, line_start, line_end, language, signature, docstring, parent_id, team_id, repo_path, content_hash, module_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const modulePath = relPath.replace(
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|cc|cxx|hpp|cs)$/,
    "",
  );
  for (const s of parsed.symbols) {
    symbolStmt.run(
      s.id,
      s.name,
      s.kind,
      s.filePath,
      s.lineStart,
      s.lineEnd,
      s.language,
      s.signature,
      s.docstring,
      s.parentId,
      teamId,
      repoPath,
      s.contentHash,
      modulePath,
      now,
      now,
    );
  }

  // Insert calls (callee_id resolved later by 6-strategy cascade in indexDirectory)
  const callStmt = db.prepare(
    `INSERT INTO calls (caller_id, callee_name, callee_id, line, kind, call_type, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of parsed.calls) {
    callStmt.run(
      c.callerId,
      c.calleeName,
      null, // Will be resolved by resolveAllCalls() in indexDirectory
      c.line,
      c.kind,
      (c as { callType?: string }).callType ?? "direct",
      teamId,
    );
  }

  // Insert imports
  const importStmt = db.prepare(
    `INSERT INTO imports (file_path, symbol_name, source_path, line, language, team_id, repo_path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const imp of parsed.imports) {
    importStmt.run(
      imp.filePath,
      imp.symbolName,
      imp.sourcePath,
      imp.line,
      imp.language,
      teamId,
      repoPath,
    );
  }

  return {
    file: relPath,
    language,
    symbols: parsed.symbols.length,
    calls: parsed.calls.length,
    imports: parsed.imports.length,
    skipped: false,
  };
}

/** Index a directory recursively. */
export async function indexDirectory(
  db: Database,
  dirPath: string,
  repoPath: string,
  teamId: string | null,
  maxFiles = 10000,
): Promise<IndexResult[]> {
  const results: IndexResult[] = [];
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
        // Skip common ignore dirs
        if (
          entry === "node_modules" ||
          entry === ".git" ||
          entry === "dist" ||
          entry === "build" ||
          entry === "target" ||
          entry === "__pycache__" ||
          entry === ".next" ||
          entry === "vendor" ||
          entry === ".venv" ||
          entry.startsWith(".")
        )
          continue;
        walk(fullPath);
      } else if (stat.isFile()) {
        if (detectLanguage(fullPath)) {
          files.push(fullPath);
        }
      }
    }
  };

  walk(dirPath);

  const indexedSymbolIds = new Set<string>();
  for (const file of files) {
    const result = await indexFile(db, file, repoPath, teamId);
    results.push(result);
  }

  // Collect symbol IDs from the just-indexed files — resolveAllCalls will only
  // resolve calls whose caller_id is in this set, avoiding re-processing 25K+
  // historical calls (fuzzy strategy is O(n²)).
  if (results.length > 0) {
    const indexedFiles = results.filter((r) => !r.skipped).map((r) => r.file);
    for (let i = 0; i < indexedFiles.length; i += 500) {
      const chunk = indexedFiles.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT id FROM symbols WHERE file_path IN (${placeholders})`)
        .all(...chunk) as { id: string }[];
      for (const r of rows) {
        indexedSymbolIds.add(r.id);
      }
    }
  }

  // Resolve callee IDs using 6-strategy cascade (import-map, same-module, unique-name, suffix, fuzzy)
  // Adapted from Codebase-Memory (arXiv:2603.27277)
  const { resolveAllCalls } = await import("./resolver.js");
  const stats = resolveAllCalls(db, indexedSymbolIds);
  if (stats.total > 0) {
    console.error(
      `[remem-mcp] indexDirectory: resolved ${stats.resolved}/${stats.total} calls` +
        (Object.keys(stats.byStrategy).length > 0 ? ` (${JSON.stringify(stats.byStrategy)})` : ""),
    );
  }

  return results;
}

/** Search symbols by name or pattern. */
export function searchSymbols(
  db: Database,
  query: string,
  opts: {
    teamId?: string;
    kind?: string;
    language?: string;
    limit?: number;
    repoPath?: string;
  } = {},
): SymbolInfo[] {
  const limit = opts.limit ?? 20;
  const pattern = `%${query}%`;
  let sql = "SELECT * FROM symbols WHERE name LIKE ?";
  const params: unknown[] = [pattern];
  if (opts.teamId !== undefined) {
    sql += " AND team_id IS ?";
    params.push(opts.teamId);
  }
  if (opts.repoPath !== undefined) {
    // Use LIKE prefix match so /path/to/src also matches repo_path /path/to
    sql += " AND (repo_path = ? OR repo_path LIKE ?)";
    params.push(opts.repoPath, `${opts.repoPath}%`);
  }
  if (opts.kind) {
    sql += " AND kind = ?";
    params.push(opts.kind);
  }
  if (opts.language) {
    sql += " AND language = ?";
    params.push(opts.language);
  }
  sql += " LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    name: string;
    kind: string;
    file_path: string;
    line_start: number;
    line_end: number;
    language: string;
    signature: string | null;
    docstring: string | null;
    parent_id: string | null;
    content_hash: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    language: r.language,
    signature: r.signature,
    docstring: r.docstring,
    parentId: r.parent_id,
    contentHash: r.content_hash,
  }));
}

/** Find all callers of a symbol (who calls X?). */
export function findCallers(
  db: Database,
  symbolId: string,
  opts: { limit?: number } = {},
): Array<{ caller: SymbolInfo; line: number }> {
  const limit = opts.limit ?? 50;
  const rows = db
    .prepare(
      `SELECT s.*, c.line as call_line
       FROM calls c
       JOIN symbols s ON s.id = c.caller_id
       WHERE c.callee_id = ? OR c.callee_name = (SELECT name FROM symbols WHERE id = ?)
       LIMIT ?`,
    )
    .all(symbolId, symbolId, limit) as Array<{
    id: string;
    name: string;
    kind: string;
    file_path: string;
    line_start: number;
    line_end: number;
    language: string;
    signature: string | null;
    docstring: string | null;
    parent_id: string | null;
    content_hash: string;
    call_line: number;
  }>;

  return rows.map((r) => ({
    caller: {
      id: r.id,
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      language: r.language,
      signature: r.signature,
      docstring: r.docstring,
      parentId: r.parent_id,
      contentHash: r.content_hash,
    },
    line: r.call_line,
  }));
}

/** Find all callees of a symbol (X calls whom?). */
export function findCallees(
  db: Database,
  symbolId: string,
  opts: { limit?: number } = {},
): Array<{ callee: SymbolInfo | null; calleeName: string; line: number }> {
  const limit = opts.limit ?? 50;
  const rows = db
    .prepare(
      `SELECT c.callee_name, c.callee_id, c.line,
              s.id as sid, s.name as sname, s.kind as skind, s.file_path as sfile,
              s.line_start as sline_start, s.line_end as sline_end, s.language as slang,
              s.signature as ssig, s.docstring as sdoc, s.parent_id as sparent, s.content_hash as shash
       FROM calls c
       LEFT JOIN symbols s ON s.id = c.callee_id
       WHERE c.caller_id = ?
       LIMIT ?`,
    )
    .all(symbolId, limit) as Array<{
    callee_name: string;
    callee_id: string | null;
    line: number;
    sid: string | null;
    sname: string | null;
    skind: string | null;
    sfile: string | null;
    sline_start: number | null;
    sline_end: number | null;
    slang: string | null;
    ssig: string | null;
    sdoc: string | null;
    sparent: string | null;
    shash: string | null;
  }>;

  return rows.map((r) => ({
    callee: r.sid
      ? {
          id: r.sid,
          name: r.sname ?? "",
          kind: r.skind ?? "",
          filePath: r.sfile ?? "",
          lineStart: r.sline_start ?? 0,
          lineEnd: r.sline_end ?? 0,
          language: r.slang ?? "",
          signature: r.ssig,
          docstring: r.sdoc,
          parentId: r.sparent,
          contentHash: r.shash ?? "",
        }
      : null,
    calleeName: r.callee_name,
    line: r.line,
  }));
}

/** Impact analysis: BFS from a symbol through the caller chain.
 *  Returns all symbols that might be affected if the given symbol changes. */
export function impactAnalysis(
  db: Database,
  symbolId: string,
  opts: { maxDepth?: number } = {},
): ImpactResult {
  const maxDepth = opts.maxDepth ?? 5;

  const rootRow = db.prepare("SELECT * FROM symbols WHERE id = ?").get(symbolId) as
    | {
        id: string;
        name: string;
        kind: string;
        file_path: string;
        line_start: number;
        line_end: number;
        language: string;
        signature: string | null;
        docstring: string | null;
        parent_id: string | null;
        content_hash: string;
      }
    | undefined;

  if (!rootRow) {
    throw new Error(`Symbol not found: ${symbolId}`);
  }

  const root: SymbolInfo = {
    id: rootRow.id,
    name: rootRow.name,
    kind: rootRow.kind,
    filePath: rootRow.file_path,
    lineStart: rootRow.line_start,
    lineEnd: rootRow.line_end,
    language: rootRow.language,
    signature: rootRow.signature,
    docstring: rootRow.docstring,
    parentId: rootRow.parent_id,
    contentHash: rootRow.content_hash,
  };

  const affected: Array<{ symbol: SymbolInfo; depth: number; path: string[] }> = [];
  const visited = new Set<string>([symbolId]);

  // BFS through callers (who calls X → who calls them → ...)
  const queue: Array<{ id: string; depth: number; path: string[] }> = [
    { id: symbolId, depth: 0, path: [root.name] },
  ];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;
    const { id, depth, path } = item;
    if (depth >= maxDepth) continue;

    const callers = findCallers(db, id, { limit: 100 });
    for (const { caller } of callers) {
      if (visited.has(caller.id)) continue;
      visited.add(caller.id);
      const newPath = [...path, caller.name];
      affected.push({ symbol: caller, depth: depth + 1, path: newPath });
      queue.push({ id: caller.id, depth: depth + 1, path: newPath });
    }
  }

  return { rootSymbol: root, affected };
}

/** List symbols in a file or directory. */
export function listSymbols(
  db: Database,
  filePath: string,
  opts: { teamId?: string; kind?: string; limit?: number; repoPath?: string } = {},
): SymbolInfo[] {
  const limit = opts.limit ?? 100;

  // Convert absolute path to relative if repoPath is provided
  let relPath = filePath;
  if (opts.repoPath) {
    try {
      relPath = relative(opts.repoPath, filePath).split(sep).join("/");
    } catch {
      // If relative() fails, use the original path
    }
  }

  let sql = "SELECT * FROM symbols WHERE file_path LIKE ?";
  const params: unknown[] = [`${relPath}%`];
  if (opts.teamId !== undefined) {
    sql += " AND team_id IS ?";
    params.push(opts.teamId);
  }
  if (opts.repoPath !== undefined) {
    // Use LIKE prefix match so /path/to/src also matches repo_path /path/to
    sql += " AND (repo_path = ? OR repo_path LIKE ?)";
    params.push(opts.repoPath, `${opts.repoPath}%`);
  }
  if (opts.kind) {
    sql += " AND kind = ?";
    params.push(opts.kind);
  }
  sql += " ORDER BY line_start LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    name: string;
    kind: string;
    file_path: string;
    line_start: number;
    line_end: number;
    language: string;
    signature: string | null;
    docstring: string | null;
    parent_id: string | null;
    content_hash: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    language: r.language,
    signature: r.signature,
    docstring: r.docstring,
    parentId: r.parent_id,
    contentHash: r.content_hash,
  }));
}
