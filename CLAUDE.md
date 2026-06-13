# Beam — Engineering Constitution (PRESCRIPTIVE)
# Claude Code reads this before taking ANY action in this repository.
# Greenfield rule: there is NO baseline. Any finding is a NEW finding and BLOCKS.
# Companion standard: v1_claude_code_development_guide_new.md (the Guide).

## PROJECT OVERVIEW
Beam relays HTTP requests from a remote browser peer to a localhost server
over peer-to-peer data channels: session lifecycle + identity, signaling,
peer-connection management, request/response framing + multiplexing, a
localhost HTTP replay client, a CLI surface, and a request-log/diagnostics
surface.
Stack: TypeScript (strict) on Node >= 22. Tests: vitest. Lint: eslint
(flat config, complexity rule). Types: tsc --noEmit. No persistence layer yet.

---

## 1. ARCHITECTURE ENFORCEMENT (NON-NEGOTIABLE)

This codebase follows Clean Architecture. Layer boundaries are
inviolable. Violations are defects, not style issues.

PRESENTATION  (src/presentation/)
  Owns:     CLI argument parsing, output formatting/serialisation, input
            validation, the diagnostics/request-log rendering surface
  Must not: contain business logic, call repositories directly,
            hold state, write queries of any kind
  Calls:    Application layer ONLY

APPLICATION  (src/application/)
  Owns:     Use-case orchestration (relay, session lifecycle, diagnostics
            queries), transaction boundaries, business workflows,
            authorisation rules
  Must not: contain store-specific or transport-specific code, know HTTP
            or CLI concepts, expose raw exceptions to callers
  Calls:    Domain + Infrastructure (via interfaces)

DOMAIN  (src/domain/)
  Owns:     Entities (Session), value objects (Frame, StreamId), domain
            events, repository/transport INTERFACES (SignalingClient,
            PeerTransport, ReplayClient, RequestLogRepository)
  Must not: import from any other layer, depend on any framework
  Has ZERO external dependencies — pure business logic.

INFRASTRUCTURE  (src/infrastructure/)
  Owns:     All I/O — signaling client, peer connection + data channels,
            localhost HTTP replay, request-log store, caching, messaging
  Must not: contain business logic, call Application layer
  Implements: Domain interfaces
  All queries: parameterised only — no string interpolation, ever

CROSS-CUTTING
  src/config.ts       — single source of truth for ALL env access
  src/composition.ts  — the composition root; the ONLY place concrete
                        infrastructure is bound to domain interfaces

# Dependency direction: Presentation -> Application -> Domain <- Infrastructure

---

## 2. NAMING CONTRACTS

Repositories:  fetch*(), find*(), persist*(), remove*()
Use cases:     Execute*UseCase (command), Query*UseCase (read)
Entities:      PascalCase nouns — Session, Frame, RequestRecord
Value objects: PascalCase nouns — StreamId, SessionCode, FramePayload
Events:        Past-tense — SessionEstablished, PeerConnected,
               RequestRelayed, SessionClosed
Tests:         tests/<layer>/<module>.test.ts  (mirrors src/ EXACTLY;
               cross-cutting modules mirror at tests/<module>.test.ts)

The test naming contract is load-bearing: it gives deterministic
module→test mapping for free, forever.

---

## 3. SECURITY INVARIANTS (ABSOLUTE — NEVER NEGOTIATE)

- Credentials/secrets/keys NEVER written to any file on disk.
- .env is in .gitignore. Must never be committed.
- Every route exposing data requires explicit auth enforcement.
- Raw exceptions and stack traces NEVER returned to clients.
- User input NEVER interpolated into query strings — parameterised only.
- Secrets NEVER appear in log output at any level.
- Config/env access ONLY through the single config module (src/config.ts) —
  never raw process.env in feature code.
- LOCAL-ONLY EXECUTION: No agent action may transmit repository contents off
  this machine. git push, remote PR creation, and any network egress
  (curl/wget/scp/ssh/nc to push data out) are human-only actions performed in
  a plain shell, never by the agent. The agent's role ends at a local commit.

---

## 4. HARD STOPS — ALWAYS AWAIT HUMAN APPROVAL BEFORE PROCEEDING

