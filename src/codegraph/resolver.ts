/**
 * Call resolver: 6-strategy cascade for resolving callee names to symbol IDs.
 *
 * Adapted from Codebase-Memory (arXiv:2603.27277, MIT, DeusData 2026).
 * https://github.com/DeusData/codebase-memory-mcp
 *
 * Strategies (in priority order):
 * 1. Import map (0.95): Split callee into prefix.suffix; look up prefix in file's import map
 * 2. Import map suffix (0.85): Suffix-based matching against import-resolved module paths
 * 3. Same module (0.90): Prefix callee with enclosing file's module path
 * 4. Unique name (0.75): Simple name lookup, accept if exactly 1 candidate
 * 5. Suffix match (0.55): Multiple candidates, select by suffix + import-distance
 * 6. Fuzzy (0.30-0.40): String similarity — last resort
 */

import type { Database } from "better-sqlite3";

export interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  module_path: string | null;
  language: string;
  parent_id: string | null;
}

export interface CallRow {
  id: number;
  caller_id: string;
  callee_name: string;
  callee_id: string | null;
  line: number;
  call_type: string;
}

export interface ImportRow {
  file_path: string;
  symbol_name: string;
  source_path: string | null;
}

export interface ResolutionResult {
  calleeId: string | null;
  confidence: number;
  strategy: string;
}

/**
 * FunctionRegistry indexes all symbol definitions by:
 * - qualified name (exact map): "module_path/SymbolName" → SymbolRow
 * - simple name (reverse index): "SymbolName" → SymbolRow[]
 */
export class FunctionRegistry {
  private exactMap = new Map<string, SymbolRow>();
  private reverseIndex = new Map<string, SymbolRow[]>();
  private fileModules = new Map<string, string>(); // file_path → module_path

  constructor(symbols: SymbolRow[]) {
    for (const sym of symbols) {
      // Build module_path from file_path if not set
      const modulePath = sym.module_path ?? deriveModulePath(sym.file_path);
      this.fileModules.set(sym.file_path, modulePath);

      // Exact map: module_path/name
      const qualifiedName = `${modulePath}/${sym.name}`;
      this.exactMap.set(qualifiedName, sym);
      // Also index by file_path/name for same-file resolution
      this.exactMap.set(`${sym.file_path}/${sym.name}`, sym);

      // Reverse index: simple name → all matching symbols
      const existing = this.reverseIndex.get(sym.name);
      if (existing) {
        existing.push(sym);
      } else {
        this.reverseIndex.set(sym.name, [sym]);
      }
    }
  }

  /** Look up by qualified name (module_path/name). */
  exactLookup(qualifiedName: string): SymbolRow | undefined {
    return this.exactMap.get(qualifiedName);
  }

  /** Look up by simple name — returns all candidates. */
  reverseLookup(simpleName: string): SymbolRow[] {
    return this.reverseIndex.get(simpleName) ?? [];
  }

  /** Get all reverse index entries (for fuzzy lookup). */
  reverseLookupEntries(): IterableIterator<[string, SymbolRow[]]> {
    return this.reverseIndex.entries();
  }

  /** Get module_path for a file. */
  getModuleForFile(filePath: string): string {
    return this.fileModules.get(filePath) ?? deriveModulePath(filePath);
  }
}

/**
 * ImportMap tracks what each file imports: { prefix → module_path }.
 * Built from the imports table.
 */
export class ImportMap {
  private fileImports = new Map<string, Map<string, string>>();

  constructor(imports: ImportRow[]) {
    for (const imp of imports) {
      if (!imp.source_path) continue;
      let fileMap = this.fileImports.get(imp.file_path);
      if (!fileMap) {
        fileMap = new Map();
        this.fileImports.set(imp.file_path, fileMap);
      }
      // Map: symbol_name (or prefix) → source module_path
      const prefix = imp.symbol_name.split(".")[0] ?? imp.symbol_name;
      const modulePath = deriveModulePath(imp.source_path);
      fileMap.set(prefix, modulePath);
      fileMap.set(imp.symbol_name, modulePath);
    }
  }

  /** Look up module path for an import prefix in a given file. */
  lookup(filePath: string, prefix: string): string | undefined {
    return this.fileImports.get(filePath)?.get(prefix);
  }

  /** Get all imports for a file. */
  getImportsForFile(filePath: string): Map<string, string> | undefined {
    return this.fileImports.get(filePath);
  }
}

/**
 * Resolve a callee name to a symbol ID using the 6-strategy cascade.
 * Returns { calleeId, confidence, strategy } or { calleeId: null, confidence: 0, strategy: "unresolved" }.
 */
