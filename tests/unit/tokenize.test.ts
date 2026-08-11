import { describe, expect, it } from "vitest";
import { estimateTokens, truncateToTokens } from "../../src/utils/tokenize.js";

describe("tokenize", () => {
  it("estimates tokens from text length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("truncates text to a maximum number of tokens", () => {
    const text = "a".repeat(100);
    const truncated = truncateToTokens(text, 10);
    expect(truncated.length).toBe(40);
  });

  it("does not truncate text that is within the limit", () => {
    const text = "abcd";
    const truncated = truncateToTokens(text, 10);
    expect(truncated).toBe("abcd");
  });
});
