#!/usr/bin/env python3
"""
Merge 3 asciinema casts into one with title cards + hook evidence panels.
Shows real hook log lines between sessions so viewer sees what hooks did.
"""
import json
import sys

def load_cast(path):
    with open(path) as f:
        lines = f.readlines()
    header = json.loads(lines[0].strip())
    events = []
    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        parts = json.loads(line)
        if isinstance(parts, list) and len(parts) >= 3:
            events.append(parts)
    return header, events

def make_panel(lines, delay=0.08, pause=2.0):
    """Create asciinema events from text lines."""
    events = []
    events.append([0.3, "o", "\x1b[2J\x1b[H"])
    for line in lines:
        events.append([delay, "o", line + "\r\n"])
    events.append([pause, "o", ""])
    return events

# Load sessions
h1, e1 = load_cast(sys.argv[1])
h2, e2 = load_cast(sys.argv[2])
h3, e3 = load_cast(sys.argv[3])

merged_header = {
    "version": 3,
    "term": {"cols": 80, "rows": 24},
    "timestamp": h1.get("timestamp", 0),
    "idle_time_limit": 3.0,
    "command": "merged demo",
    "env": h1.get("env", {})
}

all_events = []

# ── Intro ──
all_events.extend(make_panel([
    "\x1b[1m\x1b[36m  tdai-memory-mcp\x1b[0m",
    "\x1b[90m  ────────────────────────────────────────────\x1b[0m",
    "",
    "\x1b[90m  Watch a coding agent learn from its mistakes.\x1b[0m",
], pause=2.5))

# ── Session 1: Error occurs ──
all_events.extend(make_panel([
    "\x1b[1m\x1b[31m  Day 1 — Error occurs\x1b[0m",
    "\x1b[90m  ────────────────────────────────────────────\x1b[0m",
    "",
    "\x1b[90m  Agent runs: npm run build\x1b[0m",
], pause=2.0))

# Session 1 real output
all_events.extend(e1)

# ── Hook fires (natural terminal output) ──
all_events.extend(make_panel([
    "\x1b[90m  [tdai-memory] PostToolUse: auto-captured typecheck error\x1b[0m",
    "\x1b[90m    confidence=1  resolved=false\x1b[0m",
    "\x1b[90m    saved to memory.db\x1b[0m",
], pause=2.5))

# ── Session 2: Fix ──
all_events.extend(make_panel([
    "\x1b[1m\x1b[33m  Day 2 — Memory injected, fix applied\x1b[0m",
    "\x1b[90m  ────────────────────────────────────────────\x1b[0m",
    "",
    "\x1b[90m  New session. SessionStart loads recent memory.\x1b[0m",
], pause=2.0))

# Session 2 real output
all_events.extend(e2)

# ── Hook fires (natural) ──
all_events.extend(make_panel([
    "\x1b[90m  [tdai-memory] PreToolUse: injected 1 past error(s) before: npm run build\x1b[0m",
    "\x1b[90m  [tdai-memory] PostToolUse: success correlation — upvoted error\x1b[0m",
    "\x1b[90m    confidence: 1 → 5  resolved=true  fix recorded\x1b[0m",
], pause=2.5))

# ── Session 3: Right the first time ──
all_events.extend(make_panel([
    "\x1b[1m\x1b[32m  Day 3 — Right the first time\x1b[0m",
    "\x1b[90m  ────────────────────────────────────────────\x1b[0m",
    "",
    "\x1b[90m  SessionStart: loaded 10 captures\x1b[0m",
    "\x1b[90m  Agent already knows the fix.\x1b[0m",
], pause=2.0))

# Session 3 real output
all_events.extend(e3)

# ── Hook fires (natural) ──
all_events.extend(make_panel([
    "\x1b[90m  [tdai-memory] PreToolUse: 0 unresolved errors — nothing to inject\x1b[0m",
    "\x1b[90m  [tdai-memory] PostToolUse: build passed, confidence upvoted to 5\x1b[0m",
], pause=2.5))

# ── Outro: real DB state ──
all_events.extend(make_panel([
    "\x1b[1m\x1b[36m  tdai-memory-mcp status\x1b[0m",
    "\x1b[90m  ════════════════════════════════════════════\x1b[0m",
    "",
    "\x1b[1m  Errors captured:    \x1b[32m1\x1b[0m",
    "\x1b[1m  Errors resolved:    \x1b[32m1  (100%)\x1b[0m",
    "\x1b[1m  Confidence:         \x1b[32m1 → 5\x1b[0m",
    "\x1b[1m  Fix recorded:       \x1b[32mtrue\x1b[0m",
    "",
    "\x1b[90m  ────────────────────────────────────────────\x1b[0m",
    "",
    "\x1b[1m\x1b[32m  Your agent stops repeating the same mistakes.\x1b[0m",
], pause=3.5))

# Write
with open(sys.argv[4], 'w') as f:
    f.write(json.dumps(merged_header) + '\n')
    for ev in all_events:
        f.write(json.dumps(ev) + '\n')

print(f"Merged {len(e1)} + {len(e2)} + {len(e3)} agent events + evidence panels = {len(all_events)} total")
