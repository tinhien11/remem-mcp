/**
 * Pipeline stage interface.
 * The pipeline distills captured data into upper layers (L1, L2, L3).
 *
 * Adapted from TencentDB Agent Memory pipeline concept (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 */

import type { StorageBackend } from "../storage/types.js";
import type { Embedder } from "../embedding/types.js";

export interface CaptureInput {
  id: string;
  content: string;
  type: string;
  tags: string[];
  sessionKey: string;
}

export interface Atom {
  captureId: string;
  fact: string;
  confidence: number;
}

export interface Scenario {
  atomIds: string[];
  summary: string;
  personaTags: string[];
}

export interface MermaidNode {
  id: string;
  label: string;
  captureId: string;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

export interface MermaidCanvas {
  nodes: MermaidNode[];
  edges: MermaidEdge[];
}

export interface PipelineOutput {
  atoms?: Atom[];
  scenarios?: Scenario[];
  canvas?: MermaidCanvas;
}

export interface LLMClient {
  complete(prompt: string): Promise<string>;
}

export interface PipelineContext {
  llmClient?: LLMClient;
  storage: StorageBackend;
  embedder: Embedder;
  sessionKey: string;
}

export interface PipelineStage {
  /** The name of the pipeline. */
  readonly name: string;

  /** Whether the pipeline needs an LLM API key. */
  readonly requiresLLM: boolean;

  /** Process a captured entry. */
  process(input: CaptureInput, ctx: PipelineContext): Promise<PipelineOutput>;
}
