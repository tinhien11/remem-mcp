import { describe, expect, it } from "vitest";
import { stripQueryProperNouns } from "../../src/storage/sqlite.js";

describe("stripQueryProperNouns", () => {
  it("strips person-name-like proper nouns (Titlecase)", () => {
    // "Tin" is Titlecase (first upper, rest lower) → stripped
    expect(stripQueryProperNouns("what editor does Tin use")).toBe("editor use");
  });

  it("keeps acronyms (all-caps)", () => {
    // API, REST are all-caps → kept. GraphQL is mixed-case → kept.
    // "or" is a stopword → filtered out.
    expect(stripQueryProperNouns("API design GraphQL or REST")).toBe("API design GraphQL REST");
  });

  it("keeps mixed-case technical terms (GraphQL, PostgreSQL)", () => {
    expect(stripQueryProperNouns("what database does Acme use")).toBe("database use");
    // "Acme" is Titlecase → stripped, "PostgreSQL" would be kept if present
    expect(stripQueryProperNouns("PostgreSQL vs MySQL")).toBe("PostgreSQL vs MySQL");
  });

  it("strips multiple person names", () => {
    expect(stripQueryProperNouns("When did Caroline go to the LGBTQ support group")).toBe(
      "go LGBTQ support group",
    );
  });

  it("preserves single-word queries (no stripping if <2 content words remain)", () => {
    // "Before" is the only content word → kept (fallback)
    expect(stripQueryProperNouns("Before")).toBe("Before");
  });

  it("returns original when all tokens are proper nouns (fallback)", () => {
    // Both "Tin" and "Sarah" are proper nouns → fallback to filtered (which is same)
    expect(stripQueryProperNouns("Tin Sarah")).toBe("Tin Sarah");
  });

  it("handles empty query", () => {
    expect(stripQueryProperNouns("")).toBe("");
  });

  it("handles whitespace-only query", () => {
    expect(stripQueryProperNouns("   ")).toBe("");
  });

  it("handles all-stopword query (fallback to single-char tokens)", () => {
    // "the", "an", "is" are stopwords (length > 1). "a" is single-char → kept.
    // filtered = ["a"], noProperNouns = ["a"], length=1 > 0 → return "a"
    expect(stripQueryProperNouns("the a an is")).toBe("a");
  });

  it("preserves single-character tokens", () => {
    // "R" is single-char → kept (could be meaningful identifier)
    expect(stripQueryProperNouns("plan R for Tin")).toBe("plan R");
  });

  it("does not strip first word of sentence if it's a stopword", () => {
    // "When" is a stopword → already filtered out, not affected by proper noun logic
    expect(stripQueryProperNouns("When did Tin deploy v2")).toBe("deploy v2");
  });

  it("handles CI/CD correctly (mixed case with slash)", () => {
    // "CI/CD" — first char "C" upper, rest "I/CD" not all lower → not a person name → kept
    expect(stripQueryProperNouns("CI/CD setup for Tin")).toBe("CI/CD setup");
  });

  it("strips place names (Titlecase)", () => {
    // "Vietnam" is Titlecase → stripped
    expect(stripQueryProperNouns("where does Tin live Vietnam")).toBe("live");
  });
});
