#!/usr/bin/env python3
# aggregate-judges.py — Aggregate YES/NO verdicts from 4 judge outputs.
# Usage: python3 aggregate-judges.py <judge_0.txt> <judge_1.txt> ... 
# Each judge file contains lines like "0: YES" or "3: NO" (index: verdict)
# Output: total score percentage
import sys, re

total = 0
correct = 0

for fpath in sys.argv[1:]:
    with open(fpath) as f:
        for line in f:
            line = line.strip().upper()
            # Match patterns: "0: YES", "Q0: YES", "1. YES", "YES", "NO"
            m = re.search(r'(?:Q)?(\d+)[:.]\s*(YES|NO)', line)
            if m:
                total += 1
                if m.group(2) == "YES":
                    correct += 1
            elif line in ("YES", "NO"):
                total += 1
                if line == "YES":
                    correct += 1

score = round(correct / total * 100) if total > 0 else 0
print(f"{correct}/{total} = {score}%")
print(f"JUDGE_SCORE={score}")
