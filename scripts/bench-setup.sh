#!/bin/bash
# bench-setup.sh — One-time setup for all benchmarks.
# Clones repos, downloads datasets, creates adapters.
#
# Usage: bash scripts/bench-setup.sh
set -euo pipefail

PROJECT_ROOT="/Users/tin/a/remem-mcp"
BENCH_ROOT="/tmp/memory-benchmarks"
AMB_REPO="/tmp/amb-repo"
LOCOMO_BENCH="/tmp/locomo-bench"
LOCOMO_DATA="/tmp/locomo/data/locomo10.json"
PERSONAMEM_DIR="/tmp/personamem"
LONGMEMEVAL_DIR="/tmp/longmemeval"
HTTP_SERVER="$PROJECT_ROOT/scripts/bench-http-server.js"

log() { echo "[setup] $*"; }

# ─── 1. Build remem-mcp ─────────────────────────────────────────
log "Building remem-mcp..."
cd "$PROJECT_ROOT"
npm run build 2>&1 | tail -1
log "Build OK"

# ─── 2. AMB (Agent Memory Benchmark) ────────────────────────────
if [ ! -d "$AMB_REPO" ]; then
  log "Cloning Agent Memory Benchmark..."
  git clone https://github.com/AlekseiMarchenko/agent-memory-benchmark "$AMB_REPO" 2>&1 | tail -3
  cd "$AMB_REPO"
  npm install 2>&1 | tail -3
else
  log "AMB repo exists at $AMB_REPO"
fi

# ─── 3. Mem0 memory-benchmarks ──────────────────────────────────
if [ ! -d "$BENCH_ROOT" ]; then
  log "Cloning mem0ai/memory-benchmarks..."
  git clone https://github.com/mem0ai/memory-benchmarks "$BENCH_ROOT" 2>&1 | tail -3
  cd "$BENCH_ROOT"
  pip install -e . 2>&1 | tail -5 || pip3 install -e . 2>&1 | tail -5 || true
else
  log "memory-benchmarks repo exists at $BENCH_ROOT"
fi

# ─── 4. LoCoMo data ─────────────────────────────────────────────
if [ ! -f "$LOCOMO_DATA" ]; then
  log "Downloading LoCoMo dataset..."
  mkdir -p /tmp/locomo/data
  # LoCoMo from snap-research/locomo (ACL 2024) — shallow clone, sparse checkout data/ only
  if [ ! -d /tmp/locomo-repo ]; then
    git clone --depth 1 --filter=blob:none --sparse \
      https://github.com/snap-research/locomo /tmp/locomo-repo 2>&1 | tail -3 || true
    cd /tmp/locomo-repo
    git sparse-checkout set data 2>&1 || true
  fi
  # Copy the data file
  cp /tmp/locomo-repo/data/locomo10.json "$LOCOMO_DATA" 2>/dev/null || true
  if [ ! -f "$LOCOMO_DATA" ]; then
    log "WARNING: LoCoMo data not found. LoCoMo benchmark will be skipped."
    log "  Manual download: https://github.com/snap-research/locomo"
  fi
else
  log "LoCoMo data exists"
fi

# ─── 5. PersonaMem ──────────────────────────────────────────────
if [ ! -d "$PERSONAMEM_DIR" ] || [ ! -f "$PERSONAMEM_DIR/questions_32k.csv" ]; then
  log "Setting up PersonaMem..."
  mkdir -p "$PERSONAMEM_DIR"
  # Data is on HuggingFace (not in GitHub repo — repo only has sample questions)
  # https://huggingface.co/datasets/bowen-upenn/PersonaMem
  if [ ! -f "$PERSONAMEM_DIR/questions_32k.csv" ]; then
    log "  Downloading questions_32k.csv from HuggingFace..."
    curl -sL "https://huggingface.co/datasets/bowen-upenn/PersonaMem/resolve/main/questions_32k.csv" \
      -o "$PERSONAMEM_DIR/questions_32k.csv" 2>&1 || true
  fi
  if [ ! -f "$PERSONAMEM_DIR/shared_contexts_32k.jsonl" ]; then
    log "  Downloading shared_contexts_32k.jsonl from HuggingFace (may be large)..."
    curl -sL "https://huggingface.co/datasets/bowen-upenn/PersonaMem/resolve/main/shared_contexts_32k.jsonl" \
      -o "$PERSONAMEM_DIR/shared_contexts_32k.jsonl" 2>&1 || true
  fi
  if [ ! -f "$PERSONAMEM_DIR/questions_32k.csv" ]; then
    log "WARNING: PersonaMem questions_32k.csv not found. PersonaMem will be skipped."
    log "  Manual: https://huggingface.co/datasets/bowen-upenn/PersonaMem"
  fi
