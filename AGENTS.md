# Agent Rules

## Always use tdai-memory-mcp

You have a long-term memory server (`tdai-memory` MCP). Always prefer it over grep/glob for code navigation and project context.

### Before answering or coding
1. Call `recall` with the user's question as query
2. Use results to inform your answer — don't repeat what recall already gave you

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
- Stop hook auto-captures the session — but still call `capture` for key decisions during the session