| Trigger | Why |
|---|---|
| New runtime dependency / lockfile alteration | Supply chain; transitive deps bypass review |
| Database schema migration | Irreversible in production |
| Auth/authz logic change | Access-control bypass path |
| New environment variable | Must be provisioned everywhere (and added to .env.example) |
| Deployment/infra config | Outage risk |
| CI/CD pipeline modification | Can silently suppress checks |
| .gitignore changes | Secret-exposure risk |
| Background job/scheduler | Double-processing / data loss |
| Permission-mode change or settings.json edit | Disabling the prompt layer disables the mechanical push gate |
| Editing the CORE_FILES list (§5) | Shrinks the tier-3 test trigger silently |
| Quarantining a test that covers a CORE_FILES module | Removes the one test that catches a core regression (§7) |
| Any modification to `.githooks/**` or the CI gate definition | Direct trust-root compromise; bypassing local or pipeline constraints |

---

## 5. CORE_FILES (named constitution element)

The ONLY trigger for mandatory tier-3 test runs (§7), and the set whose
reverse dependencies get transitive-closure selection:

```
CORE_FILES:
  src/config.ts          # the config module
  src/domain/**          # entities, value objects, interfaces
  src/composition.ts     # DI wiring / composition root
  tests/fixtures/**      # shared test fixtures
  src/application/protocol.ts
```

The list grows as the dependency graph grows (any module imported by >5
others joins it, plus config, base models, DI wiring, fixtures) — but it is
updated via a human engineering pass ONLY. Editing it is a hard stop (§4)
and changes only via human-authored PR, never agent edit.

---

## 6. BOUNDARY CAVEATS (permission layer)

```
P1. PERMISSION MODE: never operate a governed repo with
    --dangerously-skip-permissions or defaultMode: bypassPermissions —
    either nullifies the interactive prompt entirely. defaultMode is
    pinned in the committed settings.json; changing it is a hard stop.
P2. COMPOUND COMMANDS: allow rules match prefixes. git push is ALWAYS
    issued standalone — never inside &&, ;, or | chains, where it could
    ride an allowed prefix past the prompt on naive matchers.
P3. FORCE-PUSH: the deny list catches the named flag variants, but
    refspec-force (git push origin +main) cannot be pattern-matched —
    it is banned in constitution text and refused by the pre-push hook.
    Never describe force-push as blocked by the deny list alone.
```

LOCAL-ONLY DEVIATION: in this repository `git push` is additionally in the
DENY list (with curl/wget) per the LOCAL-ONLY EXECUTION invariant (§3) —
the guide's interactive-prompt placement is superseded. The human pushes
from a plain shell; the pre-push hook still governs that human push.

---

## 7. TESTING DISCIPLINE

```
RULES:
N1. Every new function in Application or Domain gets a unit test
    IN THE SAME TASK — tests are declared by name in the design
    phase (Phase 2), before implementation exists.
N2. Every Infrastructure implementation gets an integration test.
N3. Mock at the Infrastructure interface. Never deeper.
N4. The suite passes with exit code 0 before any task is complete.
N5. Never modify a test to make it pass.
```

Exact commands (this stack):

```
Full suite:        npx vitest run
Single module:     npx vitest run tests/<layer>/<module>.test.ts
Coverage gate:     npx vitest run --coverage          (lines >= 80 enforced)
Lint gate:         npx eslint .
Type gate:         npx tsc --noEmit
Complexity gate:   npx eslint --rule '{"complexity":["error",10]}' <changed files>
```

### Scaling rules (Guide §6.2 — verbatim policy)

While the suite is young, run it fully — it is cheap. Plan the tiers BEFORE
they are needed:

