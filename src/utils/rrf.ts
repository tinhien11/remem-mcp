/**
 * Reciprocal Rank Fusion (RRF) merge.
 * Fuses two ranked result lists into one.
 * The RRF constant k is 60 (standard value from the original paper).
 *
 * Adapted from TencentDB Agent Memory search-utils pattern (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 */

const RRF_K = 60;

export interface RankedResult {
  id: string;
  score: number;
}

export interface FusedResult {
  id: string;
  score: number;
}

/**
 * Merge two ranked result lists with RRF.
 * @param bm25Results Results from BM25 (FTS5). Lower score is better.
 * @param vecResults Results from vector search. Lower distance is better.
 * @param limit Maximum number of results to return.
 * @returns Fused results, sorted by RRF score (highest first).
 */
export function rrfMerge(
  bm25Results: RankedResult[],
  vecResults: RankedResult[],
  limit: number,
): FusedResult[] {
  const scores = new Map<string, number>();

  // BM25 results: lower score is better, so rank 1 = lowest score
  const sortedBm25 = [...bm25Results].sort((a, b) => a.score - b.score);
  sortedBm25.forEach((r, i) => {
    const rank = i + 1;
    const rrfScore = 1 / (RRF_K + rank);
    scores.set(r.id, (scores.get(r.id) ?? 0) + rrfScore);
  });

  // Vector results: lower distance is better, so rank 1 = lowest distance
  const sortedVec = [...vecResults].sort((a, b) => a.score - b.score);
  sortedVec.forEach((r, i) => {
    const rank = i + 1;
    const rrfScore = 1 / (RRF_K + rank);
    scores.set(r.id, (scores.get(r.id) ?? 0) + rrfScore);
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
