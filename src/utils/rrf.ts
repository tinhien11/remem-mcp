/**
 * Reciprocal Rank Fusion (RRF) merge with weighted channels.
 * Fuses two ranked result lists into one.
 *
 * Vector search is weighted 1.5x over BM25 because vector similarity
 * is more semantically relevant for conceptual queries, while BM25
 * with OR semantics can introduce noise at scale (1K+ memories).
 *
 * Adapted from TencentDB Agent Memory search-utils pattern (MIT, Tencent 2026).
 * https://github.com/TencentCloud/TencentDB-Agent-Memory
 */

// k=40 works better than the standard k=60 for smaller result sets (<500 items)
// typical in memory servers. Lower k gives more weight to top-ranked items.
const RRF_K = 40;

// Vector search weight: 3x over BM25. Vector similarity is more precise
// for semantic matching, while BM25 OR semantics can be noisy — especially
// when a proper noun in the query (e.g. "Tin") matches an unrelated capture
// that happens to mention that name. Higher vector weight ensures semantic
// relevance dominates over keyword coincidence.
const VEC_WEIGHT = 3.0;

export interface RankedResult {
  id: string;
  score: number;
}

export interface FusedResult {
  id: string;
  score: number;
}

/**
 * Merge two ranked result lists with weighted RRF.
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
  // Weighted higher because vector similarity is more semantically precise.
  const sortedVec = [...vecResults].sort((a, b) => a.score - b.score);
  sortedVec.forEach((r, i) => {
    const rank = i + 1;
    const rrfScore = (1 / (RRF_K + rank)) * VEC_WEIGHT;
    scores.set(r.id, (scores.get(r.id) ?? 0) + rrfScore);
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
