import { LocalEmbedder } from "../embedding/local.js";
import { AtomPipeline } from "../pipeline/atom.js";
import { OpenAILLMClient } from "../pipeline/llm.js";
import type { PipelineContext } from "../pipeline/types.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import type { CaptureEntry } from "../storage/types.js";

/**
 * extract CLI command: run L1 atom extraction on existing captures.
 *
 * Usage:
 *   tdai-memory-mcp extract [--team-id <id>] [--limit <n>] [--capture-id <id>]
 *
 * Requires TDAI_LLM_API_KEY (or OPENAI_API_KEY) environment variable.
 */
export async function extractCommand(dbPath: string, flags: Record<string, string>): Promise<void> {
  const apiKey = process.env.TDAI_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: Set TDAI_LLM_API_KEY (or OPENAI_API_KEY) to run atom extraction.");
    process.exit(1);
  }

  const baseUrl = process.env.TDAI_LLM_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.TDAI_LLM_MODEL ?? "gpt-4o-mini";

  const storage = new SQLiteBackend(dbPath);
  try {
    const embedder = new LocalEmbedder();
    const pipeline = new AtomPipeline();
    const llmClient = new OpenAILLMClient({ apiKey, baseUrl, model });

    // Fetch captures to process
    const limit = flags.limit ? Number(flags.limit) : 50;
    const captureId = flags["capture-id"];

    let captures: CaptureEntry[];
    if (captureId) {
      const entry = await storage.get(captureId);
      captures = entry ? [entry] : [];
    } else {
      // Search for all captures of type decision, learning, or error
      const results = await storage.search("", null, {
        limit,
        offset: 0,
        mode: "keyword",
        filters: flags["team-id"] ? { teamId: flags["team-id"] } : undefined,
      });
      captures = results
        .map((r) => r.entry)
        .filter((e) => ["decision", "learning", "error"].includes(e.type));
    }

    if (captures.length === 0) {
      console.log("No captures to extract atoms from.");
      return;
    }

    console.log(`Extracting atoms from ${captures.length} capture(s)...`);

    const ctx: PipelineContext = {
      llmClient,
      storage,
      embedder,
      sessionKey: "",
    };

    let totalAtoms = 0;
    let errors = 0;

    for (const capture of captures) {
      try {
        const output = await pipeline.process(
          {
            id: capture.id,
            content: capture.content,
            type: capture.type,
            tags: capture.tags,
            sessionKey: capture.sessionKey,
            teamId: capture.teamId,
            userId: capture.userId,
            taskId: capture.taskId,
          },
          ctx,
        );

        const atomCount = output.atoms?.length ?? 0;
        totalAtoms += atomCount;
        console.log(`  ${capture.id}: ${atomCount} atom(s)`);
      } catch (err) {
        errors++;
        console.error(`  ${capture.id}: FAILED — ${err}`);
      }
    }

    console.log(`\nDone. Extracted ${totalAtoms} atom(s) from ${captures.length} capture(s).`);
    if (errors > 0) {
      console.log(`${errors} capture(s) failed.`);
    }
  } finally {
    storage.close();
  }
}
