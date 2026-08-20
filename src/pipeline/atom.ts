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
 * Rule-based atom extraction pipeline (no LLM required).
 *
 * Extracts atomic facts from captures using regex patterns:
 * - Decisions: strip "Decision:" prefix, extract core choice
 * - Learnings: strip context, keep core fact
 * - Errors: extract command + exit code
 * - Conversations: detect migration patterns ("from X to Y" → "to Y")
 *
 * This is a fallback when no LLM API key is available. Less accurate than
 * LLM extraction but zero-cost and runs automatically.
 */
export class RuleBasedAtomPipeline implements PipelineStage {
  readonly name = "rule-atom";
  readonly requiresLLM = false;

  async process(input: CaptureInput, ctx: PipelineContext): Promise<PipelineOutput> {
    // Only extract from types that yield useful atoms
    if (!["decision", "learning", "error", "conversation"].includes(input.type)) {
      return {};
    }

    const facts = extractRuleBasedFacts(input.content, input.type);
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

/** Extract facts from content using rule-based patterns. */
function extractRuleBasedFacts(content: string, type: string): ParsedFact[] {
  const facts: ParsedFact[] = [];
  const text = content.trim();

  if (type === "decision") {
    // "Decision: <fact>" → strip prefix
    const decisionMatch = text.match(/^Decision:\s*(.+)/i);
    if (decisionMatch) {
      const fact = decisionMatch[1].trim();
      if (fact.length > 10) facts.push({ text: fact, confidence: 0.9 });
    }
    // "Chose X over Y" → "Use X"
    const choseMatch = text.match(/chose\s+(.+?)\s+over\s+/i);
    if (choseMatch) {
      const fact = `Use ${choseMatch[1].trim()}`;
      if (fact.length > 10) facts.push({ text: fact, confidence: 0.85 });
    }
    // "Use X for Y" → keep as-is
    const useMatch = text.match(/use\s+\S+\s+for\s+\S+/i);
    if (useMatch && facts.length < 3) {
      const fact = text.slice(useMatch.index, useMatch.index + useMatch[0].length);
      if (fact.length > 10) facts.push({ text: fact, confidence: 0.8 });
    }
  } else if (type === "learning") {
    // Learning: keep first sentence if it's a self-contained fact
    const firstSentence = text.split(/[.!?]/)[0].trim();
    if (firstSentence.length > 15 && firstSentence.length < 200) {
      facts.push({ text: firstSentence, confidence: 0.8 });
    }
  } else if (type === "error") {
    // "Command failed: <cmd>" → "Error: <cmd> fails"
    const cmdMatch = text.match(/Command failed:\s*(.+)/i);
    if (cmdMatch) {
      const cmd = cmdMatch[1].trim().slice(0, 100);
      facts.push({ text: `Error: ${cmd} fails`, confidence: 0.85 });
    }
    // "Exit code N" → extract
    const exitMatch = text.match(/Exit code\s+(\d+)/i);
    if (exitMatch && facts.length < 3) {
      facts.push({ text: `Exit code ${exitMatch[1]}`, confidence: 0.7 });
    }
  } else if (type === "conversation") {
    // Migration pattern: "from X to Y" → "to Y"
    const fromToPattern = /\bfrom\s+[A-Za-z0-9][A-Za-z0-9._]*(?:\s+[A-Za-z0-9._]+)*\s+to\b/gi;
    if (fromToPattern.test(text)) {
      const cleaned = text.replace(fromToPattern, "to").replace(/\s+/g, " ").trim();
      if (cleaned !== text && cleaned.length > 10) {
        facts.push({ text: cleaned, confidence: 0.85 });
      }
    }
  }

  return facts.slice(0, 3);
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
