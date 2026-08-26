# Gates: Install v0.7.1 + dogfood (fix #2 resolveAllCalls batch)

OWNS: src/codegraph/resolver.ts, src/codegraph/engine.ts, GATES.md

Scope: Fix resolveAllCalls hanging on 25K historical calls, rebuild, install, dogfood recall + codegraph_search + codegraph_callers via MCP stdio, run unit tests, commit, close issue #2.

- [x] G1: Build succeeds with no errors
  CHECK: cd /data/projects/remem-mcp && npm run build 2>&1 | tail -1
  EXPECT: ⚡️ Build success
  EVIDENCE: ESM ⚡️ Build success in 84ms — exit 0

- [x] G2: Global binary reports v0.7.1
  CHECK: remem-mcp version
  EXPECT: remem-mcp v0.7.1
  EVIDENCE: remem-mcp v0.7.1 — exit 0

- [x] G3: index CLI completes in under 30s (was hanging indefinitely)
  CHECK: cd /data/projects/remem-mcp && timeout 30 remem-mcp index --path src 2>&1 | tail -1
  EXPECT: ... and 32 more
  EVIDENCE: "  ... and 32 more" — exit 0, completed in <10s

- [x] G4: codegraph_search finds resolveAllCalls via MCP stdio
  CHECK: printf with \n-delimited JSON-RPC | timeout 15 remem-mcp | grep -o resolveAllCalls
  EXPECT: resolveAllCalls
  EVIDENCE: resolveAllCalls — exit 0

- [x] G5: recall() returns captures via MCP stdio
  CHECK: printf with \n-delimited JSON-RPC | timeout 15 remem-mcp | grep -o '"type":"text"'
  EXPECT: "type":"text"
  EVIDENCE: "type":"text" — exit 0

- [x] G6: Unit tests pass (v13 features)
  CHECK: cd /data/projects/remem-mcp && npx vitest run tests/unit/v13-features.test.ts 2>&1 | tail -5
  EXPECT: Test Files  1 passed
  EVIDENCE: Test Files 1 passed (1), 13 Tests passed — exit 0

- [x] G7: Git commit created for the fix
  CHECK: cd /data/projects/remem-mcp && git log --oneline -1
  EXPECT: fix: resolveAllCalls only resolve current batch (#2)
  EVIDENCE: 471fd0e fix: resolveAllCalls only resolve current batch (#2)
