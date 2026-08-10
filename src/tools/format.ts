import type { SearchResult } from "../storage/types.js";

/** Format search results into a readable text block. */
export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No memory found for this query.";
  }

  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const { entry, score } = results[i];
    const date = new Date(entry.createdAt).toISOString();
    const tags = entry.tags.length > 0 ? `  tags: [${entry.tags.join(", ")}]` : "";
    lines.push(
      `[${i + 1}] id: ${entry.id}  type: ${entry.type}${tags}  ${date}  score: ${score.toFixed(4)}`,
    );
    lines.push(`    ${entry.content}`);
    lines.push("");
  }

  return lines.join("\n");
}
