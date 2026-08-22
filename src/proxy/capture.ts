/**
 * Auto-capture — captures conversations after the upstream LLM responds.
 *
 * Reuses the same capture logic as the session transcript capture in hook-handlers.ts.
 */

import { generateId } from "../utils/ulid.js";
import type { SQLiteBackend } from "../storage/sqlite.js";

interface SessionBinding {
  teamId?: string;
  agentId?: string;
  userId?: string;
  taskId?: string;
}

interface Message {
  role: string;
  content: string;
}

/**
 * Capture an OpenAI-format conversation (user messages + assistant response).
 */
export async function captureConversation(
  messages: Message[],
  assistantResponse: string,
  storage: SQLiteBackend,
  binding: SessionBinding,
): Promise<void> {
  // Build a conversation summary
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) return;

  const lastUser = userMessages[userMessages.length - 1];
  const content = `User: ${lastUser.content.slice(0, 500)}\n\nAssistant: ${assistantResponse.slice(0, 2000)}`;

  const id = generateId();
  const now = Date.now();

  await storage.put({
    id,
    sessionKey: `proxy-${binding.teamId ?? "default"}`,
    agentId: binding.agentId ?? "proxy",
    type: "conversation",
    content,
    contentHash: null,
    tags: JSON.stringify(["proxy", "conversation"]),
    createdAt: now,
    metadata: JSON.stringify({
      source: "proxy",
      teamId: binding.teamId,
      agentId: binding.agentId,
      userId: binding.userId,
      taskId: binding.taskId,
    }),
    teamId: binding.teamId,
    userId: binding.userId,
    taskId: binding.taskId,
  });
}

/**
 * Capture an Anthropic-format conversation.
 */
export async function captureConversationAnthropic(
  messages: Array<{ role: string; content: unknown }>,
  assistantResponse: string,
  storage: SQLiteBackend,
  binding: SessionBinding,
): Promise<void> {
  // Convert Anthropic format to simple messages
  const simpleMessages: Message[] = messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content
            .filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
            .map((b: { text: string }) => b.text)
            .join("\n")
        : "",
  }));

  await captureConversation(simpleMessages, assistantResponse, storage, binding);
}
