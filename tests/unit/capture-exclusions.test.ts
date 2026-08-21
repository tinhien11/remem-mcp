import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Import the exported functions. We need to import from the source directly
// since the functions are exported from hook-handlers.ts.
// Note: loadCaptureExclusions uses a module-level cache, so each test must
// use a unique temp directory to avoid cache hits from prior tests.
import {
  loadCaptureExclusions,
  shouldExcludePath,
  shouldExcludeCommand,
} from "../../src/hook-handlers.js";

describe("capture exclusions", () => {
  let tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "remem-excl-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    tmpDirs = [];
  });

  describe("parseCaptureExclusions (via loadCaptureExclusions)", () => {
    it("loads ignore_paths from .remem.toml", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, ".remem.toml"),
        `[capture]
ignore_paths = ["node_modules", "dist", ".git"]
`,
      );
      const patterns = loadCaptureExclusions(dir);
      expect(patterns).toEqual(["node_modules", "dist", ".git"]);
    });

    it("returns empty array when no .remem.toml exists", () => {
      const dir = makeTmpDir();
      const patterns = loadCaptureExclusions(dir);
      expect(patterns).toEqual([]);
    });

    it("returns empty array when [capture] section is missing", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, ".remem.toml"),
        `[other]
key = "value"
`,
      );
      const patterns = loadCaptureExclusions(dir);
      expect(patterns).toEqual([]);
    });

    it("returns empty array when ignore_paths is missing in [capture]", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, ".remem.toml"),
        `[capture]
other_key = "value"
`,
      );
      const patterns = loadCaptureExclusions(dir);
      expect(patterns).toEqual([]);
    });

    it("walks up ancestors to find .remem.toml", () => {
      const root = makeTmpDir();
      writeFileSync(
        join(root, ".remem.toml"),
        `[capture]
ignore_paths = ["build", "vendor"]
`,
      );
      const subdir = join(root, "packages", "api", "src");
      mkdirSync(subdir, { recursive: true });
      const patterns = loadCaptureExclusions(subdir);
      expect(patterns).toEqual(["build", "vendor"]);
    });

    it("stops at first .remem.toml found (nearest ancestor wins)", () => {
      const root = makeTmpDir();
      writeFileSync(
        join(root, ".remem.toml"),
        `[capture]
ignore_paths = ["outer"]
`,
      );
      const mid = join(root, "packages");
      mkdirSync(mid, { recursive: true });
      writeFileSync(
        join(mid, ".remem.toml"),
        `[capture]
ignore_paths = ["inner"]
`,
      );
      const subdir = join(mid, "api", "src");
      mkdirSync(subdir, { recursive: true });
      const patterns = loadCaptureExclusions(subdir);
      expect(patterns).toEqual(["inner"]);
    });

    it("handles glob suffix patterns", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, ".remem.toml"),
        `[capture]
ignore_paths = ["*.min.js", "*.generated.ts"]
`,
      );
      const patterns = loadCaptureExclusions(dir);
      expect(patterns).toEqual(["*.min.js", "*.generated.ts"]);
    });

    it("handles empty ignore_paths array", () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, ".remem.toml"),
        `[capture]
ignore_paths = []
`,
      );
      const patterns = loadCaptureExclusions(dir);
      expect(patterns).toEqual([]);
    });
  });

  describe("shouldExcludePath", () => {
    it("matches path segment", () => {
      expect(shouldExcludePath("/project/node_modules/foo.js", ["node_modules"])).toBe(true);
      expect(shouldExcludePath("/project/src/node_modules/foo.js", ["node_modules"])).toBe(true);
    });

    it("does not match partial segment", () => {
      expect(shouldExcludePath("/project/my_node_modules/foo.js", ["node_modules"])).toBe(false);
    });

    it("matches glob suffix", () => {
      expect(shouldExcludePath("/project/bundle.min.js", ["*.min.js"])).toBe(true);
      expect(shouldExcludePath("/project/app.js", ["*.min.js"])).toBe(false);
    });

    it("returns false for empty patterns", () => {
      expect(shouldExcludePath("/project/foo.js", [])).toBe(false);
    });

    it("handles Windows-style paths", () => {
      expect(shouldExcludePath("C:\\project\\node_modules\\foo.js", ["node_modules"])).toBe(true);
    });

    it("matches multiple patterns", () => {
      expect(
        shouldExcludePath("/project/dist/bundle.js", ["node_modules", "dist", ".git"]),
      ).toBe(true);
      expect(shouldExcludePath("/project/src/main.ts", ["node_modules", "dist", ".git"])).toBe(
        false,
      );
    });
  });

  describe("shouldExcludeCommand", () => {
    it("matches path segment in command", () => {
      expect(shouldExcludeCommand("cat node_modules/foo.js", ["node_modules"])).toBe(true);
      expect(shouldExcludeCommand("ls ./node_modules", ["node_modules"])).toBe(true);
    });

    it("does not match partial segment in command", () => {
      expect(shouldExcludeCommand("cat my_node_modules/foo.js", ["node_modules"])).toBe(false);
    });

    it("matches command with path prefix", () => {
      expect(shouldExcludeCommand("ls dist/", ["dist"])).toBe(true);
      expect(shouldExcludeCommand("cp dist/bundle.js /tmp/", ["dist"])).toBe(true);
    });

    it("skips glob patterns for command matching", () => {
      // Glob patterns like *.min.js are not checked in commands
      expect(shouldExcludeCommand("cat bundle.min.js", ["*.min.js"])).toBe(false);
    });

    it("returns false for empty patterns", () => {
      expect(shouldExcludeCommand("cat node_modules/foo.js", [])).toBe(false);
    });

    it("does not match when pattern is part of a word", () => {
      expect(shouldExcludeCommand("echo distributing files", ["dist"])).toBe(false);
    });

    it("matches pattern at start of command", () => {
      expect(shouldExcludeCommand("dist/build.sh", ["dist"])).toBe(true);
    });
  });
});
