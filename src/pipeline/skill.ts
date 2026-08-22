/**
 * Skill extraction pipeline — extracts reusable SOPs from successful task captures.
 *
 * Adapted from TencentDB Agent Memory's Skill asset concept (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 *
 * From a task that ran successfully, extract:
 *   - trigger_conditions: keywords/patterns that match this skill
 *   - steps: ordered execution steps
 *   - validation_rules: how to verify success
 *   - source_capture_ids: traceability to the original task
 */

import { generateId } from "../utils/ulid.js";
import type { CaptureInput, PipelineContext, PipelineOutput, PipelineStage } from "./types.js";

/**
 * Rule-based skill extraction pipeline.
 * Extracts steps from task-type captures using pattern matching.
 * No LLM required — works with regex patterns.
 */
export class SkillExtractionPipeline implements PipelineStage {
  readonly name = "skill";
  readonly requiresLLM = false;

  async process(input: CaptureInput, ctx: PipelineContext): Promise<PipelineOutput> {
    // Only extract skills from successful task captures
    if (input.type !== "task") return {};

    const steps = extractSteps(input.content);
    const triggers = extractTriggers(input.content, input.tags);
    const validation = extractValidationRules(input.content);

    // Only create a skill if we found meaningful steps
    if (steps.length < 2) return {};

    const skillName = extractSkillName(input.content) ?? `skill-${input.id.slice(-8)}`;
    const description = extractDescription(input.content);

    // Store the skill
    try {
      const now = Date.now();
      await ctx.storage.putSkill({
        id: generateId(),
        teamId: input.teamId ?? "default",
        agentId: "pipeline",
        name: skillName,
        description,
        content: input.content,
        version: 1,
        createdAt: now,
        updatedAt: now,
        triggerConditions: triggers,
        steps,
        validationRules: validation,
        sourceCaptureIds: [input.id],
        archived: false,
      });
    } catch (e) {
      // Storage may not support putSkill — skip
    }

    return {};
  }
}

/**
 * Extract ordered steps from task content.
 * Looks for numbered lists, bullet lists, and "step" patterns.
 */
function extractSteps(content: string): string[] {
  const steps: string[] = [];

  // Pattern 1: Numbered list (1. 2. 3. or 1) 2) 3))
  const numberedMatch = content.match(/(?:^|\n)\s*(\d+)[.)]\s+(.+)/g);
  if (numberedMatch) {
    for (const match of numberedMatch) {
      const step = match.replace(/(?:^|\n)\s*\d+[.)]\s+/, "").trim();
      if (step.length > 5 && step.length < 200) steps.push(step);
    }
  }

  // Pattern 2: Bullet list (- item or * item)
  if (steps.length === 0) {
    const bulletMatch = content.match(/(?:^|\n)\s*[-*]\s+(.+)/g);
    if (bulletMatch) {
      for (const match of bulletMatch) {
        const step = match.replace(/(?:^|\n)\s*[-*]\s+/, "").trim();
        if (step.length > 5 && step.length < 200) steps.push(step);
      }
    }
  }

  // Pattern 3: "Step N:" patterns
  if (steps.length === 0) {
    const stepMatch = content.match(/(?:^|\n)\s*Step\s+\d+:\s*(.+)/gi);
    if (stepMatch) {
      for (const match of stepMatch) {
        const step = match.replace(/(?:^|\n)\s*Step\s+\d+:\s*/i, "").trim();
        if (step.length > 5 && step.length < 200) steps.push(step);
      }
    }
  }

  return steps.slice(0, 10); // Max 10 steps
}

/**
 * Extract trigger conditions from content + tags.
 */
function extractTriggers(content: string, tags: string[]): string[] {
  const triggers = new Set<string>();

  // Use tags as triggers
  for (const tag of tags) {
    if (tag.length > 2 && tag !== "task") triggers.add(tag);
  }

  // Extract keywords from first 200 chars
  const firstWords = content.slice(0, 200).split(/\s+/).filter((w) => w.length > 4);
  for (const word of firstWords.slice(0, 5)) {
    triggers.add(word.toLowerCase().replace(/[^a-z0-9]/g, ""));
  }

  return Array.from(triggers).slice(0, 8);
}

/**
 * Extract validation rules from content.
 * Looks for "verify", "check", "validate", "success" patterns.
 */
function extractValidationRules(content: string): string[] {
  const rules: string[] = [];
  const patterns = [
    /(?:verify|check|validate|confirm)\s+[^.]+/gi,
    /(?:success|succeeded|passed)\s+[^.]+/gi,
    /(?:expected|should)\s+[^.]+/gi,
  ];

  for (const pattern of patterns) {
    const matches = content.match(pattern);
    if (matches) {
      for (const match of matches.slice(0, 3)) {
        rules.push(match.trim());
      }
    }
  }

  return rules.slice(0, 5);
}

/**
 * Extract a skill name from content.
 */
function extractSkillName(content: string): string | null {
  // Use first line if it's short and descriptive
  const firstLine = content.split("\n")[0].trim();
  if (firstLine.length > 5 && firstLine.length < 60) {
    return firstLine.replace(/[^a-zA-Z0-9\s-]/g, "").trim().toLowerCase().replace(/\s+/g, "-");
  }
  return null;
}

/**
 * Extract a one-line description from content.
 */
function extractDescription(content: string): string {
  const firstSentence = content.split(/[.!]\s/)[0];
  return firstSentence.slice(0, 120);
}
