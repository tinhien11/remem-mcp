/**
 * Context offloading — writes raw tool output to refs/*.md files.
 *
 * Adapted from TencentDB Agent Memory's context offloading concept (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 *
 * The bottom layer of the 3-layer short-term memory:
 *   bottom = raw tool output → refs/{sessionKey}/{nodeId}.md
 *   middle = step summaries (stored in canvas nodes)
 *   top    = Mermaid graph (kept in context, ~hundreds of tokens)
 *
 * The agent reasons over the Mermaid graph. To drill down to raw output,
 * it calls ref_read(node_id) which reads the corresponding refs/*.md file.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default refs directory. */
function defaultRefsDir(): string {
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) return join(xdgData, "remem-mcp", "refs");
  return join(homedir(), ".local", "share", "remem-mcp", "refs");
}

/** Get the refs directory, respecting REMEM_REFS_DIR override. */
export function getRefsDir(): string {
  return process.env.REMEM_REFS_DIR ?? defaultRefsDir();
}

/** Get the refs directory for a specific session. */
function getSessionRefsDir(sessionKey: string): string {
  return join(getRefsDir(), sessionKey);
}

/** Sanitize a session key for use as a directory name. */
function sanitizeSessionKey(sessionKey: string): string {
  // Remove any path separators or dangerous characters
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Sanitize a node ID for use as a filename. */
function sanitizeNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Write raw content to a ref file.
 * Path: refs/{sessionKey}/{nodeId}.md
 *
 * @returns The absolute path to the written file.
 */
export function writeRef(sessionKey: string, nodeId: string, content: string): string {
  const dir = getSessionRefsDir(sanitizeSessionKey(sessionKey));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${sanitizeNodeId(nodeId)}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Read raw content from a ref file.
 *
 * @returns The raw content, or null if the file doesn't exist.
 */
export function readRef(sessionKey: string, nodeId: string): string | null {
  const filePath = join(getSessionRefsDir(sanitizeSessionKey(sessionKey)), `${sanitizeNodeId(nodeId)}.md`);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

/**
 * Read a ref file by node ID, searching across all sessions.
 * Used when the agent only has the node_id (not the session_key).
 *
 * @returns The raw content and session key, or null if not found.
 */
export function readRefByNodeId(nodeId: string): { content: string; sessionKey: string } | null {
  const refsDir = getRefsDir();
  if (!existsSync(refsDir)) return null;

  const sanitizedNodeId = sanitizeNodeId(nodeId);
  const sessionDirs = readdirSync(refsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const sessionDir of sessionDirs) {
    const filePath = join(refsDir, sessionDir, `${sanitizedNodeId}.md`);
    if (existsSync(filePath)) {
      return {
        content: readFileSync(filePath, "utf-8"),
        sessionKey: sessionDir,
      };
    }
  }

  return null;
}

/**
 * List all refs for a session.
 *
 * @returns Array of { nodeId, filePath, sizeBytes }.
 */
export function listRefs(sessionKey: string): Array<{ nodeId: string; filePath: string; sizeBytes: number }> {
  const dir = getSessionRefsDir(sanitizeSessionKey(sessionKey));
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const filePath = join(dir, f);
      const nodeId = f.replace(/\.md$/, "");
      const stat = statSync(filePath);
      return { nodeId, filePath, sizeBytes: stat.size };
    });
}

/**
 * Delete all refs for a session.
 * Called on session end (configurable via REMEM_REFS_RETENTION_HOURS).
 *
 * @returns Number of files deleted.
 */
export function clearSessionRefs(sessionKey: string): number {
  const dir = getSessionRefsDir(sanitizeSessionKey(sessionKey));
  if (!existsSync(dir)) return 0;

  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  rmSync(dir, { recursive: true, force: true });
  return files.length;
}

/**
 * Clean up old refs based on retention policy.
 * Files older than REMEM_REFS_RETENTION_HOURS (default: 24) are deleted.
 *
 * @returns Number of files deleted.
 */
export function cleanupOldRefs(): number {
  const retentionHours = Number.parseInt(process.env.REMEM_REFS_RETENTION_HOURS ?? "24", 10);
  if (retentionHours <= 0) return 0; // 0 = never cleanup

  const refsDir = getRefsDir();
  if (!existsSync(refsDir)) return 0;

  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  let deleted = 0;

  const sessionDirs = readdirSync(refsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const sessionDir of sessionDirs) {
    const sessionPath = join(refsDir, sessionDir);
    const files = readdirSync(sessionPath).filter((f) => f.endsWith(".md"));

    let allOld = true;
    for (const file of files) {
      const filePath = join(sessionPath, file);
      const stat = statSync(filePath);
      if (stat.mtimeMs >= cutoff) {
        allOld = false;
      } else {
        // Delete individual old file
        rmSync(filePath, { force: true });
        deleted++;
      }
    }

    // If all files were old, remove the empty session directory
    if (allOld && readdirSync(sessionPath).length === 0) {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  return deleted;
}

/**
 * Get the total size of all refs for a session.
 */
export function getSessionRefsSize(sessionKey: string): number {
  const refs = listRefs(sessionKey);
  return refs.reduce((sum, r) => sum + r.sizeBytes, 0);
}
