# /prep — Natural Language -> Execution Contract (ZERO implementation)

Natural language task description: $ARGUMENTS

Produce ONLY the contract below. Do not write, edit, or stage any file. Do
not run any mutating command. Read-only recon (grep + targeted reads) is
permitted to ground the contract in the live codebase.

## HARD STOPS — FLAGGED AT TOP
First, list every CLAUDE.md §4 hard stop this task would trigger (new
dependency, schema change, auth change, new env var, infra/CI config,
.gitignore, settings/permissions, CORE_FILES edit, core-test quarantine,
.githooks change). If any: state it in the first line and note that
execution awaits explicit human approval.

## THE CONTRACT
```
SCOPE:        <explicit dirs/files in scope — everything else off-limits>
OBJECTIVE:    <the condition that must be TRUE when done — testable>
CONSTRAINTS:  <CLAUDE.md rules that bind this task: layer boundaries,
               naming contracts, security invariants, N1–N5>
VERIFY:       <exact deterministic command(s) + expected exit code, e.g.
               npx vitest run tests/<layer>/<module>.test.ts   -> exit 0
               npx vitest run --coverage                       -> exit 0
               npx eslint <files> && npx tsc --noEmit          -> exit 0>
OUTPUT:       <change manifest table + verbatim test output +
               Conventional Commit message>
```

## SIZE DECLARATION
Classify per Guide §7.3 (Micro <5k | Small 5–15k | Medium 15–40k |
Large 40–80k | XL 80k+). Large -> split across sessions by layer.
XL -> decompose per Guide §7.4 — one session per layer, one checkpoint and
one atomic commit each.

End with: "Run `/feature <this contract>` to execute." — and nothing else.
