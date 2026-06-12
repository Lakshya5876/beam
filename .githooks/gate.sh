#!/usr/bin/env bash
# gate.sh — the shared gate script. pre-commit, pre-push, /review, and CI all
# call THIS file; "blocks" in CLAUDE.md is mechanical because git runs this,
# not because the model volunteers it.
#
# Modes:
#   commit         (default) gate the commit being created (scan = INDEX tree)
#   full           gate HEAD + working state (CI / manual)
#   report         print the last script-generated GATE REPORT verbatim
#   review-receipt write the /review pass receipt at the current fingerprint
#
# CRASH GUARD CONTRACT: callers treat ANY non-zero exit — deliberate block,
# missing dependency, scripting error — as a BLOCK. This script never needs
# a specific exit code to mean "blocked".
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
STATE_FILE=".claude/gate_state.json"
REPORT_FILE=".claude/last_gate_report.txt"
MODE="${1:-commit}"
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904

# ---------------------------------------------------------------- state I/O
bootstrap_state() {
  [ -f "$STATE_FILE" ] && return 0
  mkdir -p .claude
  cat > "$STATE_FILE" <<'JSON'
{
  "receipts": {},
  "last_pass_sha": null,
  "config": {
    "TEST_CMD": "npx vitest run",
    "LINT_CMD": "npx eslint",
    "TYPECHECK_CMD": "npx tsc --noEmit",
    "COVERAGE_THRESHOLD": 80,
    "COMPLEXITY_THRESHOLD": 10,
    "SUITE_TIME_THRESHOLD_S": 60
  },
  "suite_wall_times": []
}
JSON
}

state_get() { # $1 = dot path; prints scalar or JSON, empty if absent/null
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    let v = j;
    for (const k of process.argv[2].split(".")) { if (v == null) break; v = v[k]; }
    if (v == null) process.exit(0);
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$STATE_FILE" "$1"
}

state_set() { # $1 = dot path, $2 = JSON value — ATOMIC (write tmp + rename)
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const path = process.argv[2].split(".");
    let o = j;
    for (let i = 0; i < path.length - 1; i++) { o[path[i]] ??= {}; o = o[path[i]]; }
    o[path[path.length - 1]] = JSON.parse(process.argv[3]);
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
    fs.renameSync(tmp, f);
  ' "$STATE_FILE" "$1" "$2"
}

now_iso() { date -u +%FT%TZ; }
head_or_empty() { git rev-parse --verify -q HEAD >/dev/null 2>&1 && echo HEAD || echo "$EMPTY_TREE"; }

# ------------------------------------------------------- TWO FINGERPRINT FORMS
# WORKING_TREE_FP keys ONLY the in-session ledger SKIP. COMMIT_TREE_FP keys
# pre-commit receipts; pre-push matches `git rev-parse HEAD^{tree}` against it.
# They are NEVER the same variable: once a commit lands the working tree goes
# clean and no working-tree fingerprint can ever match again — conflating the
# two makes pre-push block every legitimate push.
working_tree_fp() {
  local base; base="$(head_or_empty)"
  {
    git rev-parse "${base}^{tree}" 2>/dev/null || echo NO_HEAD
    git -c color.ui=false -c diff.noprefix=false -c diff.context=3 diff --no-ext-diff
    git -c color.ui=false -c diff.noprefix=false -c diff.context=3 diff --no-ext-diff --cached "$base"
    git ls-files -z --others --exclude-standard | sort -z | \
      while IFS= read -r -d '' f; do [ -f "$f" ] && shasum "$f"; done
  } | shasum | cut -d' ' -f1
}

commit_tree_fp() {
  # The tree of the commit being created: write-tree on the INDEX via a temp
  # index — never the working tree (git add -p makes them differ).
  local git_dir tmp_index tree
  git_dir="$(git rev-parse --git-dir)"
  tmp_index="$(mktemp)"
  if [ -f "$git_dir/index" ]; then cp "$git_dir/index" "$tmp_index"; fi
  tree="$(GIT_INDEX_FILE="$tmp_index" git write-tree)"
  rm -f "$tmp_index"
  echo "$tree"
}

# --------------------------------------------------------------- report + block
REPORT=""
note() { REPORT="${REPORT}  $1"$'\n'; }