```
While full suite < ~60s:   run the full suite at every gate. Simple.
When full suite > ~60s:    switch the gate to tiered selection:
  TIER 1 (per file, during implementation): the mapped test module only
  TIER 2 (pre-commit): mapped tests + reverse-dependency tests —
    one level for leaf modules; TRANSITIVE CLOSURE for CORE_FILES
    (a regression in a shared utility breaks tests two import hops
    away; one-level selection misses them)
  TIER 3 (full suite): CI and pre-PR only — never the local default

T1. The gate report always states which tier ran and why.
T2. Flaky tests are quarantined in a COMMITTED quarantine.txt with a
    linked issue — never deleted, never retried-until-green. /review
    prints the quarantine count and covered modules on every run. A
    quarantined test covering a CORE_FILES module is a HARD STOP.
T3. CORE_FILES: CLAUDE.md carries an explicit glob list — the ONLY
    trigger for mandatory tier 3. Maintained as the dependency graph
    grows (any module imported by >5 others is core, plus config,
    base models, DI wiring, fixtures). Editing it is a hard stop.
T4. grep import-scanning is a LOWER BOUND on impact — blind to
    re-exports, dynamic imports, and DI/fixture injection. When a
    changed file is consumed through any of those, escalate to tier 3.
    Install real test-impact tooling at the tier transition.
T5. TIER-TRANSITION ENFORCEMENT: the gate script records full-suite
    wall time in gate_state.json on every run. Over the threshold
    twice consecutively -> the script emits TIER TRANSITION REQUIRED
    and refuses to default to full-suite locally. The trigger lives
    in the ledger, not in anyone's memory.
```

The threshold (~60s) is fixed here at init so the transition is automatic
policy, not a future debate.

---

## 8. DEFAULT EXECUTION PROTOCOL (AUTO-PIPELINE)

Every user message that describes a code change — regardless of how casually
it is phrased — automatically triggers this pipeline without waiting for
confirmation or asking follow-up questions:

STEP 1 — RECON (read-only)
  grep for every symbol, file, and entity mentioned in the message.
  Read only targeted sections of relevant files — not full files.
  If the message references prior work, grep the codebase to find what
  currently exists — never rely on conversation memory.

STEP 2 — CONTRACT (internal, not shown unless a hard stop fires)
  Derive: SCOPE, OBJECTIVE, CONSTRAINTS, VERIFY, OUTPUT.
  Apply all CLAUDE.md rules automatically.

STEP 3 — EXECUTE
  Run the full /feature protocol immediately.
  Layer order: Domain -> Infrastructure -> Application -> Presentation -> Tests.
  After each file: npx tsc --noEmit + that module's mapped test.
  Full gate commands (§7) at the end.

STEP 4 — OUTPUT
  Change manifest: File | Action | Layer | Lines Changed
  Full test output (verbatim, last run only)
  Conventional Commit message: type(scope): imperative description

PIPELINE EXCEPTIONS — stop and state before executing:
  - Any §4 hard stop is triggered
  - Scope cannot be determined (ask one targeted question only)
  - Two different implementations are equally valid

---

## 9. COMMIT / PUSH GATE (hook-enforced, ledger-aware)

Triggers on "commit", "push", "PR", "ship", "merge" at the model layer; the
hook layer (.githooks/) runs on every git commit and git push regardless.

```
GATE STEP 1 — /audit
  Ledger hit at current fingerprint -> SKIP loudly (script-emitted).
  Else: audit the change set. Greenfield rule: ANY finding blocks.
  CRITICAL/HIGH -> await human. MEDIUM/LOW -> auto-fix, re-verify.

GATE STEP 2 — /review
  Ledger hit -> SKIP loudly.
  Else: layer compliance per changed file, secrets-in-diff grep,
  coverage check, LOCKFILE ASSERTION (any lockfile diff without an
  approved dependency addition = HARD STOP).

GATE STEP 3 — git (only if 1 and 2 pass)
  git update-index -q --refresh; git diff --no-ext-diff
  git add <specific files — NEVER git add -A>
  Conventional Commit. The pre-commit hook re-verifies mechanically.

GATE STEP 4 — PUSH CONFIRMATION (mandatory, no exceptions)
  State exact branch + remote in chat. Wait for explicit human
  approval IN THIS CONVERSATION. A prior "push" in the same message
  does NOT count. No reply = no push. Ever.
  The pre-push hook independently refuses protected branches,
  +refspec force syntax, missing receipts, and expired bypasses.
  LOCAL-ONLY OVERRIDE (§3): in this repository the agent NEVER reaches
  Step 4 — git push is denied outright; the human pushes from a plain
  shell, where the pre-push hook and cc-push still apply.
```

---

