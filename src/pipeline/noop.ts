import type { CaptureInput, PipelineContext, PipelineOutput, PipelineStage } from "./types.js";

/**
 * Noop pipeline. The default pipeline.
 * It does nothing. It stores L0 data only.
 * The storage layer already wrote the L0 row before the pipeline runs.
 */
export class NoopPipeline implements PipelineStage {
  readonly name = "noop";
  readonly requiresLLM = false;

  async process(_input: CaptureInput, _ctx: PipelineContext): Promise<PipelineOutput> {
    return {};
  }
}
