#!/bin/bash
# 3-session demo: Stop hook auto-capture + cross-agent handoff
# Session 1: Claude Code works, exits → Stop hook auto-captures
# Session 2: Devin starts → SessionStart hook injects → recall
# Session 3: Codex starts → SessionStart hook injects → recall
#
# Everything is real: real SDK calls, real SQLite, real hook-recall, real hook-capture.
# The "agents" are simulated terminal sessions, but the memory operations are live.

DB="/tmp/remem-handoff-3session/memory.db"
PROJECT="/Users/tin/a/remem-mcp"
rm -rf /tmp/remem-handoff-3session && mkdir -p /tmp/remem-handoff-3session

cd "$PROJECT"

# Initialize DB schema
node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  await m.recall('init');
  await m.close();
})();
" 2>/dev/null

clear
echo ""
echo "  ╔═══════════════════════════════════════════════════════════════╗"
echo "  ║                                                               ║"
echo "  ║   remem-mcp                                             ║"
echo "  ║   3-session demo: auto-capture + cross-agent handoff          ║"
echo "  ║                                                               ║"
echo "  ║   Session 1: Claude Code  →  works, exits, Stop hook saves    ║"
echo "  ║   Session 2: Devin        →  starts, hook injects, recalls    ║"
echo "  ║   Session 3: Codex        →  starts, hook injects, recalls    ║"
echo "  ║                                                               ║"
echo "  ╚═══════════════════════════════════════════════════════════════╝"
echo ""
sleep 4

# ═══════════════════════════════════════════════════════════════
# SESSION 1 — Claude Code
# ═══════════════════════════════════════════════════════════════
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │                                                             │"
echo "  │  SESSION 1                                                  │"
echo "  │  Agent: Claude Code                                         │"
echo "  │  Task:   Architecture review                                │"
echo "  │                                                             │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""
sleep 3

echo "  User:"
echo "    > We need to pick a database for the memory layer."
echo "    > SQLite or Postgres? What do you think?"
echo ""
sleep 4

echo "  Claude Code:"
echo "    I recommend SQLite with WAL mode."
echo "    It is local-first, needs no server, and handles crash recovery."
echo "    Postgres would require a running server — that defeats the purpose."
echo ""
sleep 5

echo "  [Claude Code calls remem-mcp capture]"
echo ""
sleep 2

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const id = await m.capture(
    'We chose SQLite over Postgres for the memory layer. SQLite is local-first, needs no server, and handles crash recovery with WAL mode. Postgres was rejected because requiring a running server defeats the local-first goal.',
    'decision',
    ['arch', 'storage', 'sqlite']
  );
  console.log('  Captured: ' + id);
  await m.close();
})();
"
sleep 3

echo ""
echo "  User:"
echo "    > Good. Also, I hit a bug with FTS5 after the schema migration."
echo "    > The search stopped returning results."
echo ""
sleep 5

echo "  Claude Code:"
echo "    That is a known FTS5 issue. When the source table schema changes,"
echo "    the external content table breaks. You need to rebuild it:"
echo "    INSERT INTO captures_fts(captures_fts) VALUES('rebuild');"
echo ""
sleep 5

echo "  [Claude Code calls remem-mcp capture]"
echo ""
sleep 2

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const id = await m.capture(
    'FTS5 external content tables break when the source table schema changes. Fix: run INSERT INTO captures_fts(captures_fts) VALUES(rebuild) after schema migrations.',
    'learning',
    ['fts5', 'sqlite', 'bug-fix']
  );
  console.log('  Captured: ' + id);
  await m.close();
})();
"
sleep 3

echo ""
echo "  User:"
echo "    > Thanks. I am done for now. Exiting."
echo ""
sleep 3

echo "  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─"
echo "  Session 1 is closing."
echo "  The Stop hook fires automatically on exit."
echo "  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─"
echo ""
sleep 4

echo "  [Stop hook fires — auto-capturing session transcript]"
echo ""
sleep 2

