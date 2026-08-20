import { LocalEmbedder } from "../embedding/local.js";
import { AtomPipeline, RuleBasedAtomPipeline } from "../pipeline/atom.js";
import { OpenAILLMClient } from "../pipeline/llm.js";
import type { PipelineContext, PipelineStage } from "../pipeline/types.js";
import { SQLiteBackend } from "../storage/sqlite.js";
import type { CaptureEntry } from "../storage/types.js";

/**
 * extract CLI command: run L1 atom extraction on existing captures.
 *
 * Usage:
 *   remem-mcp extract [--limit <n>] [--capture-id <id>] [--llm]
 *
 * Default: rule-based extraction (no LLM, zero cost).
 * With --llm flag (or REMEM_LLM_API_KEY): LLM-based extraction (more accurate).
 */
export async function extractCommand(dbPath: string, flags: Record<string, string>): Promise<void> {
  const apiKey = process.env.REMEM_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  const useLLM = flags.llm !== undefined && apiKey;

  const storage = new SQLiteBackend(dbPath);
  try {
    const embedder = new LocalEmbedder();
    let pipeline: PipelineStage;
    let llmClient: OpenAILLMClient | null = null;

    if (useLLM) {
      const baseUrl = process.env.REMEM_LLM_BASE_URL ?? "https://api.openai.com/v1";
      const model = process.env.REMEM_LLM_MODEL ?? "gpt-4o-mini";
      pipeline = new AtomPipeline();
      llmClient = new OpenAILLMClient({ apiKey, baseUrl, model });
      console.log("Mode: LLM-based extraction (gpt-4o-mini)");
    } else {
      pipeline = new RuleBasedAtomPipeline();
      console.log("Mode: rule-based extraction (no LLM, zero cost)");
      if (flags.llm !== undefined && !apiKey) {
        console.log("  (--llm requested but no API key found, falling back to rule-based)");
      }
    }

    // Fetch captures to process
    const limit = flags.limit ? Number(flags.limit) : 50;
    const captureId = flags["capture-id"];

    let captures: CaptureEntry[];
    if (captureId) {
      const entry = await storage.get(captureId);
      captures = entry ? [entry] : [];
    } else {
      // Fetch captures directly (not via FTS search, which fails on empty query)
      const allCaptures = await storage.listAll(limit, 0);
      captures = allCaptures
        .filter((e) => ["decision", "learning", "error", "conversation"].includes(e.type));
    }

    if (captures.length === 0) {
      console.log("No captures to extract atoms from.");
      return;
    }

    console.log(`Extracting atoms from ${captures.length} capture(s)...\n`);

    const ctx: PipelineContext = {
      llmClient: llmClient ?? undefined,
      storage,
      embedder,
      sessionKey: "",
    };

    let totalAtoms = 0;
    let errors = 0;
    let skipped = 0;

    for (const capture of captures) {
      try {
        // Check if atoms already exist for this capture
        const existing = await storage.listAtoms({ captureId: capture.id, limit: 1 });
        if (existing.length > 0) {
          skipped++;
          continue;
        }

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
        if (atomCount > 0) {
          console.log(`  [${capture.type}] ${capture.id}: ${atomCount} atom(s)`);
          for (const a of output.atoms ?? []) {
            console.log(`    → ${a.fact.slice(0, 80)}`);
          }
        }
      } catch (err) {
        errors++;
        console.error(`  ${capture.id}: FAILED — ${err}`);
      }
    }

    console.log(`\nDone. Extracted ${totalAtoms} atom(s) from ${captures.length - skipped} capture(s).`);
    if (skipped > 0) console.log(`${skipped} capture(s) already had atoms (skipped).`);
    if (errors > 0) console.log(`${errors} capture(s) failed.`);
  } finally {
    storage.close();
  }
}
