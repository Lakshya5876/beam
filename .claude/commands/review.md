# /review — Ledger-Aware Pre-PR Gate

Optional focus area: $ARGUMENTS

## STEP 0 — LEDGER CHECK (fingerprint recompute, never trust a stale receipt)
Recompute the FULL working-tree fingerprint exactly as gate.sh does
(Guide §4.2 — committed tree + pinned-config staged/unstaged diffs +
sorted shasums of UNTRACKED files):
```
bash -c 'source /dev/stdin <<<"$(sed -n "/^working_tree_fp()/,/^}/p" .githooks/gate.sh)"; working_tree_fp'
```
Compare against `review.fingerprint` in `.claude/gate_state.json`.
- EXACT match with result=pass -> SKIP LOUDLY: print the script-generated
  GATE REPORT VERBATIM (run `.githooks/gate.sh report`). A model-composed
  "GATE REPORT" is invalid by definition — never reconstruct one.
- Anything else (including "it was only a comment") -> full review below.

## STEP 1 — DIFF INVENTORY
```
git update-index -q --refresh; git diff --no-ext-diff
git diff --name-only; git diff --name-only --cached
git ls-files --others --exclude-standard
```
Every file must be explainable in one line. Unexplainable file = stop.

## STEP 2 — LOCKFILE ASSERTION
Any diff in `package.json` dependencies or `package-lock.json` WITHOUT an
explicitly human-approved dependency addition (CLAUDE.md §4 hard stop) =
**HARD STOP**. Report the exact added/changed packages.

## STEP 3 — PER-FILE LAYER COMPLIANCE
For each changed src file, verify against CLAUDE.md §1:
- src/domain/** imports nothing from other layers, no framework deps
- src/application/** imports domain + infrastructure interfaces only; no CLI/HTTP concepts
- src/infrastructure/** never imports application/presentation
- src/presentation/** imports application ONLY
- No process.env outside src/config.ts

## STEP 4 — SECRETS-IN-DIFF GREP (zero matches required)
```
git diff HEAD | grep -inE "password|secret|api_key|apikey|token|private key"
git ls-files --others --exclude-standard | grep -E "^\.env|\.pem$|id_rsa"
```

## STEP 5 — COVERAGE CHECK
Every NEW function in src/application/ or src/domain/ has a NAMED test in
its mirror module `tests/<layer>/<module>.test.ts` (N1); every new
infrastructure implementation has an integration test (N2). Then:
```
npx vitest run --coverage        # lines >= 80, exit 0
```

## STEP 6 — QUARANTINE REPORT
Print quarantine.txt count and the modules covered by each quarantined test.
A quarantined test covering a CORE_FILES module (CLAUDE.md §5) =
**HARD STOP**.

## STEP 7 — CONVENTIONAL-COMMIT CHECK
Every commit since the base branch matches `type(scope): imperative
description` with type in {feat, fix, refactor, test, perf, security, docs,
chore}.

## STEP 8 — PR BODY GENERATION
Generate: summary, change manifest table (File | Action | Layer), test
evidence (verbatim last run), hard stops encountered + approvals, quarantine
status. NOTE (CLAUDE.md §3 LOCAL-ONLY): the PR itself is opened by the
human from a plain shell — the agent only produces the body text.

## STEP 9 — RECEIPT
Finish by having the GATE SCRIPT write the new review receipt atomically:
```
.githooks/gate.sh review-receipt
```
Never hand-edit .claude/gate_state.json — it is written only by gate.sh.
