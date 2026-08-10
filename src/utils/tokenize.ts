/**
 * Estimate the token count from text length.
 * Heuristic: 1 token = 4 characters.
 * This is not exact, but it is close enough for the quota cap.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to a maximum number of tokens.
 * Uses the same heuristic: 1 token = 4 characters.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}
