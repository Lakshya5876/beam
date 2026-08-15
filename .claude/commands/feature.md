Full implementation pipeline for Beam. `$ARGUMENTS` is the task description.

Reference: `CLAUDE.md` (this repo's constitution) and
`v1_claude_code_development_guide_existing.md` §3 (pipeline), §4.1
(checkpoints), §6 (testing tiers).

## PHASE 0 — PRE-FLIGHT

1. `git branch --show-current` — if `main`/`master`/`develop`, stop: create a
   `feature/*`, `fix/*`, `docs/*`, or `chore/*` branch first.
2. `git status --porcelain` — note dirty state; do not silently commit on
   top of someone else's uncommitted work.
3. Confirm the suite collects: for each touched package
   (root / `signaling/` / `viewer/`) run `npm run typecheck` — it must
   compile clean before starting (this repo has no separate "collect"
   mode for Vitest; typecheck is the cheap proxy for "the tree isn't
   already broken").

## PHASE 1 — RECONNAISSANCE (zero writes)

Locate every symbol the task touches with `grep`/`Read` (targeted
offset+limit reads, never a full-file dump for orientation — no graph
tooling is configured in this repo, see CLAUDE.md's Environment note).
Output an explicit change manifest listing every file to touch, in
dependency order (domain → application → infrastructure/signaling →
presentation, per CLAUDE.md's Architecture Enforcement section).

## PHASE 2 — DESIGN DECLARATION (zero writes)

State, per CLAUDE.md's Design Declaration section:

```
GOAL:  <concrete, observable outcome>
VERIFY: <the specific test/command that confirms it>
ASSUMING: <interpretation being proceeded on, if more than one is reasonable>
ALTERNATIVE: <what would change if wrong>
```

Assign each changed file to its layer, declare typed signatures and error
states (`Result<T,E>` / discriminated `error` unions, per CLAUDE.md's
Naming Contracts), and list the tests that will cover it. Cannot answer
something with reasonable confidence? STOP and ask via `AskUserQuestion` —
never assume, per CLAUDE.md's Blocking Questions section.

## PHASE 2.5 — STUBS-FIRST (mandatory at 3+ files)

Write all stub files simultaneously: real imports, fully-typed signatures,
empty typed returns, zero logic. Then compile-check everything at once:

```bash
# whichever package(s) are touched:
npm run typecheck            # root
(cd signaling && npm run typecheck)
(cd viewer && npm run typecheck)
```

Exit code 0 across all touched packages required before Phase 3 begins.

## PHASE 3 — IMPLEMENTATION (dependency order, bottom-up)

After each file, run its Tier-1 mirrored test:

```
tests/<layer>/<module>.test.ts          (root)
signaling/test/<module>.test.ts          (signaling)
viewer/test/<module>.test.ts             (viewer)
```

via `npx vitest run <path>` in the relevant package directory.

>>> CHECKPOINT EVALUATION (CLAUDE.md → Checkpoints, C1–C5) — write if pressure is HIGH. <<<

## PHASE 4 — VERIFICATION LOOP (max 3 attempts)

```bash
git update-index -q --refresh; git diff --no-ext-diff
```

before every re-run and every diff. Then:

1. Impacted tests: `npx vitest run --changed <last_pass_sha>` in each
   touched package — plus, if any `CLAUDE.md` CORE_FILES entry changed,
   the transitive closure of its dependents' tests (Tier 2, fixed point,
   not one level).
2. Tier 2 pass → run Tier 3 only if a CORE_FILES entry changed, or this is
   pre-PR: `npm test` (root), `(cd signaling && npm test)`,
   `(cd viewer && npm test)`.
3. Run the Scope Discipline self-check (minimum footprint, surgical
   boundary — CLAUDE.md → Design Declaration) before the checkpoint write,
   not after the diff is already staged.

Apply the Three-Strike Rule on any failure: attempt 1 — root-cause in one
sentence, minimum fix, re-run; attempt 2 — new error only, never stack a
fix on a fix; attempt 3 — STOP, report the original error verbatim, what
each attempt changed, and what a human needs to provide. No fourth attempt.
Never modify a test to make it pass; never add try/except to silence an
error; never add "if test mode" conditionals.

>>> CHECKPOINT EVALUATION <<<

## PHASE 5 — OUTPUT

Change manifest, verbatim test output, and a Conventional Commit message
(`type(scope): imperative description`; types: feat|fix|refactor|test|
perf|security|docs|chore).

>>> CHECKPOINT WRITE (always, unconditional) <<<

Then run the Commit/Push Covenant from `CLAUDE.md`:
`/audit` → `/review` → `git add <specific files>` + commit → PUSH
CONFIRMATION (state branch + remote in chat, wait for explicit approval —
no reply means no push).