export function resolveCall(
  calleeName: string,
  callerFilePath: string,
  registry: FunctionRegistry,
  importMap: ImportMap,
): ResolutionResult {
  // Strategy 1: Import map (0.95)
  // Split callee into prefix.suffix; look up prefix in file's import map
  const parts = calleeName.split(".");
  if (parts.length >= 2) {
    const prefix = parts[0];
    const suffix = parts.slice(1).join(".");
    const modulePath = importMap.lookup(callerFilePath, prefix);
    if (modulePath) {
      const qualifiedName = `${modulePath}/${suffix}`;
      const sym = registry.exactLookup(qualifiedName);
      if (sym) {
        return { calleeId: sym.id, confidence: 0.95, strategy: "import-map" };
      }
      // Also try full callee name in the resolved module
      const fullQualified = `${modulePath}/${calleeName}`;
      const symFull = registry.exactLookup(fullQualified);
      if (symFull) {
        return { calleeId: symFull.id, confidence: 0.95, strategy: "import-map" };
      }
    }
  }

  // Strategy 2: Import map suffix (0.85)
  // Try suffix-based matching against import-resolved module paths
  if (parts.length >= 2) {
    const prefix = parts[0];
    const suffix = parts[parts.length - 1];
    const modulePath = importMap.lookup(callerFilePath, prefix);
    if (modulePath) {
      const candidates = registry.reverseLookup(suffix);
      for (const c of candidates) {
        const cModule = registry.getModuleForFile(c.file_path);
        if (cModule === modulePath || cModule.endsWith(`/${modulePath}`)) {
          return { calleeId: c.id, confidence: 0.85, strategy: "import-map-suffix" };
        }
      }
    }
  }

  // Strategy 3: Same module (0.90)
  // Prefix callee with enclosing file's module path
  const callerModule = registry.getModuleForFile(callerFilePath);
  const sameModuleQualified = `${callerModule}/${calleeName}`;
  const symSame = registry.exactLookup(sameModuleQualified);
  if (symSame) {
    return { calleeId: symSame.id, confidence: 0.9, strategy: "same-module" };
  }
  // Also try just the simple name in same module
  const sameModuleSimple = registry
    .reverseLookup(calleeName)
    .find((s) => registry.getModuleForFile(s.file_path) === callerModule);
  if (sameModuleSimple) {
    return { calleeId: sameModuleSimple.id, confidence: 0.9, strategy: "same-module" };
  }

  // Strategy 4: Unique name (0.75)
  // Simple name lookup, accept if exactly 1 candidate project-wide
  const candidates = registry.reverseLookup(calleeName);
  if (candidates.length === 1) {
    return { calleeId: candidates[0].id, confidence: 0.75, strategy: "unique-name" };
  }

  // Strategy 5: Suffix match (0.55)
  // Multiple candidates, select by suffix match with import-distance scoring
  if (candidates.length > 1) {
    // Prefer candidates in modules reachable from this file's imports
    const fileImports = importMap.getImportsForFile(callerFilePath);
    if (fileImports) {
      for (const c of candidates) {
        const cModule = registry.getModuleForFile(c.file_path);
        for (const [, impModule] of fileImports) {
          if (cModule === impModule || cModule.startsWith(`${impModule}/`)) {
            return { calleeId: c.id, confidence: 0.55, strategy: "suffix-match" };
          }
        }
      }
    }
    // Fallback: pick first candidate (nearest by file path similarity)
    const callerDir = callerFilePath.slice(0, callerFilePath.lastIndexOf("/"));
    let best = candidates[0];
    let bestDist = Infinity;
    for (const c of candidates) {
      const cDir = c.file_path.slice(0, c.file_path.lastIndexOf("/"));
      const dist = pathDistance(callerDir, cDir);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    return { calleeId: best.id, confidence: 0.55, strategy: "suffix-match" };
  }

  // Strategy 6: Fuzzy (0.30-0.40)
  // String similarity — last resort
  const fuzzyMatch = fuzzyLookup(calleeName, registry);
  if (fuzzyMatch) {
    return { calleeId: fuzzyMatch.id, confidence: 0.35, strategy: "fuzzy" };
  }

  return { calleeId: null, confidence: 0, strategy: "unresolved" };
}

/** Names too short or builtin to bother resolving. */
const SKIP_NAMES = new Set([
  "T",
  "L",
  "R",
  "S",
  "P",
  "C",
  "D",
  "E",
  "F",
  "M",
  "N",
  "V",
  "X",
  "Y",
  "String",
  "Array",
  "Object",
  "Number",
  "Boolean",
  "Map",
  "Set",
  "Date",
  "Error",
  "RegExp",
  "Promise",
  "Symbol",
  "Buffer",
  "Vec",
  "Box",
  "Option",
  "Result",
  "Some",
  "None",
  "Ok",
  "Err",
  "List",
  "Dict",
  "Tuple",
]);

/** Check if a callee name should be skipped (too short or builtin type). */
function shouldSkipResolution(calleeName: string): boolean {
  if (calleeName.length <= 2) return true;
  if (SKIP_NAMES.has(calleeName)) return true;
  // Skip single-letter + dot patterns like "T.foo"
  const parts = calleeName.split(".");
  if (parts.length >= 2 && parts[0].length <= 1) return true;
  return false;
}

/**
 * Run call resolution on unresolved calls in the database.
 * Called after indexDirectory() completes.
 *
 * If callerIds is provided, only resolve calls whose caller_id is in the set
 * (i.e., calls from the just-indexed batch). This avoids re-resolving 25K+
 * historical calls on every index run — the O(n²) fuzzy strategy would hang.
 * If callerIds is omitted, resolve all unresolved calls (legacy behavior).
 */
export function resolveAllCalls(
  db: Database,
  callerIds?: Set<string>,
): {
  total: number;
  resolved: number;
  byStrategy: Record<string, number>;
} {
  // Create index for faster lookups (idempotent)
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_calls_callee_name ON calls(callee_name)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_symbols_module ON symbols(module_path)");
  } catch {}

  // Load all symbols into FunctionRegistry
  const symbols = db
    .prepare("SELECT id, name, kind, file_path, module_path, language, parent_id FROM symbols")
    .all() as SymbolRow[];
  const registry = new FunctionRegistry(symbols);

  // Load all imports into ImportMap
  const imports = db
    .prepare("SELECT file_path, symbol_name, source_path FROM imports")
    .all() as ImportRow[];
  const importMap = new ImportMap(imports);

  // Get unresolved calls — skip short/builtin names to save resolution time.
  // If callerIds is provided, only resolve calls from the just-indexed batch
  // (avoids re-resolving 25K+ historical calls — fuzzy is O(n²)).
  let calls: CallRow[];
  if (callerIds && callerIds.size > 0) {
    const idList = [...callerIds];
    calls = [];
    // Batch in chunks of 500 to avoid SQLite param limit
    for (let i = 0; i < idList.length; i += 500) {
      const chunk = idList.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT id, caller_id, callee_name, callee_id, line, call_type FROM calls WHERE callee_id IS NULL AND caller_id IN (${placeholders})`,
        )
        .all(...chunk) as CallRow[];
      calls.push(...rows);
    }
  } else {
    calls = db
      .prepare(
        "SELECT id, caller_id, callee_name, callee_id, line, call_type FROM calls WHERE callee_id IS NULL",
      )
      .all() as CallRow[];
  }

  const stats = { total: calls.length, resolved: 0, byStrategy: {} as Record<string, number> };
  let skipped = 0;

  // Get caller file paths — batch query
  const callerFiles = new Map<string, string>();
  const callerIdsFromCalls = [...new Set(calls.map((c) => c.caller_id))];
  if (callerIdsFromCalls.length > 0) {
    // Batch in chunks of 500 to avoid SQLite param limit
    for (let i = 0; i < callerIdsFromCalls.length; i += 500) {
      const chunk = callerIdsFromCalls.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT id, file_path FROM symbols WHERE id IN (${placeholders})`)
        .all(...chunk) as { id: string; file_path: string }[];
      for (const r of rows) {
        callerFiles.set(r.id, r.file_path);
      }
    }
  }

  // Resolve each call — skip short/builtin names
  const updateStmt = db.prepare("UPDATE calls SET callee_id = ?, confidence = ? WHERE id = ?");
  const batch = db.transaction(() => {
    for (const call of calls) {
      if (shouldSkipResolution(call.callee_name)) {
        skipped++;
        continue;
      }
      const callerFile = callerFiles.get(call.caller_id) ?? "";
      const result = resolveCall(call.callee_name, callerFile, registry, importMap);
      if (result.calleeId) {
        updateStmt.run(result.calleeId, result.confidence, call.id);
        stats.resolved++;
        stats.byStrategy[result.strategy] = (stats.byStrategy[result.strategy] ?? 0) + 1;
      }
    }
  });
  batch();

  if (skipped > 0) {
    console.error(`[remem-mcp] resolveAllCalls: skipped ${skipped} short/builtin names`);
  }

  return stats;
}

