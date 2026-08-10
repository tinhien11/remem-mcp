import { estimateTokens, truncateToTokens } from "../utils/tokenize.js";

/** Quota enforcement result. */
export interface QuotaResult {
  /** The text, possibly truncated. */
  text: string;
  /** Whether the quota cap was reached. */
  quotaHit: boolean;
}

/** Enforce a token quota on a text. If the text exceeds the cap, truncate it and append a hint. */
export function enforceQuota(text: string, maxTokens: number): QuotaResult {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) {
    return { text, quotaHit: false };
  }

  const truncated = truncateToTokens(text, maxTokens);
  const hint =
    "\n\n[... The result was truncated. Use the search tool with a more specific query to drill down.]";
  return {
    text: truncated + hint,
    quotaHit: true,
  };
}

/** Check if the content length is within the limit. */
export function checkContentLength(content: string, maxLength: number): boolean {
  return content.length <= maxLength;
}
