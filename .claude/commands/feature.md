# /feature — Full Implementation Pipeline (Phases 0–5)

Feature specification: $ARGUMENTS

Execute the complete pipeline below. Constitution (CLAUDE.md) applies to every
phase. Greenfield rule: any finding blocks — there is no baseline.

## PHASE 0 — PRE-FLIGHT
```
git status --porcelain            # must be clean (or explained)
git branch --show-current         # must NOT be main/master/develop
npx vitest run                    # suite collects + passes
npx tsc --noEmit                  # compiles
```
If `.claude/checkpoints/LATEST.md` exists, run the resume protocol
(CLAUDE.md §10) before anything else.

## PHASE 1 — RECONNAISSANCE (zero writes)
grep every symbol/file/entity in the specification; targeted reads only
(offset+limit around grep hits — never full files unless genuinely needed).
Produce an explicit change manifest: every file to be touched, why, layer.
>>> CHECKPOINT EVALUATION (CLAUDE.md §10 C1–C5) <<<

## PHASE 2 — DESIGN DECLARATION (zero writes)
- Layer assignment per file (Domain / Infrastructure / Application / Presentation)
- Typed signatures for every new function/class
- Error states and how each surfaces
- NAMED test list — `tests/<layer>/<module>.test.ts` names declared NOW,
  before implementation exists (N1).
Cannot answer something? STOP and ask. Never assume.
Any CLAUDE.md §4 hard stop in scope? STOP and await human approval.

## PHASE 2.5 — STUBS-FIRST [MANDATORY for 3+ files]
ALL stubs simultaneously: real imports + typed signatures + empty returns.
Compile-check ALL at once:
```
npx tsc --noEmit                  # exit 0 across every stub before ANY logic
```

## PHASE 3 — IMPLEMENTATION (strict layer order)
Domain -> Infrastructure -> Application -> Presentation -> Tests.
After EACH file:
```
npx tsc --noEmit
npx vitest run tests/<layer>/<module>.test.ts
```
Fix failures before moving on.
>>> CHECKPOINT EVALUATION <<<

## PHASE 4 — VERIFICATION LOOP (max 3 attempts — three-strike rule)
Mandatory before EVERY re-run and EVERY git diff:
```
git update-index -q --refresh; git diff --no-ext-diff
# --refresh reconciles STAT METADATA ONLY — it cannot rescue a change hidden
# behind identical mtime+size. It must be paired with the content-level check
# (git diff --no-ext-diff re-hashes on stat mismatch; use
# git status --porcelain=v2 when certainty is required). Never treat
# --refresh alone as proof the tree matches the index.
```
Then:
```
npx vitest run                                    # full suite — cheap while young
npx vitest run --coverage                         # lines >= 80
npx eslint .                                      # zero errors
npx tsc --noEmit                                  # zero errors
```
Three strikes (Guide §3.3):
- Attempt 1: refresh, run, FULL traceback, root cause in ONE sentence, minimum fix, re-run.
- Attempt 2: never stack fix-on-fix. Identical error? Revert attempt 1. Changed error? New root cause, clean fix.
- Attempt 3: STOP. Report original error, both attempts + outcomes, best assessment, what a human must provide. No 4th attempt.
Loop invariants: never modify a test to make it pass; never silence with
try/catch; never add "if test mode" branches; same error twice = wrong mental
model, restart analysis.
>>> CHECKPOINT EVALUATION <<<

## PHASE 5 — OUTPUT
- Change manifest table: File | Action | Layer | Lines Changed
- Test output VERBATIM (last run only)
- Conventional Commit message: type(scope): imperative description
>>> CHECKPOINT WRITE — ALWAYS <<<

## COST-WARNING FIRING (Guide §7.1.1 — active in every phase)
Track context via round-trip turn approximations. If a single task iteration
or pipeline phase consumes more than 40,000 context tokens, or history
retransmission waste crosses 50%, output verbatim:
"WARNING: Context pressure exceeding efficiency thresholds (~[Count] tokens
used). /compact or restart recommended to prevent token inflation."
Then apply CLAUDE.md §10 CONTEXT BUDGET & HALTING: halt only at a safe
boundary (phase end / post-checkpoint / clean gated commit).
