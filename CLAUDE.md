# CLAUDE.md — Beam Constitution

This file governs Claude Code sessions in this repository. It is generated
from a staged reconnaissance pass over the actual codebase (see
`v1_claude_code_development_guide_existing.md`, the standard this file
implements) and DESCRIBES the architecture that exists — it does not
prescribe a textbook ideal. Governance files (this file, `.claude/settings.json`,
`.claude/baseline.json`, `.githooks/**`) change ONLY via human-authored pull
request, never via an agent edit — the deny list in `.claude/settings.json`
enforces this mechanically. An agent session never self-maintains this
constitution.

## What this repo is

Beam is a WebRTC localhost-tunnel tool: expose a local dev server to a
browser peer with no cloud relay. Three independent npm packages, each with
its own lockfile and CI-relevant commands:

| Package | Role | Test | Lint | Typecheck |
|---|---|---|---|---|
| root (`@beamtunnel/cli`) | Node 22 CLI host, WebRTC via `node-datachannel` | `npm test` (`vitest run`) | `npm run lint` (`eslint .`) | `npm run typecheck` (`tsc --noEmit`) |
| `signaling/` | Cloudflare Worker + Durable Object matchmaker | `npm test` (`vitest run`) | *(none configured — NO_LINTER)* | `npm run typecheck` (`tsc -p tsconfig.json && tsc -p tsconfig.worker.json`) |
| `viewer/` | Browser bootstrap + service worker | `npm test` (`vitest run`) | *(none configured — NO_LINTER; root `eslint .` incidentally reaches `viewer/src` today)* | `npm run typecheck` (`tsc -p tsconfig.json`) |

Root `eslint.config.js` is a flat config scoped by ignore patterns, not
project references — it happens to lint `viewer/src` because it runs from
the repo root, but `signaling/src` has no lint coverage at all
(`signaling/package.json` and `viewer/package.json` have no `lint` script).
Treat both as `NO_LINTER` for their own packages until a real per-package
lint script exists.

## Architecture Enforcement

### `src/` — hexagonal / ports-and-adapters (root CLI)

- **`src/domain/`** — OWNS: pure entities and state machines (`session.ts`,
  `frame.ts`) and the seam interfaces (`interfaces.ts`: `PeerTransport`,
  `SignalingClient`, `ReplayClient`, `RequestLogRepository`, `Result<T,E>`).
  MUST NOT: import from `application/`, `infrastructure/`, or
  `presentation/`; call `Date.now()`, do I/O, or reference WebRTC/WebSocket/
  Node http types. CALLS: nothing outside itself.
- **`src/application/`** — OWNS: use-cases that orchestrate domain entities
  over the seam interfaces (`session-use-case.ts`, `relay-use-case.ts`,
  `diagnostics-use-case.ts`, `path-authorization.ts`, `protocol.ts`).
  MUST NOT: import concrete infrastructure or instantiate adapters; time is
  always injected (`now: () => number`), never read directly.
  CALLS: `domain/` only.
- **`src/infrastructure/`** — OWNS: concrete adapters implementing the seam
  interfaces (`peer-connection.ts`, `signaling-client.ts`, `replay-client.ts`,
  `request-log-store.ts`, `mdns-resolve.ts`). CALLS: `domain/` (types only).
- **`src/presentation/`** — OWNS: CLI entry, debug logging, diagnostics
  rendering (`cli.ts`, `debug-log.ts`, `diagnostics-view.ts`).
  CALLS: `composition.ts` to obtain a wired `HostRuntime`.
- **`src/composition.ts`** — the ONLY place concrete infrastructure is
  instantiated and wired to domain interfaces (`realFactories`,
  `composeHost`). Every other file reaches infrastructure only through
  interfaces `composition.ts` wires.
- **`src/config.ts`** — the sole `process.env` access point. Feature code
  never reads `process.env` directly; it receives a `BeamConfig`.

### `signaling/src/` — flat Cloudflare Worker (separate deployable)

No layered subdirectories. `worker.ts` is the `fetch` entry (wrangler
`main`); `session-do.ts` is the stateful Durable Object (WebSocket
Hibernation API — in-memory state does not survive eviction, so peer role
lives in a socket tag, not a map). Pure decision logic is factored into
single-purpose modules unit-tested independently of the DO: `router.ts`,
`pairing.ts`, `session-code.ts`, `pin-store.ts`, `rate-limit.ts`,
`message-size.ts`, `used-token-store.ts`, `url.ts`, `ice-config.ts`.
MUST NOT: put I/O or Worker-runtime types (`DurableObjectState`, `Request`,
`Response`) into the pure decision modules — they take/return plain
values so the DO stays a thin adapter over them.

