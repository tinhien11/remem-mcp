import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Skill file content. Embedded in the bundle so it works without the source tree. */
const SKILL_CONTENT = `---
name: tdai-memory
description: Long-term memory for coding agents. Automatically recall project context before answering, and capture decisions, learnings, and fixes after completing work. Use when the user references past work, starts a new session, or when the task needs project context that is not in the current conversation.
user-invocable: false
---

You have access to a long-term memory server via MCP. It has 4 tools: \`recall\`, \`capture\`, \`search\`, and \`forget\`. Use them automatically as described below. Do not ask the user for permission to use memory.

## When to recall

Call \`recall\` at the start of a session, or when the user references past work. Do this BEFORE you answer or start coding.

\`\`\`
recall({ "query": "<the user's question or task summary>", "mode": "hybrid" })
\`\`\`

If the user says any of these, call \`recall\` first:
- "do you remember"
- "last time we"
- "what did we decide about"
- "have we seen this error before"
- "continue from where we left off"
- any reference to a previous session or past decision

If recall returns results, use them to inform your answer. If recall returns "No memory found", proceed normally. Do not mention that recall returned nothing.

## When to capture

Call \`capture\` AFTER you complete a non-trivial task. Do this automatically. Do not ask the user.

Capture when:
- You make an architectural decision
- You fix a bug and found the root cause
- You learn something non-obvious about the codebase
- You complete a feature that took multiple steps

\`\`\`
capture({
  "content": "<a short summary of the decision, learning, or fix>",
  "type": "decision" | "learning" | "task" | "error" | "conversation",
  "tags": ["<relevant tags>"]
})
\`\`\`

### What to capture

Good captures (specific, useful later):
- "We chose SQLite over Postgres for the MVP because zero-setup is a requirement."
- "The FTS5 trigger must use content_rowid, not content_rowid = captures.rowid."
- "The RRF constant k=60 is the standard value from the original paper."

Bad captures (too vague, not useful later):
- "We talked about the database."
- "I fixed a bug."
- "The user asked a question."

### Types

- \`decision\`: A choice between alternatives. Include what was chosen and why.
- \`learning\`: A non-obvious fact about the codebase, a library, or a tool.
- \`task\`: A completed task with a known outcome.
- \`error\`: A bug with a known root cause and fix.
- \`conversation\`: A general note that does not fit the other types.

## When to search

Call \`search\` when \`recall\` is too broad and you need specific facts with filters.

\`\`\`
search({
  "query": "<specific query>",
  "mode": "hybrid",
  "filters": { "type": "decision", "tags": ["arch"] }
})
\`\`\`

## When to forget

Call \`forget\` ONLY when the user explicitly asks to delete memory. Always require \`confirm: true\`. Never auto-forget.

## Rules

1. Never fabricate memory. If recall returns nothing, say nothing about memory.
2. Never capture trivial things (file reads, ls commands, simple questions).
3. Keep capture content short: 1 to 3 sentences.
4. Use tags that you will search for later (for example: "arch", "bug", "config").
5. Do not tell the user "I am capturing this to memory." Just do it silently.
6. Do not tell the user "I am recalling from memory." Just use the results.
`;

/** Supported agent skill directories. */
const SKILL_TARGETS = [
  {
    name: "Devin CLI",
    path: join(homedir(), ".config", "devin", "skills", "tdai-memory", "SKILL.md"),
  },
  {
    name: "Claude Code",
    path: join(homedir(), ".claude", "skills", "tdai-memory", "SKILL.md"),
  },
  {
    name: "Generic (.agents)",
    path: join(homedir(), ".agents", "skills", "tdai-memory", "SKILL.md"),
  },
];

/** Install the skill file to all supported agent directories. */
export async function installSkill(): Promise<void> {
  let installed = 0;

  for (const target of SKILL_TARGETS) {
    const dir = dirname(target.path);

    // Create the directory if it does not exist
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Check if the skill already exists
    if (existsSync(target.path)) {
      console.log(`  ${target.name}: Already installed. Updated.`);
    } else {
      console.log(`  ${target.name}: Installed.`);
    }

    writeFileSync(target.path, SKILL_CONTENT, "utf-8");
    installed++;
  }

  console.log(`\nSkill installed to ${installed} location(s).`);
  console.log("Restart your agent to load the skill.");
  console.log("\nThe skill teaches your agent to:");
  console.log("  - Recall past context before answering");
  console.log("  - Capture decisions, learnings, and fixes after completing work");
  console.log("  - Search with filters when recall is too broad");
  console.log("  - Forget only on explicit user request");
}
