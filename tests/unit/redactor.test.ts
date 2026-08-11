import { describe, expect, it } from "vitest";
import { redact } from "../../src/security/redactor.js";

describe("redactor", () => {
  it("redacts an OpenAI API key", () => {
    const text = "The key is sk-abcdefghijklmnopqrstuvwxyz123456 for the project.";
    const result = redact(text);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("redacts a GitHub personal access token", () => {
    const text = `Use ghp_${"a".repeat(36)} to access the repo.`;
    const result = redact(text);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts a PEM private key block", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIKBgQ==\n-----END RSA PRIVATE KEY-----";
    const result = redact(text);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("[REDACTED]");
  });

  it("does not redact normal text", () => {
    const text = "We decided to use SQLite for the storage backend.";
    const result = redact(text);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(text);
  });

  it("redacts high-entropy strings", () => {
    // A 48-character base64-like string with high entropy
    const text = "The token is AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/aBcDeFgH.";
    const result = redact(text);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("[REDACTED]");
  });

  it("does not redact normal long text", () => {
    const text =
      "This is a normal sentence that is longer than forty characters but has low entropy.";
    const result = redact(text);
    expect(result.redacted).toBe(false);
  });
});