## 10. CHECKPOINTS & SESSION STATE (Guide §4.1)

A checkpoint is a STATE SNAPSHOT, not a conversation summary. Storage:
`.claude/checkpoints/<YYYYMMDD-HHMM>-<phase>.md` + `LATEST.md` (always
newest). Gitignored. Keep the 10 most recent; delete older at write time.

Trigger rules — evaluate at every /feature phase boundary (end of Phase 1,
3, 4) and after any /audit or /review. Pressure is HIGH if ANY of:

```
C1. 3+ pipeline phases completed this session
C2. 5+ files modified this session
C3. A hard stop fired and was resolved this session
C4. A test failure was diagnosed and fixed this session
C5. Session older than ~2 hours
```

HIGH -> write checkpoint BEFORE continuing and tell the user. End of
Phase 5 -> write ALWAYS. When in doubt, write.

Schema (every field required):

```markdown
# CHECKPOINT
phase:        <recon | execute | verify | output | audit | review>
git_sha:      <git rev-parse HEAD>
branch:       <git branch --show-current>
dirty_files:  <count> uncommitted
timestamp:    <YYYYMMDD-HHMM>

## TASK
<one sentence>

## FILES MODIFIED THIS SESSION
- path — one-line reason

## DECISIONS LOCKED
- <decision>: <why this over the alternative>

## CURRENT STATE
- tests: <last result>   - lint/scan: <clean?>   - build: <compiles?>

## PENDING
- <ordered remaining work>

## RESUME INSTRUCTION
<the exact next action a fresh session should take>
```

Resume protocol: at session start, if LATEST.md exists -> read it, check
`git rev-parse HEAD` against its sha. Match -> announce "Resuming from
checkpoint <ts>" and execute the RESUME INSTRUCTION. Diverged -> state the
divergence, ask. Clearly new task -> ignore; superseded at next write.

### CONTEXT BUDGET & HALTING (hard rules, upgrade of Guide §7.1.1)

- Track approximate context usage every turn via round-trip turn
  approximations; flag history-retransmission waste over 50%.
- WARN at 40,000 tokens in a single phase, verbatim: "WARNING: Context
  pressure exceeding efficiency thresholds (~[Count] tokens used). /compact
  or restart recommended to prevent token inflation."
- HARD HALT RULE: work may only stop at a SAFE BOUNDARY — (a) the end of a
  /feature phase, OR (b) immediately after a checkpoint write, OR (c) after
  a clean atomic commit with all gates green. NEVER stop mid-file,
  mid-stubs-batch, or between dependent edits that leave the tree
  non-compiling.
- When context usage crosses ~60% of the working window OR a phase has run
  past the 40k warning AND a boundary is near: finish the current file/edit
  to a compiling state, complete the current phase OR write a checkpoint
  (whichever boundary is nearer), emit "HALTING AT SAFE BOUNDARY — resume
  via LATEST.md", and STOP. Do not begin a new phase or a file you cannot
  finish.
- On HTTP 429: do NOT retry in a loop — write a checkpoint, wip-commit or
  stash, stop, await human (Guide §7.5).
- Every checkpoint's RESUME INSTRUCTION must let a fresh session restore
  full state in one read.

---

## 11. WORKTREE ENVIRONMENT

If .env.worktree exists: source it before every test run. Never assume
default ports/schemas. Use ${APP_PORT}, ${TEST_DB_SCHEMA}, ${*_TEST_KEY}.
External sandbox keys are distinct per worktree — never share a live key
across parallel agentic sessions.

---

## 12. WHEN UNCERTAIN

State: what you know, what you do not know, and what options exist.
Never implement placeholder code and present it as complete.
Never add a try/catch to silence an error — fix the error.
Never modify a test to make it pass — modify the code under test.

---

## 13. GOVERNANCE

CLAUDE.md, the CORE_FILES list, .claude/settings.json, .githooks/**, and any
baseline definitions change EXCLUSIVELY via human-authored pull requests,
never via automated agent edits. The agent never self-maintains the
constitution; the settings.json deny list enforces this mechanically. A gate
the agent can rewrite is not a gate. Re-running initialization or repairing
these files is a human-only action (hand-edit + PR).