emit_report() {
  {
    echo "GATE REPORT  (emitted by .githooks/gate.sh — never composed by the model)"
    printf '%s' "$REPORT"
    echo "  Total gate time: ~$(( $(date +%s) - GATE_START ))s"
  } | tee "$REPORT_FILE"
}

block() { # $1 severity, $2 message
  note "BLOCK [$1]: $2"
  emit_report
  echo "" >&2
  echo "GATE BLOCKED [$1]: $2" >&2
  # Deliberate block: last_pass_sha is NOT written (it is only written after
  # a fully passing run), so the next run re-takes the same change-set path.
  exit 1
}

GATE_START="$(date +%s)"

# ---------------------------------------------------------------- modes
bootstrap_state

if [ "$MODE" = "report" ]; then
  if [ -f "$REPORT_FILE" ]; then cat "$REPORT_FILE"; else echo "No gate report exists yet — the gate has never run."; fi
  exit 0
fi

if [ "$MODE" = "review-receipt" ]; then
  WORKING_TREE_FP="$(working_tree_fp)"
  state_set "receipts.review" "{\"fingerprint\": \"$WORKING_TREE_FP\", \"result\": \"pass\", \"ts\": \"$(now_iso)\"}"
  echo "review receipt written at fingerprint $WORKING_TREE_FP"
  exit 0
fi

# ---------------------------------------------------------------- fingerprints
WORKING_TREE_FP="$(working_tree_fp)"
if [ "$MODE" = "commit" ]; then
  COMMIT_TREE_FP="$(commit_tree_fp)"
else
  COMMIT_TREE_FP="$(git rev-parse 'HEAD^{tree}' 2>/dev/null || echo NO_HEAD)"
fi

# Ledger SKIP — keyed by WORKING_TREE_FP only. Identical fingerprint =
# identical state (committed + staged + unstaged + untracked) = a passed gate
# is still valid. SKIPS ARE LOUD.
PRIOR_FP="$(state_get receipts.session.working_tree_fp)"
PRIOR_RESULT="$(state_get receipts.session.result)"
if [ -n "$PRIOR_FP" ] && [ "$PRIOR_FP" = "$WORKING_TREE_FP" ] && [ "$PRIOR_RESULT" = "pass" ]; then
  note "audit:  SKIPPED — passed at this exact fingerprint ($(state_get receipts.session.ts))"
  note "review: SKIPPED — no changes since last pass"
  note "tests:  SKIPPED — fingerprint identical (incl. untracked files)"
  if [ "$MODE" = "commit" ]; then
    state_set "receipts.trees.$COMMIT_TREE_FP" "{\"result\": \"pass\", \"ts\": \"$(now_iso)\"}"
    state_set "receipts.commit" "{\"commit_tree_fp\": \"$COMMIT_TREE_FP\", \"result\": \"pass\", \"ts\": \"$(now_iso)\"}"
  fi
  emit_report
  exit 0
fi

# ---------------------------------------------------------------- change set
LAST_PASS_SHA="$(state_get last_pass_sha)"
if [ -z "$LAST_PASS_SHA" ] || [ "$LAST_PASS_SHA" = "null" ]; then
  # COLD START: the change set is ALL tracked + untracked files.
  # (git diff null..HEAD is a fatal error — this branch exists so the gate
  #  does not crash on the init verification commit itself.)
  CHANGED_FILES="$( { git ls-files; git ls-files --others --exclude-standard; } | sort -u )"
  note "change set: COLD START (last_pass_sha null) -> ALL tracked + untracked files"
else
  CHANGED_FILES="$( { git diff --name-only "$LAST_PASS_SHA" 2>/dev/null || true; \
                      git diff --name-only --cached "$(head_or_empty)"; \
                      git diff --name-only; \
                      git ls-files --others --exclude-standard; } | sort -u )"
  note "change set: since $LAST_PASS_SHA + staged + unstaged + untracked"
fi

CHANGED_SRC="$(echo "$CHANGED_FILES" | grep -E '^src/.*\.ts$' || true)"
CHANGED_CODE="$(echo "$CHANGED_FILES" | grep -E '\.(ts|js)$' || true)"

# ---------------------------------------------------------- AUDIT (index tree)
# SCAN TARGET in commit context = the INDEX (git grep --cached), never the
# working tree — git add -p makes them differ.
GREP_SRC="--cached"
[ "$MODE" = "full" ] && GREP_SRC=""