### `viewer/src/` — flat browser bootstrap + service worker

`main.ts` / `bootstrap.ts` are the page entry; `sw.ts` is the service worker
entry. Protocol/bridge modules (`protocol-bridge.ts`, `sw-bridge.ts`,
`signaling-messages.ts`, `request-serializer.ts`, `response-assembler.ts`)
sit between them. `viewer/` imports the core protocol read-only per its own
package description — never write back into `src/` or `signaling/src/`
from this package.

## ENFORCEMENT SCOPE (BROWNFIELD)

- This constitution applies FULLY to: new files, and any region of an
  existing file modified in the current task.
- Untouched legacy code is EXEMPT until touched (boy-scout rule).
- Never demand a refactor of an unrelated legacy file as a precondition
  for a small change. Flag the debt; do not block on it.
- When touching a legacy file, leave the touched region cleaner than
  found: parameterise the query you edited, type the function you
  modified — but do NOT rewrite the whole file.

## Naming Contracts (as discovered)

- Files: kebab-case (`session-use-case.ts`, `peer-connection.ts`).
- Functions/variables: camelCase. Types/interfaces/classes: PascalCase.
- Errors: no thrown exceptions for control flow. Every fallible function
  returns `Result<T, E>` (`ok()` / `err()` from `domain/interfaces.ts`) or a
  discriminated error object with an `error: '<Tag>'` string field and a
  matching `isXError()` type guard. Reserve real `throw`/`try/catch` for
  genuinely unexpected failures (e.g. malformed JSON in
  `composition.ts:parseRemoteCandidate`), and catch narrowly.
  Time is always injected (`now`/`nowMs` parameters); never
  `Date.now()` inside `domain/` or `application/`.
- Comments: a header JSDoc block per file citing the design doc section it
  implements (e.g. `design doc §10 S2`) and explaining non-obvious
  rationale — not restating what the code does.
- Tests: Vitest, `describe`/`it`, `must*()` helper factories for valid
  fixtures that throw with a clear message on unexpected setup failure,
  relative imports into `src/` (`../../src/domain/session.js`) or
  `signaling/src/` (`../src/router.js`). Test files mirror the source
  layer directory (`tests/domain/session.test.ts` for `src/domain/session.ts`).

## SECURITY INVARIANTS (ABSOLUTE — NEVER NEGOTIATE)

- Credentials/secrets/keys NEVER written to any file on disk.
- `.env` is in `.gitignore`. Must never be committed.
- Every route exposing data requires explicit auth enforcement.
- Raw exceptions and stack traces NEVER returned to clients.
- User input NEVER interpolated into query strings — parameterised only.
- Secrets NEVER appear in log output at any level.
- Repo-specific: `BEAM_ICE_SERVERS` TURN credentials live only in the shell
  env, never on disk (see `src/config.ts` header comment). PIN verification
  (`signaling/src/pin-store.ts`) is SHA-256(value + ":" + sessionCode) with
  a three-strike lockout — never weaken the attempt cap or compare raw PINs.

## Hard Stops (require explicit human approval before proceeding)

| Trigger | Why |
|---|---|
| New runtime dependency / lockfile alteration (any of the 3 lockfiles) | Supply chain; hidden transitive deps bypass review |
| Database/storage schema change (Durable Object storage keys, `pending-count`/`pin-verified`/`used:` prefixes) | Irreversible in production, breaks hibernated state |
| Auth/authz logic change (PIN pairing, `path-authorization.ts`, rate limiting, used-token store) | Direct path to access-control bypass |
| New environment variable | Must be provisioned in all environments; update `.env.example` |
| `signaling/wrangler.jsonc` or `viewer/wrangler.jsonc` change | Deploy/infra config; misconfiguration causes outages |
| `scripts/deploy-signaling.sh` / `scripts/deploy-viewer.sh` change | The only deploy paths |
| CI/CD pipeline modification (`.github/workflows/**`) | Can silently suppress security checks |
| `.gitignore` changes | Could unblock accidental secret commits |
| Background job/scheduler change (rate-limit windows, session TTL, mint limiter) | Double-processing or data loss |
| Hand-editing `.claude/baseline.json` | Defeats the ratchet (see below) |
| Permission-mode change or `.claude/settings.json` edit | Disables the prompt layer, the only mechanical push covenant |
| Editing the CORE_FILES list below | Shrinks the tier-3 test trigger silently |
| Quarantining a test that covers a CORE_FILES module | Removes the one test that catches a core regression |
| Any modification to `.githooks/**` or `.github/workflows/covenant.yml` | Direct trust-root compromise |

