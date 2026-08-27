# Gates: Dogfood remem-mcp v0.7.1 with Devin on large OSS repos

OWNS: GATES.md

Scope: Simulate a simple user flow — open 2 large repos (React 4373 files TS, AZR 493 files Go), ask Devin to find + explain code, verify recall + codegraph_search + capture work end-to-end via Devin CLI.

- [x] G1: Pre-index React reconciler (159 files, 497 symbols)
  CHECK: cd /data/projects/test-react && timeout 120 remem-mcp index --path packages/react-reconciler/src 2>&1 | grep "Done:" | head -1
  EXPECT: Done:
  EVIDENCE: Done: 159 files, 497 symbols, 1923 calls — exit 0

- [x] G2: Pre-index AZR Go repo (438 files, 3427 symbols)
  CHECK: cd /data/projects/azr && timeout 120 remem-mcp index --path internal 2>&1 | grep "Done:" | head -1
  EXPECT: Done:
  EVIDENCE: Done: 438 files, 3427 symbols, 41721 calls — exit 0

- [x] G3: React — Devin finds createFiber via codegraph_search and explains it
  CHECK: cd /data/projects/test-react && timeout 90 devin -p "Use codegraph_search to find createFiber. Explain what it does in 2 sentences." --permission-mode dangerous 2>&1 | grep -c "createFiber"
  EXPECT: 3
  EVIDENCE: 5 matches — Devin found createFiber at ReactFiber.js:299, explained dispatcher + FiberNode allocation

- [x] G4: React — Devin captures a learning after the task
  CHECK: cd /data/projects/test-react && timeout 90 devin -p "Use recall to find what you know about createFiber. Then capture a 1-sentence learning about what createFiber does." --permission-mode dangerous 2>&1 | grep -c "Captured:"
  EXPECT: 1
  EVIDENCE: Devin used recall (returned createFiber memory), then captured id 01M0XZA2075AKAD1WC10278GNG

- [x] G5: AZR (Go) — Devin finds RunMissionTick via codegraph_search
  CHECK: cd /data/projects/azr && timeout 90 devin -p "Use codegraph_search to find RunMissionTick. Explain what it does in 2 sentences." --permission-mode dangerous 2>&1 | grep -c "RunMissionTick"
  EXPECT: 1
  EVIDENCE: 1 match — Devin found RunMissionTick at mission.go:256, explained fan-out + bounded worker pool

- [x] G6: AZR (Go) — Devin finds callers of RunMissionTick
  CHECK: cd /data/projects/azr && timeout 90 devin -p "Use codegraph_search to find RunMissionTick, then use codegraph_callers to find who calls it. List the callers." --permission-mode dangerous 2>&1 | grep -ic "caller"
  EXPECT: 1
  EVIDENCE: 2 matches — Devin used codegraph_callers and listed callers

- [x] G7: recall() returns relevant memory from previous sessions
  CHECK: printf JSON-RPC | timeout 15 remem-mcp | grep -o resolveAllCalls
  EXPECT: resolveAllCalls
  EVIDENCE: resolveAllCalls — exit 0

- [x] G8: codegraph_search on remem-mcp repo returns instantly
  CHECK: printf JSON-RPC | timeout 15 remem-mcp | grep -o resolveAllCalls
  EXPECT: resolveAllCalls
  EVIDENCE: resolveAllCalls — exit 0
