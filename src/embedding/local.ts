import type { Embedder } from "./types.js";

/**
 * Local embedder. Uses the ONNX runtime and the model all-MiniLM-L6-v2.
 * The vector has 384 dimensions. No API key is needed.
 *
 * The first run downloads the model. Subsequent runs load the model from the disk cache.
 *
 * The `@huggingface/transformers` import is deferred to first use so that
 * environments without the ONNX native module (e.g. CI Linux) can still load
 * the module — only `embed()` calls will fail there.
 */
export class LocalEmbedder implements Embedder {
  readonly dimension = 384;
  readonly model = "Xenova/all-MiniLM-L6-v2";

  private extractor:
    | ((
        input: string,
        options: { pooling: string; normalize: boolean },
      ) => Promise<{ data: unknown }>)
    | null = null;
  private initPromise: Promise<void> | null = null;

  /** Initialize the model. This runs once. Subsequent calls return immediately. */
  private async init(): Promise<void> {
    if (this.extractor) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = (async () => {
      // Lazy import so the ONNX native module is only loaded when embedding
      // is actually needed (not at module load time).
      const { pipeline } = await import("@huggingface/transformers");
      this.extractor = (await pipeline(
        "feature-extraction",
        this.model,
      )) as unknown as typeof this.extractor;
    })();
    await this.initPromise;
  }

  async embed(text: string): Promise<number[]> {
    await this.init();
    if (!this.extractor) throw new Error("Embedder failed to initialize");

    const output = await this.extractor(text, { pooling: "mean", normalize: true });
    // output.data is a Float32Array
    return Array.from(output.data as Float32Array);
  }
}
