/**
 * Secret redactor.
 * Scans text for secrets and replaces them with [REDACTED].
 * Uses regex patterns and a high-entropy detector.
 */

/** Regex patterns for known secret formats. */
const SECRET_PATTERNS: RegExp[] = [
  // OpenAI API key
  /sk-[a-zA-Z0-9]{20,}/g,
  // Anthropic API key
  /sk-ant-[a-zA-Z0-9-]+/g,
  // GitHub personal access token
  /ghp_[a-zA-Z0-9]{36}/g,
  // GitHub OAuth token
  /gho_[a-zA-Z0-9]{36}/g,
  // GitHub fine-grained token
  /github_pat_[a-zA-Z0-9_]{82}/g,
  // Slack token
  /xox[baprs]-[a-zA-Z0-9-]+/g,
  // AWS access key ID
  /AKIA[0-9A-Z]{16}/g,
  // AWS secret access key (40 chars, base64-ish)
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])/g,
  // PEM private key block
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Google API key
  /AIza[0-9A-Za-z\-_]{35}/g,
  // Generic bearer token (require 20+ char token to avoid redacting "Bearer with JWT")
  /Bearer\s+[a-zA-Z0-9\-._~+/]{20,}=*/g,
];

/** Minimum length for high-entropy detection. */
const MIN_LENGTH = 40;

/** Entropy threshold in bits per character. */
const ENTROPY_THRESHOLD = 4.5;

/** Compute the Shannon entropy of a string, in bits per character. */
function shannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Find high-entropy strings that look like secrets. */
function findHighEntropyStrings(text: string): string[] {
  const results: string[] = [];
  // Match long strings of alphanumeric, +, /, =
  const regex = /[a-zA-Z0-9+/=]{40,}/g;
  let match: RegExpExecArray | null;
  match = regex.exec(text);
  while (match !== null) {
    const str = match[0];
    if (str.length >= MIN_LENGTH) {
      const entropy = shannonEntropy(str);
      if (entropy >= ENTROPY_THRESHOLD) {
        results.push(str);
      }
    }
    match = regex.exec(text);
  }
  return results;
}

export interface RedactionResult {
  /** The redacted text. */
  text: string;
  /** Whether any secrets were found and redacted. */
  redacted: boolean;
}

/** Redact secrets from text. Returns the redacted text and a flag. */
export function redact(text: string): RedactionResult {
  let result = text;
  let redacted = false;

  // Apply regex patterns
  for (const pattern of SECRET_PATTERNS) {
    const before = result;
    result = result.replace(pattern, "[REDACTED]");
    if (result !== before) redacted = true;
  }

  // Apply high-entropy detection
  const highEntropy = findHighEntropyStrings(result);
  for (const str of highEntropy) {
    // Make sure we did not already redact this region
    result = result.replace(str, "[REDACTED]");
    redacted = true;
  }

  return { text: result, redacted };
}
