#!/usr/bin/env bash
# Continuous local e2e loop — runs the full-stack smoke test repeatedly,
# hunting for flaky/racy failures. Everything on 127.0.0.1; no egress.
#
# Usage:
#   bash scripts/e2e-loop.sh            # 10 iterations (default)
#   bash scripts/e2e-loop.sh 50         # 50 iterations
#   bash scripts/e2e-loop.sh 0          # loop until first failure (Ctrl-C to stop)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ITERATIONS="${1:-10}"
LOG_DIR="$(mktemp -d -t beam-e2e-loop)"
echo "e2e loop: iterations=${ITERATIONS} (0 = until failure), logs in ${LOG_DIR}"

i=0
pass=0
fail=0
while :; do
  i=$((i+1))
  if [ "$ITERATIONS" -gt 0 ] && [ "$i" -gt "$ITERATIONS" ]; then break; fi
  LOG="$LOG_DIR/run-$i.log"
  printf 'run %-3d ... ' "$i"
  if node e2e-smoke.mjs >"$LOG" 2>&1; then
    pass=$((pass+1))
    echo "PASS"
    rm -f "$LOG"
  else
    fail=$((fail+1))
    echo "FAIL — log kept at $LOG"
    tail -25 "$LOG" | sed 's/^/    /'
    if [ "$ITERATIONS" -eq 0 ]; then break; fi
  fi
done

echo
echo "e2e loop finished: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
