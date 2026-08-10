/**
 * Embedder interface.
 * Converts text to a vector for semantic search.
 *
 * Adapted from TencentDB Agent Memory embedding pattern (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 */
export interface Embedder {
  /** Convert text to a vector. */
  embed(text: string): Promise<number[]>;

  /** The dimension of the vector. */
  readonly dimension: number;

  /** The model name. */
  readonly model: string;
}