# CRITICAL: forbidden credential files entering the change set
FORBIDDEN="$(echo "$CHANGED_FILES" | grep -E '(^|/)\.env($|\.)|\.pem$|(^|/)id_rsa' | grep -v '\.env\.example$' || true)"
[ -n "$FORBIDDEN" ] && block "CRITICAL" "credential-pattern file in change set: $(echo "$FORBIDDEN" | tr '\n' ' ')"

# CRITICAL: secrets patterns in scanned content
if [ -n "$CHANGED_CODE" ]; then
  # POSIX ERE only — git grep -E has no \s/\b on stock macOS regex.
  HITS="$(git grep $GREP_SRC -nIE "(password|secret|api_key|apikey|access_token)[[:space:]]*[:=][[:space:]]*['\"][^'\"]+['\"]|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY" -- $CHANGED_CODE 2>/dev/null || true)"
  [ -n "$HITS" ] && block "CRITICAL" "secret pattern in scanned tree: $(echo "$HITS" | head -3)"
fi
note "audit:  secrets scan clean (target: $([ "$MODE" = "commit" ] && echo 'index tree' || echo 'HEAD+worktree'))"

# HIGH: injection vectors
if [ -n "$CHANGED_SRC" ]; then
  HITS="$(git grep $GREP_SRC -nE '(^|[^A-Za-z0-9_])eval\(|new Function\(' -- $CHANGED_SRC 2>/dev/null || true)"
  [ -n "$HITS" ] && block "HIGH" "injection vector: $(echo "$HITS" | head -3)"
fi

# HIGH: layer-boundary violations (CLAUDE.md §1) — each grep must find nothing
layer_check() { # $1 pathspec, $2 forbidden-import regex, $3 label
  local hits
  hits="$(git grep $GREP_SRC -nE "$2" -- "$1" 2>/dev/null || true)"
  [ -n "$hits" ] && block "HIGH" "layer violation ($3): $(echo "$hits" | head -3)"
  return 0
}
layer_check 'src/domain'         "from '\.\./(application|infrastructure|presentation)" 'domain imports outward'
layer_check 'src/application'    "from '\.\./presentation"                              'application imports presentation'
layer_check 'src/infrastructure' "from '\.\./(application|presentation)"                'infrastructure imports inward callers'
layer_check 'src/presentation'   "from '\.\./(infrastructure|domain)"                   'presentation must call application ONLY'
# HIGH: env access outside the single config module
HITS="$(git grep $GREP_SRC -n 'process\.env' -- 'src' ':!src/config.ts' 2>/dev/null || true)"
[ -n "$HITS" ] && block "HIGH" "process.env outside src/config.ts: $(echo "$HITS" | head -3)"
note "audit:  injection + layer-boundary + config-module checks clean"

# ----------------------------------------------------------------- LINTER
LINT_CMD="$(state_get config.LINT_CMD)"
if [ -z "$LINT_CMD" ]; then
  note "lint:   NO_LINTER — recorded loud, never silently skipped"
else
  if [ -n "$CHANGED_CODE" ]; then
    # shellcheck disable=SC2086
    $LINT_CMD $CHANGED_CODE || block "LINT" "$LINT_CMD failed on changed files"
    note "lint:   $LINT_CMD on $(echo "$CHANGED_CODE" | wc -l | tr -d ' ') changed file(s) — clean"
  else
    $LINT_CMD . || block "LINT" "$LINT_CMD failed"
    note "lint:   $LINT_CMD . — clean"
  fi
fi

# ----------------------------------------------------------- TYPE CHECKER
TYPECHECK_CMD="$(state_get config.TYPECHECK_CMD)"
if [ -z "$TYPECHECK_CMD" ]; then
  note "types:  NO_TYPECHECKER — recorded loud, never silently skipped"
else
  $TYPECHECK_CMD || block "TYPES" "$TYPECHECK_CMD failed (full project)"
  note "types:  $TYPECHECK_CMD (full project) — clean"
fi

