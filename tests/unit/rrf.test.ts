import { describe, expect, it } from "vitest";
import { rrfMerge } from "../../src/utils/rrf.js";

describe("rrfMerge", () => {
  it("fuses two result lists and sorts by RRF score", () => {
    const bm25 = [
      { id: "a", score: -1.5 },
      { id: "b", score: -2.0 },
    ];
    const vec = [
      { id: "b", score: 0.1 },
      { id: "c", score: 0.2 },
    ];

    const result = rrfMerge(bm25, vec, 10);

    // "b" appears in both lists, so it has the highest RRF score
    expect(result[0].id).toBe("b");
    expect(result.length).toBe(3);
  });

  it("respects the limit", () => {
    const bm25 = [
      { id: "a", score: -1.0 },
      { id: "b", score: -2.0 },
      { id: "c", score: -3.0 },
    ];
    const vec = [
      { id: "d", score: 0.1 },
      { id: "e", score: 0.2 },
    ];

    const result = rrfMerge(bm25, vec, 2);
    expect(result.length).toBe(2);
  });

  it("handles empty result lists", () => {
    const result = rrfMerge([], [], 10);
    expect(result.length).toBe(0);
  });

  it("handles one empty list", () => {
    // BM25: lower score is better. So -2.0 (b) is better than -1.0 (a).
    const bm25 = [
      { id: "a", score: -1.0 },
      { id: "b", score: -2.0 },
    ];
    const result = rrfMerge(bm25, [], 10);
    expect(result.length).toBe(2);
    // b has a lower score, so it ranks first and gets a higher RRF score.
    expect(result[0].id).toBe("b");
  });
});
