#!/usr/bin/env python3
# split-results.py — Split benchmark results into N chunks for parallel LLM judging.
# Usage: python3 split-results.py <results.json> <num_chunks> <output_prefix>
# Output: <output_prefix>_0.json, <output_prefix>_1.json, ...
import json, sys, os

results_path = sys.argv[1]
num_chunks = int(sys.argv[2])
output_prefix = sys.argv[3]

with open(results_path) as f:
    data = json.load(f)

# Handle different formats
if isinstance(data, list):
    items = data
elif isinstance(data, dict) and 'results' in data:
    items = data['results']
else:
    items = [data]

chunk_size = (len(items) + num_chunks - 1) // num_chunks
for i in range(num_chunks):
    chunk = items[i * chunk_size : (i + 1) * chunk_size]
    out = f"{output_prefix}_{i}.json"
    # Simplify each item to just: question, answer, searchResults
    simplified = []
    for item in chunk:
        simplified.append({
            "question": item.get("question", ""),
            "answer": item.get("answer") or item.get("groundTruth", ""),
            "question_type": item.get("question_type", ""),
            "searchResults": [r.get("content", r.get("memory", "")) if isinstance(r, dict) else str(r)
                              for r in (item.get("searchResults") or item.get("results") or [])][:5],
        })
    with open(out, "w") as f:
        json.dump(simplified, f, indent=2)
    print(f"{out}: {len(simplified)} items")