else
  log "PersonaMem data exists"
fi

# Create PersonaMem adapter if not exists
if [ ! -f "$PERSONAMEM_DIR/personamem-bench.ts" ]; then
  log "Creating PersonaMem adapter..."
  cat > "$PERSONAMEM_DIR/personamem-bench.ts" << 'ADAPTER'
// personamem-bench.ts — PersonaMem adapter for remem-mcp.
// Ingests conversation context, searches with question, checks if results
// contain unique keywords from the correct answer.
import { Memory } from "/Users/tin/a/remem-mcp/dist/sdk.js";
import { readFileSync } from "fs";
import { join } from "path";

const DIR = "/tmp/personamem";
const SAMPLE = parseInt(process.argv[2]?.match(/\d+/)?.[0] || "50", 10);

const mem = new Memory({ dbPath: "/tmp/remem-bench/personamem.db" });

interface Question {
  question: string;
  answer: string;
  persona: string;
  context_id: string;
}

function loadQuestions(): Question[] {
  // Try CSV format first
  try {
    const csv = readFileSync(join(DIR, "questions_32k.csv"), "utf-8");
    const lines = csv.trim().split("\n");
    const header = lines[0].split(",");
    const qIdx = header.findIndex(h => h.includes("question"));
    const aIdx = header.findIndex(h => h.includes("answer"));
    const pIdx = header.findIndex(h => h.includes("persona") || h.includes("context"));
    return lines.slice(1).map(line => {
      const cols = parseCSVLine(line);
      return {
        question: cols[qIdx] || "",
        answer: cols[aIdx] || "",
        persona: cols[pIdx] || "default",
        context_id: cols[pIdx] || "default",
      };
    });
  } catch {
    // Try JSONL
    try {
      const jsonl = readFileSync(join(DIR, "questions.jsonl"), "utf-8");
      return jsonl.trim().split("\n").map(l => JSON.parse(l));
    } catch {
      console.error("No PersonaMem data found in", DIR);
      return [];
    }
  }
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { result.push(current); current = ""; continue; }
    current += c;
  }
  result.push(current);
  return result;
}

function loadContexts(): Map<string, string> {
  const contexts = new Map<string, string>();
  try {
    const jsonl = readFileSync(join(DIR, "shared_contexts_32k.jsonl"), "utf-8");
    for (const line of jsonl.trim().split("\n")) {
      const obj = JSON.parse(line);
      const id = obj.context_id || obj.persona || obj.id;
      const text = obj.context || obj.text || obj.conversation || JSON.stringify(obj);
      contexts.set(id, text);
    }
  } catch {
    console.error("No contexts file found");
  }
  return contexts;
}

function extractKeywords(text: string): string[] {
  const stop = new Set(["the","a","an","is","are","was","were","be","been","being",
    "have","has","had","do","does","did","will","would","could","should","may",
    "might","must","can","to","of","in","on","at","by","for","with","about",
    "against","between","into","through","during","before","after","above",
    "below","from","up","down","out","off","over","under","again","further",
    "then","once","here","there","when","where","why","how","all","any","both",
    "each","few","more","most","other","some","such","no","nor","not","only",
    "own","same","so","than","too","very","what","which","who","whom","this",
    "that","these","those","i","you","he","she","it","we","they","them",
    "their","there","its","his","her","our","your","my","me","him","us",
    "and","or","but","if","because","as","until","while","also","just"]);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i);
}

