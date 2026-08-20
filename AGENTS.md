# Agent Rules

## Always use remem-mcp

You have a long-term memory server (`remem-mcp` MCP). Always prefer it over grep/glob for code navigation and project context.

### Before answering or coding
1. Check for `[remem-mcp]` at the top of the turn — hooks auto-inject matching memory
2. **MUST call `recall()` at the start of every non-trivial task** — even if memory was injected. Injected memory is BM25-only (fast, shallow). `recall()` does hybrid search (BM25 + vector) with more results and filters.
3. Use results to inform your answer — don't repeat what recall already gave you

### Before searching code
1. Call `search` or `recall` first — it searches Memory + CodeGraph + Wiki in one call
2. Only use grep/glob if recall returns nothing relevant

### For code navigation
- Use `search` to find symbols (faster than grep, understands function/class/method structure)
- Use CodeGraph data from recall results for callers/callees/impact analysis
- Only read files directly when you know the exact path

### After completing non-trivial work
- Call `capture` automatically with type, tags, and a 1-3 sentence summary
- Do not ask permission, do not announce it

### Session lifecycle
- SessionStart hook auto-injects recent memory — read it before responding
- UserPromptSubmit hook auto-injects memory matching your prompt + auto-captures facts
- Stop hook auto-captures the session — but still call `capture` for key decisions during the session
