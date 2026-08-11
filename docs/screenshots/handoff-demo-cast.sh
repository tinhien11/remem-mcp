#!/bin/bash
# Real handoff demo: 2 agents, same project, different sessions
# Agent 1 = Claude Code, Agent 2 = Devin
# Shows: capture → session ends → new session → recall finds it

# This script is recorded with asciinema
# The "agents" are real CLI invocations using the tdai-memory-mcp SDK

DB="/tmp/tdai-handoff-real/memory.db"
PROJECT="/Users/tin/a/tdai-memory-mcp"
rm -rf /tmp/tdai-handoff-real && mkdir -p /tmp/tdai-handoff-real

cd "$PROJECT"

# Helper to simulate agent typing
type_out() {
  echo -n "$1" | pv -qL 30 2>/dev/null || echo -n "$1"
}

clear
echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║  tdai-memory-mcp — Real Agent Handoff Demo               ║"
echo "  ║  2 agents. Same project. Different sessions.             ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""
sleep 2

# ── SESSION 1: Claude Code ──────────────────────────────────
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │ SESSION 1 — Claude Code                                 │"
echo "  │ \$ claude                                                │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""
sleep 1

echo "  > I need to decide on the database for our memory layer."
echo "    Should we use Postgres or SQLite?"
echo ""
sleep 1.5

echo "  [Claude Code calls tdai-memory capture]"
echo ""
sleep 1

# Real capture via SDK
node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const id = await m.capture(
    'We chose SQLite over Postgres for the memory layer. SQLite is local-first, needs no server, and handles crash recovery with WAL mode. Postgres was rejected because requiring a running server defeats the local-first goal.',
    'decision',
    ['arch', 'storage', 'sqlite', 'handoff-demo']
  );
  console.log('  ✓ Captured: ' + id);
  await m.close();
})();
"
sleep 1

echo ""
echo "  > Also, I hit a bug with FTS5 after the schema migration."
echo ""
sleep 1.5

echo "  [Claude Code calls tdai-memory capture]"
echo ""
sleep 1

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const id = await m.capture(
    'FTS5 external content tables break when the source table schema changes. Fix: run INSERT INTO captures_fts(captures_fts) VALUES(rebuild) after schema migrations.',
    'learning',
    ['fts5', 'sqlite', 'bug-fix', 'handoff-demo']
  );
  console.log('  ✓ Captured: ' + id);
  await m.close();
})();
"
sleep 1

echo ""
echo "  > One more thing — never use emojis in our codebase."
echo ""
sleep 1.5

echo "  [Claude Code calls tdai-memory capture]"
echo ""
sleep 1

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const id = await m.capture(
    'Never use emojis in code or documentation unless the user explicitly asks for it.',
    'decision',
    ['rules', 'style', 'handoff-demo']
  );
  console.log('  ✓ Captured: ' + id);
  await m.close();
})();
"
sleep 1.5

echo ""
echo "  ─────────────────────────────────────────────────────────"
echo "  ✗ Session 1 ends. Claude Code process exits."
echo "    Context window is gone. Memory persists in SQLite."
echo "  ─────────────────────────────────────────────────────────"
echo ""
sleep 2.5

# ── SESSION 2: Devin ────────────────────────────────────────
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │ SESSION 2 — Devin (new session, different agent)        │"
echo "  │ \$ devin                                                │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""
sleep 1.5

echo "  [SessionStart hook fires automatically]"
echo ""
sleep 1

# Real hook-recall
echo '{"session_id":"handoff-real-session-2","cwd":"/Users/tin/a/tdai-memory-mcp"}' | \
  TDAI_DB_PATH="$DB" node dist/index.js hook-recall 2>&1 | \
  python3 -c "
import json,sys
d = json.load(sys.stdin)
ctx = d['hookSpecificOutput']['additionalContext']
print('  ┌─ auto-injected context ─────────────────────────────┐')
for line in ctx.split('\n'):
    if line.strip():
        print('  │ ' + line[:80])
print('  └──────────────────────────────────────────────────────┘')
"
sleep 2

echo ""
echo "  > What database did we choose for the memory layer?"
echo ""
sleep 1.5

echo "  [Devin calls tdai-memory recall]"
echo ""
sleep 1

# Real recall
node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const results = await m.recall('database choice for memory layer');
  const r = results[0];
  const e = r.entry;
  console.log('  ┌─ recall result ─────────────────────────────────────┐');
  console.log('  │ type: ' + e.type);
  console.log('  │ tags: ' + e.tags.join(', '));
  console.log('  │ score: ' + r.score.toFixed(4));
  console.log('  │');
  console.log('  │ ' + e.content.substring(0, 76));
  console.log('  │ ' + e.content.substring(76, 148));
  console.log('  └──────────────────────────────────────────────────────┘');
  await m.close();
})();
"
sleep 2

echo ""
echo "  > Any gotchas I should know about?"
echo ""
sleep 1.5

echo "  [Devin calls tdai-memory recall]"
echo ""
sleep 1

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const results = await m.recall('gotchas pitfalls bugs fix');
  const r = results[0];
  const e = r.entry;
  console.log('  ┌─ recall result ─────────────────────────────────────┐');
  console.log('  │ type: ' + e.type);
  console.log('  │ tags: ' + e.tags.join(', '));
  console.log('  │');
  console.log('  │ ' + e.content.substring(0, 76));
  console.log('  │ ' + e.content.substring(76, 148));
  console.log('  └──────────────────────────────────────────────────────┘');
  await m.close();
})();
"
sleep 2.5

echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║  Session 2 knew everything Session 1 learned.           ║"
echo "  ║                                                          ║"
echo "  ║  No CLAUDE.md. No copy-paste. No manual handoff.         ║"
echo "  ║  Memory persisted in SQLite. Hooks auto-injected it.    ║"
echo "  ║                                                          ║"
echo "  ║  That is the handoff.                                    ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""
sleep 3
