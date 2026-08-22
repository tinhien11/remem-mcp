/**
 * Session store — tracks team/agent/task bindings for proxy sessions.
 *
 * Adapted from TencentDB Agent Memory's sessionInit concept (MIT, Tencent 2026).
 * The proxy binds each session to a team/agent/task so memory queries are scoped.
 */

import { randomUUID } from "node:crypto";

interface SessionBinding {
  teamId?: string;
  agentId?: string;
  taskId?: string;
  userId?: string;
}

/**
 * In-memory session store.
 * For production, this should be persisted to Redis or SQLite.
 */
export class SessionStore {
  private sessions = new Map<string, SessionBinding>();

  /** Create a new session with the given binding. */
  create(binding: SessionBinding): string {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, binding);
    return sessionId;
  }

  /** Get the binding for a session. */
  get(sessionId: string): SessionBinding | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Get the binding from request headers (x-remem-session or x-tdai-user-key). */
  getFromHeaders(headers: Record<string, string | string[] | undefined>): SessionBinding {
    const sessionId = headers["x-remem-session"] as string | undefined;
    if (sessionId) {
      const binding = this.sessions.get(sessionId);
      if (binding) return binding;
    }

    // Fall back to header-based binding
    return {
      teamId: headers["x-remem-team"] as string | undefined,
      agentId: headers["x-remem-agent"] as string | undefined,
      taskId: headers["x-remem-task"] as string | undefined,
      userId: headers["x-remem-user"] as string | undefined,
    };
  }

  /** Delete a session. */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Clear all sessions. */
  clear(): void {
    this.sessions.clear();
  }
}