/** Derive a module path from a file path: "src/storage/sqlite.ts" → "src/storage/sqlite" */
function deriveModulePath(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|cc|cxx|hpp|cs)$/, "");
}

/** Calculate directory path distance for suffix-match scoring. */
function pathDistance(a: string, b: string): number {
  if (a === b) return 0;
  const aParts = a.split("/");
  const bParts = b.split("/");
  let common = 0;
  for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
    if (aParts[i] === bParts[i]) common++;
    else break;
  }
  return aParts.length + bParts.length - 2 * common;
}

/** Fuzzy lookup: find symbol with most similar name. */
function fuzzyLookup(name: string, registry: FunctionRegistry): SymbolRow | null {
  let best: SymbolRow | null = null;
  let bestScore = 0;
  for (const [symName, candidates] of registry.reverseLookupEntries()) {
    const score = similarity(name, symName);
    if (score > bestScore && score > 0.6) {
      bestScore = score;
      best = candidates[0];
    }
  }
  return best;
}

/** Simple string similarity (Jaccard on character bigrams). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  const intersection = aBigrams.filter((bg) => bBigrams.includes(bg)).length;
  const union = aBigrams.length + bBigrams.length - intersection;
  return union > 0 ? intersection / union : 0;
}

function bigrams(s: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    result.push(s.slice(i, i + 2));
  }
  return result;
}
