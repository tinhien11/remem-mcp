import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StorageBackend, CaptureType, CaptureEntry } from "../storage/types.js";
import type { Embedder } from "../embedding/types.js";
import type { AuditLogger } from "../security/audit.js";
import type { PipelineStage, PipelineContext } from "../pipeline/types.js";
import { redact } from "../security/redactor.js";
import { checkContentLength } from "../security/quota.js";
import { generateId } from "../utils/ulid.js";
import { createHash } from "node:crypto";

/** Default session key: hash of the current working directory. */
function defaultSessionKey(): string {
  const cwd = process.cwd();
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** Detect the agent ID from environment variables. */
function detectAgentId(): string {
  // Devin CLI sets DEVIN_SESSION_ID
  if (process.env.DEVIN_SESSION_ID) return "devin";
  // Claude Code sets CLAUDE_* or is detectable by the absence of other vars
  if (process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  // Cursor
  if (process.env.CURSOR_DEBUG) return "cursor";
  // Default
  return "unknown";
}

/** Register the capture tool on the MCP server. */
export function registerCapture(
  server: Server,
  storage: StorageBackend,
  embedder: Embedder,
  audit: AuditLogger,
  pipeline: PipelineStage,
  pipelineCtx: Omit<PipelineContext, "sessionKey">,
  redactEnabled: boolean,
  maxContentLength: number,
): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "capture") return null;

    const args = request.params.arguments as {
      content: string;
      type: CaptureType;
      tags?: string[];
      session_key?: string;
      metadata?: Record<string, unknown>;
    };

    // Check the content length
    if (!checkContentLength(args.content, maxContentLength)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: The content exceeds the maximum length of ${maxContentLength} characters.`,
          },
        ],
        isError: true,
      };
    }

    // Redact secrets
    const { text: redactedContent, redacted: wasRedacted } = redactEnabled
      ? redact(args.content)
      : { text: args.content, redacted: false };

    // Create the capture entry
    const id = generateId();
    const sessionKey = args.session_key ?? defaultSessionKey();
    const agentId = detectAgentId();

    const entry: CaptureEntry = {
      id,
      sessionKey,
      agentId,
      type: args.type,
      content: redactedContent,
      tags: args.tags ?? [],
      createdAt: Date.now(),
      metadata: args.metadata,
    };

    // Store the capture (L0)
    await storage.put(entry);

    // Generate and store the embedding
    try {
      const embedding = await embedder.embed(redactedContent);
      await storage.putVector(id, embedding);
    } catch (err) {
      // If the embedding fails, the capture is still stored. The search will use BM25 only.
      console.error(`[tdai-memory] Embedding failed: ${err}`);
    }

    // Run the pipeline (if not noop)
    if (pipeline.name !== "noop") {
      try {
        await pipeline.process(
          { id, content: redactedContent, type: args.type, tags: args.tags ?? [], sessionKey },
          { ...pipelineCtx, sessionKey },
        );
      } catch (err) {
        // The pipeline must not fail the capture
        console.error(`[tdai-memory] Pipeline failed: ${err}`);
      }
    }

    // Log the audit entry
    audit.log({
      tool: "capture",
      argsHash: AuditLogger.hashArgs({ type: args.type, tags: args.tags, sessionKey }),
      resultLen: id.length,
      quotaHit: false,
      redacted: wasRedacted,
    });

    const redactionNote = wasRedacted ? " (secrets were redacted)" : "";
    return {
      content: [{ type: "text", text: `Captured: ${id}${redactionNote}` }],
    };
  });
}