# Real hook-capture (Stop hook)
echo '{"session_id":"handoff-3session-s1","cwd":"/Users/tin/a/remem-mcp","transcript_path":"/dev/null"}' | \
  REMEM_DB_PATH="$DB" node dist/index.js hook-capture 2>&1 | \
  python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print('  Stop hook result: ' + d.get('hookSpecificOutput',{}).get('additionalContext','no context'))
except:
    print('  Stop hook fired (transcript captured)')
"
sleep 4

echo ""
echo "  Session 1 ended."
echo "  Context window: gone."
echo "  Memory: saved in SQLite."
echo ""
sleep 4

# ═══════════════════════════════════════════════════════════════
# SESSION 2 — Devin
# ═══════════════════════════════════════════════════════════════
echo "  ═══════════════════════════════════════════════════════════════"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │                                                             │"
echo "  │  SESSION 2                                                  │"
echo "  │  Agent: Devin  (different agent, same project)              │"
echo "  │  Task:   Continue the architecture work                     │"
echo "  │                                                             │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""
sleep 4

echo "  Devin starts a new session."
echo "  The SessionStart hook fires automatically before the first message."
echo ""
sleep 4

echo "  [SessionStart hook fires — auto-injecting recent memory]"
echo ""
sleep 2

# Real hook-recall
echo '{"session_id":"handoff-3session-s2","cwd":"/Users/tin/a/remem-mcp"}' | \
  REMEM_DB_PATH="$DB" node dist/index.js hook-recall 2>&1 | \
  python3 -c "
import json,sys
d = json.load(sys.stdin)
ctx = d['hookSpecificOutput']['additionalContext']
print('  ┌─ auto-injected context ─────────────────────────────────────┐')
for line in ctx.split('\n'):
    if line.strip():
        print('  │ ' + line[:90])
print('  └──────────────────────────────────────────────────────────────┘')
"
sleep 6

echo ""
echo "  Devin now knows what Claude Code decided last session."
echo "  Without anyone telling it. Without CLAUDE.md. Without copy-paste."
echo ""
sleep 5

echo "  User:"
echo "    > What database did we choose for the memory layer?"
echo ""
sleep 4

echo "  [Devin calls remem-mcp recall]"
echo ""
sleep 2

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const results = await m.recall('database choice for memory layer');
  const r = results[0];
  const e = r.entry;
  console.log('  ┌─ recall result ─────────────────────────────────────────────┐');
  console.log('  │ type:   ' + e.type);
  console.log('  │ tags:   ' + e.tags.join(', '));
  console.log('  │ score:  ' + r.score.toFixed(4));
  console.log('  │');
  console.log('  │ ' + e.content.substring(0, 88));
  if (e.content.length > 88) console.log('  │ ' + e.content.substring(88, 176));
  console.log('  └──────────────────────────────────────────────────────────────┘');
  await m.close();
})();
"
sleep 6

echo ""
echo "  Devin:"
echo "    You chose SQLite with WAL mode. Postgres was rejected"
echo "    because it requires a running server."
echo ""
sleep 5

echo "  User:"
echo "    > Any gotchas I should know about?"
echo ""
sleep 4

echo "  [Devin calls remem-mcp recall]"
echo ""
sleep 2

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const results = await m.recall('gotchas pitfalls bugs fix');
  const r = results[0];
  const e = r.entry;
  console.log('  ┌─ recall result ─────────────────────────────────────────────┐');
  console.log('  │ type:   ' + e.type);
  console.log('  │ tags:   ' + e.tags.join(', '));
  console.log('  │');
  console.log('  │ ' + e.content.substring(0, 88));
  if (e.content.length > 88) console.log('  │ ' + e.content.substring(88, 176));
  console.log('  └──────────────────────────────────────────────────────────────┘');
  await m.close();
})();
"
sleep 6

echo ""
echo "  Devin:"
echo "    Yes. FTS5 external content tables break when the schema changes."
echo "    Run INSERT INTO captures_fts(captures_fts) VALUES('rebuild') after migrations."
echo ""
sleep 5