async function main() {
  const questions = loadQuestions();
  const contexts = loadContexts();
  console.log(`Loaded ${questions.length} questions, ${contexts.size} contexts`);

  if (questions.length === 0) {
    console.log("PERSONAMEM_SCORE=0");
    return;
  }

  // Sample
  const sample = questions.slice(0, Math.min(SAMPLE, questions.length));
  console.log(`Testing ${sample.length} questions (sample=${SAMPLE})`);

  // Group by context_id and ingest
  const byContext = new Map<string, Question[]>();
  for (const q of sample) {
    const key = q.context_id || q.persona;
    if (!byContext.has(key)) byContext.set(key, []);
    byContext.get(key)!.push(q);
  }

  // Ingest contexts
  let ingested = 0;
  for (const [ctxId, qs] of byContext) {
    const ctxText = contexts.get(ctxId) || "";
    if (ctxText) {
      await mem.capture(ctxText, "conversation", ["personamem", ctxId], {
        sessionKey: `personamem-${ctxId}`,
      });
      ingested++;
    }
  }
  console.log(`Ingested ${ingested} contexts`);

  // Test each question
  let correct = 0;
  for (const q of sample) {
    const ctxId = q.context_id || q.persona;
    const results = await mem.search(q.question, {
      topK: 5,
      sessionKey: `personamem-${ctxId}`,
    });

    const answerKeywords = extractKeywords(q.answer).slice(0, 5);
    if (answerKeywords.length === 0) { correct++; continue; }

    const resultText = (results || []).map(r => r.content || r.text || "").join(" ").toLowerCase();
    const matched = answerKeywords.filter(kw => resultText.includes(kw));
    const matchRatio = matched.length / answerKeywords.length;

    if (matchRatio >= 0.4) correct++;
  }

  const score = Math.round((correct / sample.length) * 100);
  console.log(`\nPersonaMem Score: ${correct}/${sample.length} = ${score}%`);
  console.log(`PERSONAMEM_SCORE=${score}`);

  // Write results
  const { writeFileSync } = await import("fs");
  writeFileSync(join(DIR, "results.json"), JSON.stringify({
    score, correct, total: sample.length, sample: SAMPLE,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
ADAPTER
fi

# ─── 6. LongMemEval ─────────────────────────────────────────────
if [ ! -d "$LONGMEMEVAL_DIR" ]; then
  log "Setting up LongMemEval..."
  mkdir -p "$LONGMEMEVAL_DIR/data"
  # Download from HuggingFace
  for variant in oracle s_cleaned m_cleaned; do
    if [ ! -f "$LONGMEMEVAL_DIR/data/longmemeval_${variant}.json" ]; then
      log "  Downloading longmemeval_${variant}.json..."
      curl -sL "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_${variant}.json" \
        -o "$LONGMEMEVAL_DIR/data/longmemeval_${variant}.json" 2>&1 || true
    fi
  done
else
  log "LongMemEval dir exists"
fi

# Create LongMemEval adapter if not exists
if [ ! -f "$LONGMEMEVAL_DIR/longmemeval-bench.ts" ]; then
  log "Creating LongMemEval adapter..."
  cat > "$LONGMEMEVAL_DIR/longmemeval-bench.ts" << 'ADAPTER'
// longmemeval-bench.ts — LongMemEval adapter for remem-mcp.
// Ingests haystack sessions, searches with question, checks if results
// contain keywords from the ground-truth answer.
import { Memory } from "/Users/tin/a/remem-mcp/dist/sdk.js";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DIR = "/tmp/longmemeval";
const args = process.argv.slice(2);
const SAMPLE = parseInt(args.find(a => a.startsWith("--sample="))?.split("=")[1] || "100", 10);
const VARIANT = args.find(a => a.startsWith("--variant="))?.split("=")[1] || "oracle";

const mem = new Memory({ dbPath: "/tmp/remem-bench/longmemeval.db" });

interface LongMemEvalQuestion {
  question: string;
  answer: string;
  question_type: string;
  haystack_sessions: Array<{ 
    session_id?: string;
    messages?: Array<{ role: string; content: string }>;
    date?: string;
  }>;
}

function loadData(): LongMemEvalQuestion[] {
  const path = join(DIR, "data", `longmemeval_${VARIANT}.json`);
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    console.error(`Cannot load ${path}`);
    return [];
  }
}

function extractKeywords(text: string): string[] {
  const stop = new Set(["the","a","an","is","are","was","were","be","been","being",
    "have","has","had","do","does","did","will","would","could","should","may",
    "might","must","can","to","of","in","on","at","by","for","with","about",
    "against","between","into","through","during","before","after","above",
    "below","from","up","down","out","off","over","under","again","further",
    "then","once","here","there","when","where","why","how","all","any","both",
    "each","few","more","most","other","some","such","no","nor","not","only",
    "own","same","so","than","too","very","what","which","who","whom","this",
    "that","these","those","i","you","he","she","it","we","they","them",
    "their","there","its","his","her","our","your","my","me","him","us",
    "and","or","but","if","because","as","until","while","also","just",
    "yes","no","maybe","like","want","wants","wanted","know","think","said"]);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i);
}

async function main() {
  const data = loadData();
  console.log(`LongMemEval (${VARIANT}): ${data.length} questions, sampling ${SAMPLE}`);

  if (data.length === 0) {
    console.log("LONGMEMEVAL_SCORE=0");
    return;
  }

  const sample = data.slice(0, Math.min(SAMPLE, data.length));

  // Score by type
  const byType: Record<string, { correct: number; total: number }> = {};
  const results: any[] = [];
  let correct = 0;

  for (let i = 0; i < sample.length; i++) {
    const q = sample[i];
    const qType = q.question_type || "unknown";
    if (!byType[qType]) byType[qType] = { correct: 0, total: 0 };
    byType[qType].total++;

    // Ingest haystack sessions
    const sessions = q.haystack_sessions || [];
    for (const session of sessions) {
      const messages = session.messages || [];
      const text = messages.map(m => `[${m.role}] ${m.content}`).join("\n");
      const date = session.date || "";
      const captureText = date ? `[Date: ${date}] ${text}` : text;
      await mem.capture(captureText, "conversation", ["longmemeval", qType], {
        sessionKey: `longmemeval-${i}`,
      });
    }

    // Search with question
    const searchResults = await mem.search(q.question, {
      topK: 5,
      sessionKey: `longmemeval-${i}`,
    });

    // Check if answer keywords are in results
    const answerKeywords = extractKeywords(q.answer).slice(0, 5);
    const resultText = (searchResults || [])
      .map(r => r.content || r.text || "")
      .join(" ")
      .toLowerCase();
    const matched = answerKeywords.filter(kw => resultText.includes(kw));
    const matchRatio = answerKeywords.length > 0 ? matched.length / answerKeywords.length : 0;
    const isCorrect = matchRatio >= 0.4;

    if (isCorrect) {
      correct++;
      byType[qType].correct++;
    }

    results.push({
      question: q.question,
      answer: q.answer,
      question_type: qType,
      predicted_correct: isCorrect,
      matched_keywords: matched,
    });

    if ((i + 1) % 20 === 0) {
      console.log(`  ${i + 1}/${sample.length}...`);
    }
  }

  const score = Math.round((correct / sample.length) * 100);
  console.log(`\nLongMemEval Score: ${correct}/${sample.length} = ${score}%`);
  console.log(`\nBy type:`);
  for (const [type, s] of Object.entries(byType).sort()) {
    const pct = Math.round((s.correct / s.total) * 100);
    console.log(`  ${type}: ${s.correct}/${s.total} = ${pct}%`);
  }
  console.log(`\nLONGMEMEVAL_SCORE=${score}`);

  writeFileSync(join(DIR, "results.json"), JSON.stringify({
    score, correct, total: sample.length, variant: VARIANT, byType, results,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
ADAPTER
fi

# ─── 7. LoCoMo bench adapter ────────────────────────────────────
if [ ! -d "$LOCOMO_BENCH" ]; then
  log "Creating LoCoMo bench adapter..."
  mkdir -p "$LOCOMO_BENCH"
  cat > "$LOCOMO_BENCH/run.ts" << 'ADAPTER'
// run.ts — LoCoMo benchmark adapter for remem-mcp.
import { Memory } from "/Users/tin/a/remem-mcp/dist/sdk.js";
import { readFileSync, writeFileSync } from "fs";

const DATA = "/tmp/locomo/data/locomo10.json";
const OUT = "/tmp/locomo-bench/results.json";

const mem = new Memory({ dbPath: "/tmp/remem-bench/locomo.db" });

function extractKeywords(text: string): string[] {
  const stop = new Set(["the","a","an","is","are","was","were","be","been",
    "have","has","had","do","does","did","will","would","could","should",
    "to","of","in","on","at","by","for","with","about","from","up","down",
    "out","off","over","under","here","there","when","where","why","how",
    "all","any","both","each","some","such","not","only","same","than",
    "too","very","what","which","who","whom","this","that","these","those",
    "i","you","he","she","it","we","they","them","their","its","his","her",
    "and","or","but","if","because","as","while","also","just"]);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i);
}

async function main() {
  const data = JSON.parse(readFileSync(DATA, "utf-8"));
  const conversations = Array.isArray(data) ? data : [data];
  const results: any[] = [];

  for (let ci = 0; ci < conversations.length; ci++) {
    const conv = conversations[ci];
    const convId = conv.conversation_id || conv.id || `conv-${ci}`;
    const sessions = conv.conversation || conv.sessions || [];
    const qaPairs = conv.qa_pairs || conv.qa || [];

    // Ingest sessions
    for (const session of sessions) {
      const messages = session.messages || session.dialogue || [];
      const text = messages.map((m: any) =>
        `[${m.role || m.speaker || "user"}] ${m.content || m.utterance || ""}`
      ).join("\n");
      const date = session.date || session.timestamp || "";
      const captureText = date ? `[Date: ${date}] ${text}` : text;
      await mem.capture(captureText, "conversation", ["locomo", convId], {
        sessionKey: `locomo-${convId}`,
      });
    }

    // Answer questions
    for (const qa of qaPairs) {
      const question = qa.question || qa.q || "";
      const answer = qa.answer || qa.a || "";
      const category = qa.category || qa.type || "unknown";

      const searchResults = await mem.search(question, {
        topK: 5,
        sessionKey: `locomo-${convId}`,
      });

      const answerKeywords = extractKeywords(answer).slice(0, 3);
      const resultText = (searchResults || [])
        .map(r => r.content || r.text || "")
        .join(" ")
        .toLowerCase();
      const found = answerKeywords.some(kw => resultText.includes(kw));

      results.push({
        question, groundTruth: answer, category,
        searchResults: searchResults || [],
        correct: found,
      });
    }
  }

  const correct = results.filter(r => r.correct).length;
  const score = Math.round((correct / results.length) * 100);
  console.log(`LoCoMo: ${correct}/${results.length} = ${score}%`);

  writeFileSync(OUT, JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
ADAPTER
else
  log "LoCoMo bench exists"
fi

# ─── 8. Summary ─────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  BENCHMARK SETUP COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo "  AMB:          $AMB_REPO"
echo "  Mem0 bench:   $BENCH_ROOT"
echo "  LoCoMo:       $LOCOMO_BENCH (data: $LOCOMO_DATA)"
echo "  PersonaMem:   $PERSONAMEM_DIR"
echo "  LongMemEval:  $LONGMEMEVAL_DIR"
echo "  HTTP server:  $HTTP_SERVER"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Now run: bash scripts/loop-unified.sh"
