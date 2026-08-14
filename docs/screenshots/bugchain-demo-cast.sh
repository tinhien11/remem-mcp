#!/bin/bash
# Bug fix chain demo: 3 sessions, 3 React fiber bugs, 1 memory
# Uses real React concepts (fiber reconciler, hooks, suspense)
# Real SDK calls, real SQLite, real hook-recall. Simulated agent dialogue.

DB="/tmp/remem-react-demo/memory.db"
PROJECT="/data/projects/remem-mcp"
rm -rf /tmp/remem-react-demo && mkdir -p /tmp/remem-react-demo

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
echo "  ║   Bug fix chain: 3 sessions, 3 React bugs, 1 memory           ║"
echo "  ║                                                               ║"
echo "  ║   Session 1: Agent fixes useState batching → captures         ║"
echo "  ║   Session 2: New agent → batching fix loaded → fixes          ║"
echo "  ║             useEffect cleanup race                            ║"
echo "  ║   Session 3: Another agent → both fixes loaded → fixes        ║"
echo "  ║             Suspense boundary edge case                       ║"
echo "  ║                                                               ║"
echo "  ╚═══════════════════════════════════════════════════════════════╝"
echo ""
sleep 4

# ═══════════════════════════════════════════════════════════════
# SESSION 1 — useState batching bug
# ═══════════════════════════════════════════════════════════════
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │                                                             │"
echo "  │  SESSION 1                                                  │"
echo "  │  Project: React (facebook/react)                            │"
echo "  │  Bug: useState not batching in concurrent mode              │"
echo "  │                                                             │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""
sleep 3

echo "  User:"
echo "    > Multiple setState calls in a handleClick are causing 3"
echo "    > re-renders instead of 1. This only happens in concurrent"
echo "    > mode. In legacy mode it batches fine."
echo ""
sleep 4

echo "  Agent:"
echo "    Let me check the fiber reconciler..."
sleep 2
echo ""
echo "    Found it. ReactFiberBeginWork.ts:842 checks"
echo "    executionContext & LegacyContext before batching."
echo "    In concurrent mode, the lane priority check skips"
echo "    the batch boundary. The fix is to always batch when"
echo "    inside a discrete event, regardless of execution context."
echo ""
sleep 5

echo "  [Agent captures the fix to memory]"
echo ""
sleep 2

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const id = await m.capture(
    'Bug fix: useState not batching in concurrent mode. ReactFiberBeginWork.ts:842 checked executionContext & LegacyContext before batching. In concurrent mode, lane priority check skipped the batch boundary. Fix: always batch when inside a discrete event (onClick, onChange), regardless of execution context. 47/47 tests pass.',
    'learning',
    ['bug-fix', 'useState', 'batching', 'concurrent-mode', 'fiber', 'ReactFiberBeginWork']
  );
  console.log('  Captured: ' + id);
  await m.close();
})();
"
sleep 3

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const id = await m.capture(
    'Decision: setState calls inside discrete events (onClick, onChange, onKeyDown) must always batch, even in concurrent mode. Legacy mode batches by default via executionContext. Concurrent mode uses lane priorities, which can skip the batch boundary if the event is not marked discrete. Fix in ReactFiberBeginWork.ts: check isDiscreteEvent before splitting the batch.',
    'decision',
    ['batching', 'concurrent-mode', 'discrete-event', 'fiber', 'React']
  );
  console.log('  Captured: ' + id);
  await m.close();
})();
"
sleep 3

echo ""
echo "  Agent:"
echo "    Fix deployed. 47/47 tests pass. PR #28431 opened."
echo "    Session done."
echo ""
sleep 4

echo "  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─"
echo "  Session 1 ends. Stop hook auto-captures."
echo "  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─"
echo ""
sleep 4

# ═══════════════════════════════════════════════════════════════
# SESSION 2 — useEffect cleanup race condition
# ═══════════════════════════════════════════════════════════════
echo "  ═══════════════════════════════════════════════════════════════"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │                                                             │"
echo "  │  SESSION 2                                                  │"
echo "  │  Agent: New session (previous context is gone)              │"
echo "  │  Bug: useEffect cleanup race condition                      │"
echo "  │                                                             │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""
sleep 4

echo "  New session starts."
echo "  SessionStart hook fires — memory from session 1 is injected."
echo ""
sleep 4

echo "  [SessionStart hook — auto-injecting recent memory]"
echo ""
sleep 2

echo '{"session_id":"react-demo-s2","cwd":"/Users/dev/react"}' | \
  TDAI_DB_PATH="$DB" node dist/index.js hook-recall 2>&1 | \
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
echo "    > useEffect cleanup runs after the next effect already"
echo "    > started. This causes a race — the cleanup aborts a"
echo "    > fetch that the new effect is waiting on."
echo ""
sleep 5

echo "  Agent:"
echo "    I see from memory that batching in concurrent mode was fixed"
echo "    in ReactFiberBeginWork. This is a different issue — the"
echo "    cleanup timing in the hook scheduler."
sleep 3
echo ""
echo "    Checking ReactFiberHooks.ts..."
echo "    The passive effect queue runs cleanup AFTER the next effect"
echo "    by default. The fix: run cleanup BEFORE the next effect"
echo "    when the effect has a destroy function."
echo ""
sleep 5

echo "  [Agent captures the fix to memory]"
echo ""
sleep 2

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const id = await m.capture(
    'Bug fix: useEffect cleanup race condition. ReactFiberHooks.ts passive effect queue ran cleanup AFTER the next effect started, causing the cleanup to abort a fetch the new effect was waiting on. Fix: run cleanup BEFORE the next effect when the effect has a destroy function. 23/23 tests pass.',
    'learning',
    ['bug-fix', 'useEffect', 'cleanup', 'race-condition', 'passive-effect', 'ReactFiberHooks']
  );
  console.log('  Captured: ' + id);
  await m.close();
})();
"
sleep 3

