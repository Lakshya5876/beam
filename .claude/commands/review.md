Pre-PR covenant for Beam. `$ARGUMENTS` unused (review always covers the
current diff against `main`).

Reference: `CLAUDE.md`, `v1_claude_code_development_guide_existing.md`
§4.2 (ledger), §4.3 (baseline), §5.3–5.4 (commit/push covenant, pre-PR
manual covenants), §6 (testing tiers).

## Ledger check

Recompute the full fingerprint (tree + diff + cached diff + untracked file
hashes) and compare against `.claude/covenant_state.json`. Exact match →
print the script-generated COVENANT REPORT verbatim (never compose one) and
SKIP loudly. Otherwise, run everything below.

## 1. Diff inventory

```bash
git update-index -q --refresh
git diff --no-ext-diff
git diff main...HEAD --name-only
```

Every changed file must be explainable against the stated task.

## 2. Lockfile assertion (HARD STOP on any unapproved hit)

```bash
git diff main...HEAD --name-only -- package-lock.json signaling/package-lock.json viewer/package-lock.json
```

Any lockfile diff without an explicitly approved dependency addition
(a hard stop per CLAUDE.md) blocks the review outright — hidden transitive
deps bypass review.

## 3. Layer compliance (per changed file)

Check against `CLAUDE.md`'s Architecture Enforcement table: `src/domain/`
imports nothing from `application`/`infrastructure`/`presentation` and
does no I/O or `Date.now()`; `src/application/` imports no concrete
infrastructure and takes injected `now`; `signaling/src/` pure modules
(`router.ts`, `pairing.ts`, etc.) take no Worker-runtime types.

## 4. Secrets-in-diff

```bash
git diff main...HEAD | grep -iE "password|secret|api_key|token"
```

Zero matches required (excluding legitimate identifiers like
`BEAM_ICE_SERVERS`, `registerPin`, PIN-hash comparisons already reviewed —
use judgment on true hits vs. naming coincidence, but never wave through a
literal credential value).

## 5. Test execution (Tier 2 minimum, transitive closure for CORE_FILES)

```bash
npx vitest run --changed main             # root, if src/**/tests/** touched
(cd signaling && npx vitest run --changed main)   # if signaling/** touched
(cd viewer && npx vitest run --changed main)      # if viewer/** touched
```

If any `CLAUDE.md` CORE_FILES entry is in the diff, escalate to Tier 3
(`npm test` in every touched package) — this is mandatory, not optional.

## 6. Quarantine report

```bash
grep -v '^#' quarantine.txt | grep -v '^\s*$' | wc -l
```

Report the count and the modules covered. A quarantined test covering a
CORE_FILES module (cross-reference against the CLAUDE.md list) is a HARD
STOP, not a deferral.

## 7. Baseline-delta validation

If `.claude/baseline.json` differs from `main`, every removed finding must
appear in this session's `/audit` receipt as a ratchet-down (§4.3.3 R2).
Any baseline **increase**, or a decrease with no matching receipt, is a
HARD STOP — baseline.json is human-PR-only (CLAUDE.md → Hard Stops).

## 8. Conventional-commit verification

Confirm the commit message(s) on this branch follow
`type(scope): imperative description` (feat|fix|refactor|test|perf|
security|docs|chore) and that no commit message is a placeholder
("fix stuff", "WIP", "updates").

## 9. PR body generation

Summarize: what changed and why (from the Design Declaration GOAL), test
plan (tiers run + result), and any flagged-but-not-blocking debt (baseline
findings outside touched hunks, `NO_LINTER`/`NO_SCANNER` categories that
apply to touched files).

Finish by writing the new receipt atomically (fingerprint → pass, keyed
per Guide §4.2.3 F4).
