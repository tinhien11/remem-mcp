import { describe, expect, it } from "vitest";
import { checkContentLength, enforceQuota } from "../../src/security/quota.js";

describe("quota", () => {
  it("does not truncate text within the limit", () => {
    const text = "a".repeat(100);
    const result = enforceQuota(text, 1000);
    expect(result.quotaHit).toBe(false);
    expect(result.text).toBe(text);
  });

  it("truncates text that exceeds the limit", () => {
    const text = "a".repeat(10000);
    const result = enforceQuota(text, 100);
    expect(result.quotaHit).toBe(true);
    expect(result.text).toContain("truncated");
    expect(result.text).toContain("drill down");
  });

  it("checks content length", () => {
    expect(checkContentLength("short", 100)).toBe(true);
    expect(checkContentLength("a".repeat(200), 100)).toBe(false);
  });
});
