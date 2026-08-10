import { ulid } from "ulid";

/**
 * Generate a sortable unique ID.
 * Uses ULID (Universally Unique Lexicographically Sortable Identifier).
 */
export function generateId(): string {
  return ulid();
}
