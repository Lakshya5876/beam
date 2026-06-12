# /audit — Diff-Scoped Security + Architecture Audit (greenfield: ANY finding blocks)

Scope (optional, defaults to the gate change set): $ARGUMENTS

## SCOPE DEFINITION
The audit target is the gate script's change set — changed + staged +
unstaged + UNTRACKED files:
```
git diff --name-only $(node -e "const s=require('./.claude/gate_state.json');process.stdout.write(s.last_pass_sha??'')" 2>/dev/null || true) 2>/dev/null
git diff --name-only --cached
git diff --name-only
git ls-files --others --exclude-standard
```
COLD START: if `last_pass_sha` is null, the change set is ALL tracked +
untracked files.

## GREENFIELD RULE
There is NO baseline. ANY finding blocks:
- CRITICAL / HIGH -> BLOCK and await explicit human approval.
- MEDIUM / LOW    -> auto-remediate, then RE-VERIFY the finding is gone.

## SEVERITY NORMALIZATION TABLE (native scanner levels -> gate actions)
"CRITICAL/HIGH blocks" is undefined for tools that only emit error/warning —
this table is the binding mapping:

| Source | Native level | Normalized | Gate action |
|---|---|---|---|
| secrets grep (patterns below) | match | CRITICAL | block-await-human |
| .env / *.pem / id_rsa staged or untracked-in-changeset | match | CRITICAL | block-await-human |
| injection vectors (eval, new Function, child_process exec with interpolation, string-built queries) | match | HIGH | block-await-human |
| layer-boundary violation (import crossing CLAUDE.md §1 rules) | match | HIGH | block-await-human |
| route/handler exposing data without auth enforcement | match | HIGH | block-await-human |
| eslint | error | MEDIUM | auto-remediate |
| eslint | warning | LOW | auto-remediate |
| tsc --noEmit | error | MEDIUM | auto-remediate |
| empty catch block / swallowed error (`catch {}` or catch that neither rethrows nor reports) | match | MEDIUM | auto-remediate |
| TODO/FIXME in changed lines | match | LOW | record-only |

## CHECKS (run all, scoped to the change set)
```
# Secrets patterns (zero matches required):
grep -rnEI "(password|secret|api_key|apikey|token|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY)\s*[:=]" <changeset files>

# Injection vectors:
grep -rnE "\beval\(|new Function\(|execSync?\(.*(\$\{|\+)" <changeset src files>

# Bare/empty catches:
grep -rnE "catch\s*(\([^)]*\))?\s*\{\s*\}" <changeset src files>

# Layer violations (each must return NOTHING):
grep -rnE "from '\.\./(application|infrastructure|presentation)" src/domain/
grep -rnE "from '\.\./(presentation)" src/application/
grep -rnE "from '\.\./(application|presentation)" src/infrastructure/
grep -rnE "from '\.\./(infrastructure|domain)" src/presentation/   # presentation calls application ONLY

# Lint + types on the change set:
npx eslint <changed .ts files>
npx tsc --noEmit
```

## SELF-HEALING FAILURE BRANCH
If an auto-remediation attempt (MEDIUM/LOW) does NOT eliminate the finding on
re-verify, treat it as a HARD BLOCK and report to the human — do not retry
silently. The §3.3 three-strike rule applies to every auto-fix: three failed
fix-and-re-verify cycles on the SAME finding -> STOP, report verbatim, await
human.

## OUTPUT
Every finding: file, line, severity (native + normalized), required action.
Then the disposition: BLOCKED (await human) | REMEDIATED + re-verified |
RECORDED. The gate script (.githooks/gate.sh) — not this command — writes
the audit receipt.
