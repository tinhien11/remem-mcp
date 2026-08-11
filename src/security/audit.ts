import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Audit log entry. */
export interface AuditEntry {
  ts: number;
  tool: string;
  argsHash: string;
  resultLen: number | null;
  quotaHit: boolean;
  redacted: boolean;
  /** For mutation tools (forget): records what was changed. */
  mutation?: { id?: string; filter?: unknown; captures: number };
}

/** Append-only JSONL audit logger. */
export class AuditLogger {
  private logPath: string;
  private enabled: boolean;

  constructor(logPath: string, enabled: boolean) {
    this.logPath = logPath;
    this.enabled = enabled;
    if (enabled) {
      const dir = dirname(logPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  /** Log a tool call. */
  log(entry: Omit<AuditEntry, "ts">): void {
    if (!this.enabled) return;

    const fullEntry: AuditEntry = {
      ts: Date.now(),
      ...entry,
    };

    const line = JSON.stringify(fullEntry);
    try {
      appendFileSync(this.logPath, `${line}\n`);
    } catch (err) {
      // The audit log must not crash the server
      console.error(`[tdai-memory] Audit log write failed: ${err}`);
    }
  }

  /** Hash the arguments for the audit log. The log does not store raw arguments. */
  static hashArgs(args: unknown): string {
    const json = JSON.stringify(args);
    return createHash("sha256").update(json).digest("hex");
  }
}