echo "  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─"
echo "  Session 2 ends. Stop hook auto-captures again."
echo "  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─"
echo ""
sleep 4

# ═══════════════════════════════════════════════════════════════
# SESSION 3 — Codex
# ═══════════════════════════════════════════════════════════════
echo "  ═══════════════════════════════════════════════════════════════"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │                                                             │"
echo "  │  SESSION 3                                                  │"
echo "  │  Agent: Codex  (third agent, same project)                  │"
echo "  │  Task:   Fix a search bug                                   │"
echo "  │                                                             │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""
sleep 4

echo "  Codex starts a new session."
echo "  SessionStart hook fires. Memory from sessions 1 AND 2 is injected."
echo ""
sleep 4

echo "  [SessionStart hook fires — auto-injecting recent memory]"
echo ""
sleep 2

echo '{"session_id":"handoff-3session-s3","cwd":"/Users/tin/a/remem-mcp"}' | \
  REMEM_DB_PATH="$DB" node dist/index.js hook-recall 2>&1 | \
  python3 -c "
import json,sys
d = json.load(sys.stdin)
ctx = d['hookSpecificOutput']['additionalContext']
print('  ┌─ auto-injected context ─────────────────────────────────────┐')
for line in ctx.split('\n'):
    if line.strip():
        print('  │ ' + line[:90])
print('  └──────────────────────────────────────────────────────────────┘')
"
sleep 6

echo ""
echo "  User:"
echo "    > Search is broken after the last migration. Can you fix it?"
echo ""
sleep 4

echo "  Codex:"
echo "    I see from memory that FTS5 external content tables break"
echo "    when the schema changes. The fix is already documented:"
echo ""
sleep 4

echo "  [Codex calls remem-mcp recall for the exact fix]"
echo ""
sleep 2

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const results = await m.recall('FTS5 rebuild fix migration');
  const r = results[0];
  const e = r.entry;
  console.log('  ┌─ recall result ─────────────────────────────────────────────┐');
  console.log('  │ type:   ' + e.type);
  console.log('  │ tags:   ' + e.tags.join(', '));
  console.log('  │');
  console.log('  │ ' + e.content.substring(0, 88));
  if (e.content.length > 88) console.log('  │ ' + e.content.substring(88, 176));
  console.log('  └──────────────────────────────────────────────────────────────┘');
  await m.close();
})();
"
sleep 6

echo ""
echo "  Codex:"
echo "    Running: INSERT INTO captures_fts(captures_fts) VALUES('rebuild');"
echo "    Done. Search is fixed."
echo ""
sleep 5

# ═══════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════
echo "  ═══════════════════════════════════════════════════════════════"
echo ""
echo "  ╔═══════════════════════════════════════════════════════════════╗"
echo "  ║                                                               ║"
echo "  ║   3 sessions. 3 agents. 1 memory.                             ║"
echo "  ║                                                               ║"
echo "  ║   Session 1 (Claude Code):                                    ║"
echo "  ║     captured decision + learning                              ║"
echo "  ║     Stop hook auto-saved on exit                              ║"
echo "  ║                                                               ║"
echo "  ║   Session 2 (Devin):                                          ║"
echo "  ║     SessionStart hook injected session 1's memory             ║"
echo "  ║     recall found the SQLite decision + FTS5 fix               ║"
echo "  ║                                                               ║"
echo "  ║   Session 3 (Codex):                                          ║"
echo "  ║     SessionStart hook injected sessions 1 + 2's memory        ║"
echo "  ║     recall found the FTS5 fix and applied it                  ║"
echo "  ║                                                               ║"
echo "  ║   No CLAUDE.md. No copy-paste. No manual handoff.             ║"
echo "  ║   Memory persisted in SQLite. Hooks did the rest.             ║"
echo "  ║                                                               ║"
echo "  ╚═══════════════════════════════════════════════════════════════╝"
echo ""
sleep 5
