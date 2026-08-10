---
name: tdai-memory
description: Long-term memory for coding agents. Automatically recall project context before answering, and capture decisions, learnings, and fixes after completing work. Use when the user references past work, starts a new session, or when the task needs project context that is not in the current conversation.
user-invocable: false
---

You have access to a long-term memory server via MCP. It has 4 tools: `recall`, `capture`, `search`, and `forget`. Use them automatically as described below. Do not ask the user for permission to use memory.

## When to recall

Call `recall` at the start of a session, or when the user references past work. Do this BEFORE you answer or start coding.

```
recall({ "query": "<the user's question or task summary>", "mode": "hybrid" })
```

If the user says any of these, call `recall` first:
- "do you remember"
- "last time we"
- "what did we decide about"
- "have we seen this error before"
- "continue from where we left off"
- any reference to a previous session or past decision

If recall returns results, use them to inform your answer. If recall returns "No memory found", proceed normally. Do not mention that recall returned nothing.

## When to capture

Call `capture` AFTER you complete a non-trivial task. Do this automatically. Do not ask the user.

Capture when:
- You make an architectural decision
- You fix a bug and found the root cause
- You learn something non-obvious about the codebase
- You complete a feature that took multiple steps

### L0: Raw capture

Always capture the raw summary first:

```
capture({
  "content": "<a short summary of the decision, learning, or fix>",
  "type": "decision" | "learning" | "task" | "error" | "conversation",
  "tags": ["<relevant tags>"]
})
```

### L1: Atom extraction

After the L0 capture, extract 1-3 atomic facts from it. Each atom is a single, self-contained fact that is useful on its own. Capture each atom separately with `type: "atom"` and tag it `L1`. Link it back to the L0 capture by including the L0 id in the content.

```
// After capturing L0 with id 01KZNVN77XPQYAT9EXS2R1T68Y:
capture({
  "content": "Chose SQLite over Postgres because zero-setup is a requirement. [source: 01KZNVN77XPQYAT9EXS2R1T68Y]",
  "type": "atom",
  "tags": ["L1", "arch", "storage"]
})
capture({
  "content": "sqlite-vec provides vector search without a separate database server. [source: 01KZNVN77XPQYAT9EXS2R1T68Y]",
  "type": "atom",
  "tags": ["L1", "arch", "vector"]
})
```

Rules for atoms:
- Each atom is ONE fact, not a paragraph.
- An atom is self-contained. A reader can understand it without the L0 context.
- Include `[source: <L0 id>]` at the end so atoms can be traced back.
- Extract atoms only for `decision`, `learning`, and `error` types. Skip for `task` and `conversation`.
- Do not extract more than 3 atoms per L0 capture.
- If the L0 capture is too simple to yield atoms, skip L1.

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

- `decision`: A choice between alternatives. Include what was chosen and why.
- `learning`: A non-obvious fact about the codebase, a library, or a tool.
- `task`: A completed task with a known outcome.
- `error`: A bug with a known root cause and fix.
- `conversation`: A general note that does not fit the other types.
- `atom`: An atomic fact extracted from a L0 capture. Always tag with `L1` and include `[source: <L0 id>]`.

## When to search

Call `search` when `recall` is too broad and you need specific facts with filters.

```
search({
  "query": "<specific query>",
  "mode": "hybrid",
  "filters": { "type": "decision", "tags": ["arch"] }
})
```

## When to forget

Call `forget` ONLY when the user explicitly asks to delete memory. Always require `confirm: true`. Never auto-forget.

## Rules

1. Never fabricate memory. If recall returns nothing, say nothing about memory.
2. Never capture trivial things (file reads, ls commands, simple questions).
3. Keep capture content short: 1 to 3 sentences.
4. Use tags that you will search for later (for example: "arch", "bug", "config").
5. Do not tell the user "I am capturing this to memory." Just do it silently.
6. Do not tell the user "I am recalling from memory." Just use the results.