echo ""
echo "  Agent:"
echo "    Fix: run cleanup before the next effect, not after."
echo "    23/23 tests pass. PR #28445 opened."
echo ""
sleep 4

echo "  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─"
echo "  Session 2 ends. Stop hook auto-captures."
echo "  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─"
echo ""
sleep 4

# ═══════════════════════════════════════════════════════════════
# SESSION 3 — Suspense boundary edge case
# ═══════════════════════════════════════════════════════════════
echo "  ═══════════════════════════════════════════════════════════════"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │                                                             │"
echo "  │  SESSION 3                                                  │"
echo "  │  Agent: New session (sessions 1 and 2 are gone)             │"
echo "  │  Bug: Suspense boundary shows fallback too early            │"
echo "  │                                                             │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""
sleep 4

echo "  New session starts."
echo "  SessionStart hook fires — memory from sessions 1 AND 2 injected."
echo ""
sleep 4

echo "  [SessionStart hook — auto-injecting recent memory]"
echo ""
sleep 2

echo '{"session_id":"react-demo-s3","cwd":"/Users/dev/react"}' | \
  TDAI_DB_PATH="$DB" node dist/index.js hook-recall 2>&1 | \
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
echo "    > Suspense shows the fallback before the data even starts"
echo "    > loading. The user sees a flash of loading state."
echo ""
sleep 5

echo "  Agent:"
echo "    I see from memory that batching and useEffect cleanup are fixed."
echo "    This is a Suspense timing issue — different code path."
sleep 3
echo ""
echo "    Checking ReactFiberThrow.ts..."
echo "    The throw initiates a transition, but the boundary check"
echo "    in ReactFiberBeginWork does not check if the promise is"
echo "    already settled. If the data is cached, it still shows"
echo "    the fallback for one frame."
echo ""
sleep 5

echo "  [Agent recalls to check if this was seen before]"
echo ""
sleep 2

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const results = await m.recall('Suspense boundary fallback timing');
  if (results.length > 0) {
    const r = results[0];
    const e = r.entry;
    console.log('  ┌─ recall result ─────────────────────────────────────────────┐');
    console.log('  │ type:   ' + e.type);
    console.log('  │ tags:   ' + e.tags.join(', '));
    console.log('  │');
    console.log('  │ ' + e.content.substring(0, 88));
    if (e.content.length > 88) console.log('  │ ' + e.content.substring(88, 176));
    console.log('  └──────────────────────────────────────────────────────────────┘');
  } else {
    console.log('  No prior memory found. This is a new bug.');
  }
  await m.close();
})();
"
sleep 5

echo ""
echo "  Agent:"
echo "    No prior fix for this. The issue is in ReactFiberBeginWork:"
echo "    the boundary check does not skip the fallback when the"
echo "    promise is already resolved (cached data)."
sleep 3
echo ""
echo "    Fix: check if the thrown promise is already settled before"
echo "    showing the fallback. If settled, retry the render immediately"
echo "    instead of showing the fallback for one frame."
echo ""
sleep 5

echo "  [Agent captures the fix to memory]"
echo ""
sleep 2

node -e "
const { Memory } = require('./dist/sdk.js');
(async () => {
  const m = new Memory({ dbPath: '$DB' });
  const id = await m.capture(
    'Bug fix: Suspense boundary shows fallback too early. ReactFiberBeginWork boundary check did not skip fallback when the thrown promise was already settled (cached data). Fix: check if promise is resolved before showing fallback. If settled, retry render immediately. 31/31 tests pass.',
    'learning',
    ['bug-fix', 'Suspense', 'fallback', 'cached-data', 'ReactFiberBeginWork', 'concurrent-mode']
  );
  console.log('  Captured: ' + id);
  await m.close();
})();
"
sleep 3

echo ""
echo "  Agent:"
echo "    Fix deployed. 31/31 tests pass. PR #28452 opened."
echo ""
sleep 4

# ═══════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════
echo "  ═══════════════════════════════════════════════════════════════"
echo ""
echo "  ╔═══════════════════════════════════════════════════════════════╗"
echo "  ║                                                               ║"
echo "  ║   3 sessions. 3 React bugs. 1 memory.                         ║"
echo "  ║                                                               ║"
echo "  ║   Session 1:                                                   ║"
echo "  ║     Fixed useState batching in concurrent mode                ║"
echo "  ║     Captured: learning + decision                             ║"
echo "  ║                                                               ║"
echo "  ║   Session 2:                                                   ║"
echo "  ║     Started with batching fix already loaded                  ║"
echo "  ║     Did NOT re-investigate batching — went to cleanup         ║"
echo "  ║     Fixed: useEffect cleanup runs before next effect          ║"
echo "  ║                                                               ║"
echo "  ║   Session 3:                                                   ║"
echo "  ║     Started with both fixes loaded                            ║"
echo "  ║     Knew fiber hooks were fixed — looked at Suspense          ║"
echo "  ║     Fixed: skip fallback when promise is already settled      ║"
echo "  ║                                                               ║"
echo "  ║   Time saved: ~30 min per session (no re-investigation)       ║"
echo "  ║   Total: 4 captures, 1 recall, 0 re-discoveries               ║"
echo "  ║                                                               ║"
echo "  ╚═══════════════════════════════════════════════════════════════╝"
echo ""
sleep 5
