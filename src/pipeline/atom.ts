import { generateId } from "../utils/ulid.js";
import type { CaptureInput, PipelineContext, PipelineOutput, PipelineStage } from "./types.js";

/**
 * Atom extraction pipeline (L1).
 * Uses an LLM to extract 1-3 atomic facts from a captured entry.
 * Each atom is a single, self-contained fact that is useful on its own.
 */
export class AtomPipeline implements PipelineStage {
  readonly name = "atom";
  readonly requiresLLM = true;

  async process(input: CaptureInput, ctx: PipelineContext): Promise<PipelineOutput> {
    if (!ctx.llmClient) {
      throw new Error("Atom pipeline requires an LLM client. Set REMEM_LLM_API_KEY.");
    }

    // Only extract atoms from decision, learning, and error types
    if (!["decision", "learning", "error"].includes(input.type)) {
      return {};
    }

    const prompt = buildPrompt(input.content, input.type);
    const response = await ctx.llmClient.complete(prompt);
    const facts = parseFacts(response, input.id);

    if (facts.length === 0) {
      return {};
    }

    // Store atoms in the database
    for (const fact of facts) {
      await ctx.storage.putAtom({
        id: generateId(),
        captureId: input.id,
        fact: fact.text,
        confidence: fact.confidence,
        createdAt: Date.now(),
        teamId: input.teamId,
        agentId: undefined,
        userId: input.userId,
      });
    }

    return {
      atoms: facts.map((f) => ({
        captureId: input.id,
        fact: f.text,
        confidence: f.confidence,
      })),
    };
  }
}

/** Build the LLM prompt for atom extraction. */
function buildPrompt(content: string, type: string): string {
  return `Extract 1-3 atomic facts from the following ${type}. Each fact must be:
- A single, self-contained sentence
- Useful on its own without the original context
- Focused on one piece of information

Return one fact per line, prefixed with "[fact] ". If the text is too simple to yield facts, return nothing.

Text:
"""
${content}
"""

Facts:`;
}

interface ParsedFact {
  text: string;
  confidence: number;
}

/**
 * Rule-based atom extraction pipeline for conversations (no LLM required).
 *
 * Detects migration/upgrade patterns and extracts current-state facts,
 * stripping the old value so it doesn't leak into search results.
 * Example: "Migrated database from SQLite to Turso" → "Migrated database to Turso"
 */
export class RuleBasedAtomPipeline implements PipelineStage {
  readonly name = "rule-atom";
  readonly requiresLLM = false;

  async process(input: CaptureInput, ctx: PipelineContext): Promise<PipelineOutput> {
    if (input.type !== "conversation") {
      return {};
    }

    const facts = extractMigrationFacts(input.content);
    if (facts.length === 0) {
      return {};
    }

    for (const fact of facts) {
      await ctx.storage.putAtom({
        id: generateId(),
        captureId: input.id,
        fact: fact.text,
        confidence: fact.confidence,
        createdAt: Date.now(),
        teamId: input.teamId,
        agentId: undefined,
        userId: input.userId,
      });
    }

    return {
      atoms: facts.map((f) => ({
        captureId: input.id,
        fact: f.text,
        confidence: f.confidence,
      })),
    };
  }
}

/** Extract current-state facts from migration/upgrade sentences using regex. */
function extractMigrationFacts(content: string): ParsedFact[] {
  const facts: ParsedFact[] = [];

  // Pattern: "from <old_value> to <new_value>" — remove the old value.
  // Matches: "Migrated database from SQLite to Turso", "Migrated from Heroku to AWS ECS"
  const fromToPattern = /\bfrom\s+[A-Za-z0-9][A-Za-z0-9._]*(?:\s+[A-Za-z0-9._]+)*\s+to\b/gi;
  if (fromToPattern.test(content)) {
    const cleaned = content.replace(fromToPattern, "to").replace(/\s+/g, " ").trim();
    if (cleaned !== content && cleaned.length > 10) {
      facts.push({ text: cleaned, confidence: 0.85 });
    }
  }

  return facts;
}

/** Parse the LLM response into a list of facts. */
function parseFacts(response: string, sourceId: string): ParsedFact[] {
  const lines = response.trim().split("\n");
  const facts: ParsedFact[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Accept lines with "[fact] " prefix, or lines starting with "- "
    let text = trimmed;
    if (text.startsWith("[fact] ")) {
      text = text.slice(7).trim();
    } else if (text.startsWith("- ")) {
      text = text.slice(2).trim();
    } else if (text.match(/^\d+\.\s/)) {
      text = text.replace(/^\d+\.\s/, "").trim();
    }

    // Skip lines that are not facts (meta-commentary)
    if (text.toLowerCase().startsWith("here are") || text.toLowerCase().startsWith("no facts")) {
      continue;
    }
    if (text.length < 10) continue;
    if (facts.length >= 3) break;

    // Append source reference
    const factWithSource = `${text} [source: ${sourceId}]`;
    facts.push({ text: factWithSource, confidence: 0.9 });
  }

  return facts;
}