## Governance Files Are Human-PR-Only

CLAUDE.md, the CORE_FILES list, `.claude/settings.json`, `.githooks/**`, and
`.claude/baseline.json` change exclusively via human-authored pull requests,
never via automated agent edits. The CORE_FILES list grows as the
dependency graph grows, but only through a human engineering pass. The
agent never self-maintains this constitution; the deny list in
`.claude/settings.json` enforces this mechanically.

## Permission Boundary Caveats

```
P1. PERMISSION MODE: this repo MUST NOT be operated with
    --dangerously-skip-permissions or defaultMode: bypassPermissions.
    Either nullifies the interactive prompt — the backstop evaporates
    with one CLI flag. defaultMode is pinned to "default" in the
    committed settings.json; changing it is a hard stop.
P2. COMPOUND COMMANDS: allow rules match command PREFIXES. A compound
    command ("git status && git push origin HEAD") can smuggle a push
    under an allowed prefix on any client with naive prefix matching.
    Rule: git push is ALWAYS issued as a standalone command, never
    inside &&, ;, or | chains — so the prompt always fires.
P3. FORCE-PUSH COVERAGE: the deny list blocks the named force variants,
    but refspec-force syntax (git push origin +main) cannot be
    pattern-matched. It is banned in this text and caught by the
    pre-push hook and the push-confirmation step below — never describe
    force-push as "hard-blocked" on the deny list alone.
```

## CORE_FILES

The transitive-closure trigger for mandatory Tier 3 (full suite). Editing
this list is itself a hard stop (human-PR-only).

```
src/domain/interfaces.ts        # 21 importers — the four seam interfaces
src/domain/frame.ts             # 16 importers — wire protocol type
src/domain/session.ts           # 9 importers — session state machine
src/config.ts                   # 4 importers — sole env-access point
src/composition.ts              # 3 importers — sole concretion-wiring root
src/application/protocol.ts     # 3 importers — stream multiplexer / backpressure
signaling/src/session-code.ts   # 5 importers — code mint/validate
signaling/src/session-do.ts     # structural — the Durable Object, whole pairing/relay lifecycle
signaling/src/router.ts         # structural — single HTTP/WS routing entry point
signaling/src/worker.ts         # structural — Worker fetch entry (wrangler main)
viewer/src/main.ts              # structural — viewer bootstrap entry
viewer/src/sw.ts                # structural — service worker entry
```

Import counts are grep-based (a lower bound — see T5 below); re-derive via
`git diff --stat` + import grep whenever this list is revisited, and note
that the graph is a lower bound around re-exports and dynamic imports.

## Testing (3-Tier Selection)

**No hardcoded runner assumption.** All three packages use Vitest 4.1.8
(`vitest run`); this was inferred from `package.json` `scripts.test` and
`devDependencies`, not assumed.

**Tier-2/3 tool: `vitest run --changed [ref]`** (built into Vitest — no new
dependency). 396 test cases across 37 test files exceeds the ~200-test
threshold that makes test-impact tooling mandatory at init; `--changed` was
selected over installing anything new since it ships with the already-present
Vitest devDependency in all three packages.

```
TIER 1 — per-file, during implementation:
  Run the mirrored test file for the module just touched
  (tests/<layer>/<module>.test.ts, signaling/test/<module>.test.ts,
  or viewer/test/<module>.test.ts). Seconds.

TIER 2 — impacted set, pre-commit:
  npx vitest run --changed <last_pass_sha>   (per affected package)
  PLUS: if any CORE_FILES entry is in the change set, the transitive
  closure of its dependents' tests runs to a FIXED POINT, not just one
  level — a regression in src/domain/interfaces.ts can break a file two
  import hops away whose test won't be selected by one-level reverse-deps.

TIER 3 — full suite (npm test in each touched package):
  Runs when a CORE_FILES entry changed, before PR creation, or on
  explicit request. Prefer running Tier 3 in CI over locally.
```

