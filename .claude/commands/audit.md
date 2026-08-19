Diff-scoped security + architecture audit for Beam. `$ARGUMENTS` optionally
narrows scope (e.g. `Scope: signaling/src/pairing.ts signaling/src/rate-limit.ts`).

Reference: `CLAUDE.md`, `v1_claude_code_development_guide_existing.md`
§4.2–4.3 (ledger, baseline ratchet), §4.3.3a (hunk intersection).

## Scope

Full-repo only on explicit request. Otherwise, the change set is: files
changed since `covenant_state.json.last_pass_sha` + staged + unstaged +
untracked (`git status --porcelain` covers all three; untracked files are
never skipped — a brand-new unauthenticated route or SQL-injecting module
must not slip past because it was never `git add`ed).

## Ledger check

Compute the working-tree fingerprint (tree hash + `git diff` + `git diff
--cached` + hash of every untracked file, per Guide §4.2.3). If it matches
`.claude/covenant_state.json`'s `audit.fingerprint` and `result: pass`:
**SKIP loudly** — print the script-emitted line, do not re-run.

## Per-file-scanner hunk intersection

For each changed file, run the applicable scanner on the full file, then
intersect against `git diff -U0 <last_pass_sha> -- <file>` hunk ranges:

- **Root package:** `npx eslint <file>` (typescript-eslint recommended +
  the `complexity` rule, ceiling 10 — see `eslint.config.js`).
- **`signaling/` and `viewer/`:** `NO_LINTER` — no lint script exists for
  either package (see CLAUDE.md's package table). State this explicitly in
  the report; do not silently treat their files as clean.
- **All three packages:** `npm run typecheck` (or the package-specific
  `tsc` invocation) as a correctness gate — type errors are always
  in-scope, never baseline-eligible by file location.
- **Security:** `NO_SCANNER` (see `.claude/baseline.json.scanners`). Until
  one is configured, manually check every changed file in
  `signaling/src/` and `src/infrastructure/` against CLAUDE.md's Security
  Invariants (secrets on disk, auth enforcement, no raw exceptions to
  clients, parameterised input, no secrets in logs) — this is judgment,
  not a scanner, and must be stated as such in the report.

For each finding: **inside** a touched hunk → identity-check against
`.claude/baseline.json` (`rule`, `fp`) — new `fp` blocks (CRITICAL/HIGH
blocks and awaits human; MEDIUM/LOW auto-remediates, then re-verifies —
one retry only; a fix that doesn't clear the finding is itself a hard
block, not a second attempt), grandfathered `fp` passes silently.
**Outside** touched hunks → summarize as one line
(`"N baseline findings outside touched hunks — unchanged"`), never as
per-finding noise.

## Baseline ratchet-down

If a previously-baselined `(rule, fp)` no longer appears, remove it from
`.claude/baseline.json` and record the removed fingerprint(s) in this run's
audit receipt (`/review` later validates the decrease against that
receipt — a baseline decrease with no matching receipt is tampering, not
a legitimate ratchet-down).

## Report

Emit the COVENANT REPORT — this is descriptive of what the underlying
covenant script (`.githooks/covenantwin.py`) produces at commit/push time;
`/audit` run standalone approximates it for pre-commit visibility. State
plainly: which files were scanned, which scanner covered each
(`NO_LINTER`/`NO_SCANNER` where applicable), new vs. grandfathered finding
counts, and the ratchet delta if any.