# ------------------------------------------------------- COMPLEXITY GATE
COMPLEXITY_THRESHOLD="$(state_get config.COMPLEXITY_THRESHOLD)"
if [ -n "$CHANGED_SRC" ]; then
  # shellcheck disable=SC2086
  npx eslint --rule "{\"complexity\":[\"error\",$COMPLEXITY_THRESHOLD]}" $CHANGED_SRC \
    || block "COMPLEXITY" "function exceeds cyclomatic complexity $COMPLEXITY_THRESHOLD in changed files"
  note "cmplx:  cyclomatic <= $COMPLEXITY_THRESHOLD on changed src files — clean"
fi

# ------------------------------------------------- TESTS + COVERAGE + TIERS
TEST_CMD="$(state_get config.TEST_CMD)"
COVERAGE_THRESHOLD="$(state_get config.COVERAGE_THRESHOLD)"
SUITE_THRESHOLD="$(state_get config.SUITE_TIME_THRESHOLD_S)"
WALL_TIMES="$(state_get suite_wall_times)"
TIER_TRANSITION="$(node -e '
  const t = JSON.parse(process.argv[1] || "[]");
  const last2 = t.slice(-2);
  process.stdout.write(last2.length === 2 && last2.every(x => x > Number(process.argv[2])) ? "1" : "0");
' "$WALL_TIMES" "$SUITE_THRESHOLD")"

TIER_LABEL="TIER 3 (full suite — repo below the ${SUITE_THRESHOLD}s threshold)"
if [ "$TIER_TRANSITION" = "1" ]; then
  echo "TIER TRANSITION REQUIRED: full-suite wall time exceeded ${SUITE_THRESHOLD}s twice consecutively (Guide §6.2 T5)." >&2
  # Tier-2 algorithm: impact tooling first; none is installed yet, and until
  # the import graph exists Tier-2-degraded falls back ENTIRELY to a full
  # suite run to avoid coverage blind spots. grep is never the selector.
  TIER_LABEL="TIER 2 (degraded: no impact tooling / no import graph — FULL SUITE fallback; install real test-impact tooling now)"
  note "tests:  TIER TRANSITION REQUIRED — local full-suite default is no longer acceptable"
fi

TEST_START="$(date +%s)"
$TEST_CMD --coverage --coverage.thresholds.lines="$COVERAGE_THRESHOLD" \
  || block "TESTS" "suite or coverage gate (lines >= ${COVERAGE_THRESHOLD}%) failed"
TEST_WALL=$(( $(date +%s) - TEST_START ))
note "tests:  $TIER_LABEL — pass in ${TEST_WALL}s; coverage lines >= ${COVERAGE_THRESHOLD}%"

state_set "suite_wall_times" "$(node -e '
  const t = JSON.parse(process.argv[1] || "[]"); t.push(Number(process.argv[2]));
  process.stdout.write(JSON.stringify(t.slice(-5)));
' "$WALL_TIMES" "$TEST_WALL")"

# ------------------------------------------------- RECEIPTS (all checks green)
TS="$(now_iso)"
state_set "receipts.session" "{\"working_tree_fp\": \"$WORKING_TREE_FP\", \"result\": \"pass\", \"ts\": \"$TS\"}"
state_set "receipts.audit"   "{\"fingerprint\": \"$WORKING_TREE_FP\", \"result\": \"pass\", \"ts\": \"$TS\"}"
state_set "receipts.tests"   "{\"fingerprint\": \"$WORKING_TREE_FP\", \"result\": \"pass\", \"scope\": \"full\", \"suite_wall_time_s\": $TEST_WALL, \"ts\": \"$TS\"}"
if [ "$COMMIT_TREE_FP" != "NO_HEAD" ]; then
  state_set "receipts.trees.$COMMIT_TREE_FP" "{\"result\": \"pass\", \"ts\": \"$TS\"}"
  state_set "receipts.commit" "{\"commit_tree_fp\": \"$COMMIT_TREE_FP\", \"result\": \"pass\", \"ts\": \"$TS\"}"
fi

# last_pass_sha = HEAD is written ONLY here — after every check above exited 0.
# On a block we never reach this line, so the next run re-takes the cold-start
# (or stale-sha) path. On the unborn first commit HEAD does not exist yet;
# last_pass_sha stays null and the next run is cold-start again — honest.
if git rev-parse --verify -q HEAD >/dev/null 2>&1; then
  state_set "last_pass_sha" "\"$(git rev-parse HEAD)\""
fi

emit_report
exit 0