Rules:
- The covenant report always states which tier ran and why.
- A Tier 1/2 pass plus a ledger receipt is sufficient for a commit; PR
  merge requires a Tier 3 pass.
- Flaky tests are quarantined in the committed `quarantine.txt` with a
  linked issue — never deleted, never retried-until-green. A quarantined
  test covering a CORE_FILES module is a hard stop, not a deferral.
- **grep-is-a-lower-bound (T5):** grep-based import scanning cannot see
  dynamic imports, re-exports, or DI/fixture injection. When a changed file
  is consumed through any of these, Tier 2 selection is insufficient —
  escalate to Tier 3.

## Design Declaration (Phase 2, before any write)

Every task's design declaration must include:

```
GOAL:  <concrete, observable outcome>
VERIFY: <the specific test/command that confirms it — never "tests pass" generically>
```

Where more than one reasonable interpretation exists, don't pick silently:

```
ASSUMING: <the interpretation being proceeded on>
ALTERNATIVE: <what would change if this is wrong>
```

A checkpoint or commit lacking a stated GOAL/VERIFY pair does not satisfy
the design-declaration requirement, even if tests happen to pass. Reserve a
full STOP-and-ask for cases where no interpretation is reasonably safe.
Run the Scope Discipline check (minimum footprint, surgical boundary — no
drive-by edits, no abstractions for a single call site) before every
checkpoint write, not after the diff is already staged.

## Blocking Questions, Not Buried Ones

Every hard stop and genuine scope fork is surfaced via a structured,
blocking question mechanism (`AskUserQuestion` in this environment), never
appended as the last sentence of a longer text response. A question a
human can plausibly scroll past is worse than no safeguard at all. This
mirrors the Push Confirmation discipline below — a push is its own
explicit, un-missable exchange, never inferred from something said earlier
in the same message.

## The Commit/Push Covenant

```
STEP 1 — /audit (diff-scoped, baseline-aware): NEW CRITICAL/HIGH findings
  block and await human; MEDIUM/LOW auto-remediate and re-verify.
STEP 2 — /review (diff-scoped, ledger-aware): layer compliance,
  secrets-in-diff, lockfile assertion (any lockfile diff without an
  approved dependency addition is a hard stop).
STEP 3 — git: git update-index -q --refresh; git diff --no-ext-diff first.
  git add <specific files> — never git add -A. Conventional Commit message
  (type(scope): imperative description; types: feat|fix|refactor|test|
  perf|security|docs|chore).
STEP 4 — PUSH CONFIRMATION (mandatory, no exceptions): state the exact
  branch and remote in chat; wait for explicit human approval in this
  conversation. A prior "push" earlier in the same message does not count.
  No reply = no push, ever. The pre-push hook independently refuses
  protected branches, +refspec force syntax, and missing receipts.
```

The pipeline (recon → design declaration → stubs-first for 3+ files →
implementation → verification loop, max 3 attempts → output) runs
automatically once a task begins; the four steps above gate every commit
and push regardless of pipeline phase.

## Checkpoints

Trigger a checkpoint write (`.claude/checkpoints/<YYYYMMDD-HHMM>-<phase>.md`,
mirrored to `LATEST.md`) when pressure is HIGH — any of:

```
C1. 3 or more pipeline phases completed this session
C2. 5 or more files modified this session
C3. A hard stop fired and was resolved this session
C4. A test failure was diagnosed and fixed this session
C5. The session has run more than ~2 hours
```

Always write one, unconditionally, at end of Phase 5 (Output) and
immediately after every successful `git commit` — this is what makes
`/clear` safe: a fresh session reads `LATEST.md`, runs
`git rev-parse HEAD`, and if it matches (or descends from) the checkpoint
sha, resumes from the RESUME INSTRUCTION and announces
`"Resuming from checkpoint <timestamp>: <task>"`. On divergence, state it
and ask. Keep the 10 most recent checkpoint files.

## Environment note

No graph-query MCP tooling (`.mcp.json`) is present in this environment —
navigation is grep/Read, not a code graph. If graph tooling is added later,
this section should be updated (human PR) to reference it.
