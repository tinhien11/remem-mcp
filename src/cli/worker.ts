import { createHash } from "node:crypto";
import { LocalEmbedder } from "../embedding/local.js";
import { runPipelineWorker } from "../pipeline/worker.js";

/**
 * worker CLI command: run the background pipeline worker.
 *
 * Processes L0 captures → L1 atoms → L2 scenarios → L3 persona automatically.
 * Zero LLM cost (uses RuleBasedAtomPipeline).
 *
 * Usage:
 *   remem-mcp worker-run [--batch-size <n>] [--team-id <id>] [--user-id <id>]
 *
 * Intended to be called from Stop hook or manually after a session.
 */
export async function workerCommand(dbPath: string, flags: Record<string, string>): Promise<void> {
  const embedder = new LocalEmbedder();
  // Stamp created scenarios with the caller's session key (hash(cwd)) so they
  // are scoped to this project and don't leak into other projects' hook context.
  const sessionKey =
    flags["session-key"] ??
    (process.env.REMEM_SESSION_KEY
      ? process.env.REMEM_SESSION_KEY
      : createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16));
  const result = await runPipelineWorker(
    {
      dbPath,
      batchSize: flags["batch-size"] ? Number(flags["batch-size"]) : 50,
      teamId: flags["team-id"],
      userId: flags["user-id"],
      sessionKey,
    },
    embedder,
  );

  console.log("Pipeline worker results:");
  console.log(`  Captures processed (L0→L1): ${result.capturesProcessed}`);
  console.log(`  Atoms extracted:            ${result.atomsExtracted}`);
  console.log(`  Scenarios created (L1→L2):  ${result.scenariosCreated}`);
  console.log(`  Persona updated (L2→L3):    ${result.personaUpdated ? "yes" : "no"}`);
  if (result.errors.length > 0) {
    console.log(`  Errors:                     ${result.errors.length}`);
    for (const e of result.errors.slice(0, 5)) {
      console.log(`    - ${e}`);
    }
  }
}
