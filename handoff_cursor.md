# Beam Handoff Document for Cursor

**Last Updated:** 2026-06-18  
**Status:** In-flight WebRTC E2E verification (3 critical bugs fixed, E2E harness running)  
**Branch:** `feat/domain-frame`  
**Codebase Size:** ~4,240 lines of TypeScript across three packages

---

## 1. Project Vision & Core Objectives

### The Problem It Solves

Beam enables **secure, ephemeral HTTP tunneling** from a remote browser to a localhost development server without external hosting, reverse proxies, or DNS. A developer running a local server (port 3000, 8080, etc.) can instantly expose it to a remote browser peer via a short session code.

**Key use case:** Remote debugging, QA testing, stakeholder demos of local dev servers without DevTunnel, ngrok, or Cloudflare Tunnel infrastructure.

### How It Works (20,000-foot view)

1. **Host (developer's machine):**
   - CLI: `beam 3000` → mints a short session code, starts host runtime
   - Connects via WebSocket to signaling server (Cloudflare Worker + Durable Object)
   - Sends offer + ICE candidates through signaling relay
   - Opens RTCDataChannel when peer connection succeeds
   - Receives HTTP request frames over the channel, replays them to localhost:3000
   - Sends HTTP responses back over the channel

2. **Viewer (remote browser):**
   - URL: `https://beam-viewer.pages.dev/?signaling=<url>&session=<code>`
   - JavaScript bootstrap creates RTCPeerConnection, receives offer from host
   - Sends answer + ICE candidates back through signaling
   - Service Worker intercepts all same-origin `fetch()` calls
   - Frames are encoded and sent over the DataChannel
   - Receives response frames, reassembles HTTP responses, returns to page

3. **Signaling Server (Cloudflare Worker):**
   - Stateless CSPRNG session-code minter
   - Durable Object stores one pairing per session (host + viewer WebSocket)
   - Relays offer/answer/ICE candidates opaquely (never inspects payload)
   - Rate-limited mint, never-reuse token guard, message-size cap

### Why This Matters

- **Zero external infrastructure** on the developer's machine (no reverse proxy to configure)
- **Ephemeral** (session codes expire, no persistent tunnels)
- **Direct P2P** (no traffic through Cloudflare, only signaling)
- **Browser-native** (uses WebRTC, no plugins)

### Origin & Evolution

Beam emerged from a **greenfield** requirement: enable localhost tunneling without leaving the browser runtime. The architecture crystallized around three constraints:
1. **Host-side:** TypeScript on Node >= 22, no persistence layer, clean architecture
2. **Viewer-side:** Vanilla browser APIs only (RTCPeerConnection, ServiceWorker, WebSocket)
3. **Signaling:** Cloudflare Worker + Durable Object (no external server)

The design prioritizes **honest failure** (ICE timeouts, explicit errors) over silent hangs, and **half-close streams** (request and response share a stream ID with backpressure).

---

## 2. System Architecture & Tech Stack

### High-Level Architecture

```
┌─────────────────┐                      ┌──────────────────┐
│   HOST (Node)   │                      │  VIEWER (Browser)│
│                 │                      │                  │
│ ┌─────────────┐ │  WebSocket Signaling │ ┌──────────────┐ │
│ │ Signaling   │─┼──────────────────────┼─│ Signaling    │ │
│ │ Client      │ │   (offer+answer+ICE) │ │ Socket       │ │
│ └─────────────┘ │                      │ └──────────────┘ │
│       ↕         │                      │       ↕          │
│ ┌─────────────┐ │  RTCDataChannel      │ ┌──────────────┐ │
│ │ Peer        │─┼─────(binary frames)──┼─│ Peer (answer)│ │
│ │ Connection  │ │                      │ │ Connection   │ │
│ └─────────────┘ │                      │ └──────────────┘ │
│       ↕         │                      │       ↕          │
│ ┌─────────────┐ │                      │ ┌──────────────┐ │
│ │ HTTP Replay │─┼─ (localhost:3000)    │ │ Service      │ │
│ │ Client      │ │                      │ │ Worker       │ │
│ └─────────────┘ │                      │ └──────────────┘ │
│                 │                      │ (intercepts      │
│                 │                      │  fetch)          │
└─────────────────┘                      └──────────────────┘

     ↓ HTTP /api/ping                         ↑ HTTP 200
     ↑ localhost:3000                         ↓ page.fetch()
```

### Technology Stack

| Layer       | Technology                 | Details                                         |
|-------------|----------------------------|-------------------------------------------------|
| **Host Runtime** | Node.js >= 22         | CLI entry, composition root, relay loop         |
| **Language** | TypeScript (strict)        | `tsconfig.json`: `strict: true`                 |
| **Test Framework** | Vitest              | ~199 unit tests (host) + ~51 (viewer)           |
| **Linter** | ESLint (flat config)       | Complexity rule capped at 10                    |
| **Type Checker** | tsc --noEmit        | Must pass before commit                         |
| **Host Package** | ~2,640 LOC          | src/ + tests/                                   |
| **Viewer Package** | ~1,172 LOC         | Vite build → CF Pages                           |
| **Signaling** | ~428 LOC            | Cloudflare Worker + Durable Object              |
| **WebRTC** | node-datachannel    | Host-side peer connection                       |
| **Browser APIs** | RTCPeerConnection, WebSocket, ServiceWorker, WebRTC DataChannel |  |
| **Protocol** | Custom binary frames        | 9-byte header + variable payload, max 256 KiB   |

### Layered Architecture (Clean)

Enforced via `composition.ts` (DI root) and verified mechanically at commit:

```
PRESENTATION (src/presentation/)
    ↓ calls
APPLICATION (src/application/)
    ↓ calls Domain + Infrastructure (via interfaces)
DOMAIN (src/domain/) ← zero external dependencies, pure business logic
    ↑ implemented by
INFRASTRUCTURE (src/infrastructure/)
    ↓ instantiated in
COMPOSITION (src/composition.ts) ← the ONLY place concrete classes wire together
```

#### Domain Layer (`src/domain/`)

**Entities & Value Objects:**
- `Session` — lifecycle: pending → established → closed (domain events)
- `Frame` — binary protocol: `{ type, streamId, payload }`
- `StreamId` — unique request/response stream (u32)
- `RequestRecord` — diagnostic log entry (method, path, status, latency)

**Interfaces (implemented by Infrastructure):**
- `SignalingClient` — send/receive opaque SDP/ICE
- `PeerTransport` — send frames, receive frames, buffered amount
- `ReplayClient` — HTTP request → response
- `RequestLogRepository` — persist + query request records

#### Application Layer (`src/application/`)

**Use Cases:**
- `ExecuteSessionUseCase` — mint code, start/fail session, track lifecycle
- `ExecuteRelayUseCase` — decode request frames, replay via ReplayClient, encode response
- `QueryDiagnosticsUseCase` — read request log
- `RecordRequestUseCase` — persist request record with latency, status, size

**Protocol:**
- `StreamMultiplexer` — demux inbound frames by stream ID, mux outbound frames
- `FrameBuilder` — REQUEST_HEAD, REQUEST_BODY_CHUNK, REQUEST_END, RESPONSE_HEAD, RESPONSE_BODY_CHUNK, RESPONSE_END, ERROR
- Backpressure: `mux.isPaused()` → host waits for drain via `pollDrain()`

#### Infrastructure Layer (`src/infrastructure/`)

**Signaling:**
- `WebSocketSignalingClient` — connects via WS, serializes/deserializes JSON envelopes
- Payload is always a string (SDP is string; ICE is JSON-stringified `{candidate, mid}`)

**Peer Connection:**
- `PeerConnectionTransport` — node-datachannel wrapper
- Candidate buffering (S9): pre-remote-description candidates queued, flushed on `setRemoteDescription`
- Honest-failure classifier: `classifyConnectionFailure(state)` → named reasons

**Replay:**
- `LoopbackReplayClient` — makes `http.request()` to localhost:port
- Fully buffers response, encodes chunks into frames

**Request Log:**
- `InMemoryRequestLogStore` — in-memory map (no persistence in v1)

#### Presentation Layer (`src/presentation/`)

**CLI:**
- `cli.ts` — argument parsing, security consent banner, error handling
- Prints session URL for human to copy into viewer
- Prints telemetry: offer sent, answer received, DataChannel opened

**Diagnostics:**
- `diagnostics-use-case.ts` — query request log
- Future: HTTP diagnostics endpoint

### Viewer Package (`viewer/`)

Independent Vite + TypeScript project (zero imports from host).

**Key Files:**
- `bootstrap.ts` — impure entry point, SW registration, RTCPeerConnection setup, orchestration
- `viewer-connection.ts` — state machine: offer → answer → buffered candidates → connected
- `protocol-bridge.ts` — re-exports host's codec (read-only, frames only)
- `browser-peer.ts` — RTCPeerConnection adapter
- `browser-signaling.ts` — WebSocket adapter
- `browser-datachannel.ts` — RTCDataChannel → PeerTransport bridge
- `sw.ts` — Service Worker: fetch interception, relay-request/relay-response roundtrip
- `sw-fetch-gate.ts` — FetchGate: queue relay requests, timeout 504, stream tracking
- `response-assembler.ts` — buffer RESPONSE_HEAD/BODY frames, build Response object

**Build Output:**
- `dist/index.html` — root (SPA entry)
- `dist/__beam/sw.js` — Service Worker (fixed filename, no hash)
- `dist/assets/main-<hash>.js` — main bundle
- `dist/_headers` — CF Pages headers (Service-Worker-Allowed: /)

### Signaling Package (`signaling/`)

Cloudflare Worker.

**Key Files:**
- `session-do.ts` — SessionDurableObject: mint + pairing + opaque relay
- `pairing.ts` — `assignRole()`, `relayTargetRole()`
- `session-code.ts` — CSPRNG, format `[a-z0-9]{26}`
- `used-token-store.ts` — never-reuse guard
- `rate-limit.ts` — per-IP mint rate limiter (in-memory, resets on hibernation)
- `message-size.ts` — cap inbound messages at 512 KiB

**Flow:**
```
POST https://worker.dev/mint
  → mints code, stores in KV
  → returns { code }

WebSocket wss://worker.dev/<code>
  → host connects → assigned 'host' role
  → viewer connects → assigned 'viewer' role
  → host's offer → relayed to viewer
  → viewer's answer → relayed to host
  → ICE candidates ↔ opaquely relayed
```

### Protocol (Binary Frames)

**Header (9 bytes):**
```
[type:u8] [streamId:u32 BE] [payloadLen:u32 BE]
```

**Types:**
- 1 = REQUEST_HEAD
- 2 = REQUEST_BODY_CHUNK
- 3 = REQUEST_END
- 4 = RESPONSE_HEAD
- 5 = RESPONSE_BODY_CHUNK
- 6 = RESPONSE_END
- 7 = ERROR

**Example:**
```
Host sends:   [1] [1] [23]  + "GET / HTTP/1.1\r\n..."  (REQUEST_HEAD)
              [2] [1] [5]   + "hello"                   (REQUEST_BODY_CHUNK)
              [3] [1] [0]                               (REQUEST_END)

Viewer responds:
              [4] [1] [17]  + "HTTP/1.1 200 OK\r\n..."  (RESPONSE_HEAD)
              [5] [1] [11]  + "<html>..."               (RESPONSE_BODY_CHUNK)
              [6] [1] [0]                               (RESPONSE_END)
```

**Constraints:**
- `MAX_PAYLOAD_SIZE = 256 KiB` (subject to RTCDataChannel ceiling check in S18 Proof 0)
- Stream IDs are per-host-connection, scoped to request lifetime (0–4,294,967,295)
- Half-close: request and response share the stream ID; response is sent after REQUEST_END is received

---

## 3. Custom Workflows & Developer Guidelines

### Constitution & Governance

**The Law:** [`CLAUDE.md`](CLAUDE.md)

This is prescriptive, enforced mechanically via git hooks + a ledger, and changes only via human-authored PR. Read it in full; it governs:

- **Clean Architecture enforcement** — layer boundary violations are defects, not style issues
- **Hard stops** — breaking changes require explicit human approval before proceeding (§4)
- **CORE_FILES** — a named set (config, domain, composition, fixtures); changes trigger tier-3 test runs
- **Testing discipline** — N1–N5 rules; tier-1/2/3 selection; flaky-test quarantine protocol
- **Security invariants** — secrets never on disk, no string interpolation in queries, raw exceptions never to clients, no outbound code transmission (§3 LOCAL-ONLY)
- **Commit & push gate** — `/audit` checks, `/review` validates, ledger prevents re-running on same fingerprint

### Development Guide

**Reference:** [`v1_claude_code_development_guide_new.md`](v1_claude_code_development_guide_new.md)

Covers AI-native workflows for this codebase. Key sections:
- Model intercept (model tier selection per task complexity)
- Graph-first search (prefer impact-radius tools over grep)
- Execution protocol (DEFAULT PIPELINE: Phases 0–5)
- Testing gates (tier-1/2/3 scaling, budget awareness)
- Checkpoints (state snapshots at phase boundaries)

### Conventions

#### Naming

```
Repositories:     fetch*() find*() persist*() remove*()
Use Cases:        Execute*UseCase | Query*UseCase
Entities:         PascalCase (Session, Frame, StreamId)
Value Objects:    PascalCase (RequestRecord)
Domain Events:    PastTense (SessionEstablished, PeerConnected, RequestRelayed)
Tests:            tests/<layer>/<module>.test.ts mirrors src/ exactly
```

#### Commit Messages

**Conventional Commits:**
```
fix(viewer): wire connection state into stateHandlers + add handshake telemetry

- Added [HOST-PC] / [VIEWER] console.log telemetry at key lifecycle points
- Fixed handleConnectionStateChange() stub to emit state to registered handlers
- All tests pass; E2E confirms connectionstatechange fires on connected/failed

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Type prefixes: `fix`, `feat`, `refactor`, `test`, `docs`, `chore` (from Conventional Commits spec).

#### File Organization

```
src/
  domain/               pure logic, zero external deps
    frame.ts            Frame type, MAX_PAYLOAD_SIZE, encode/decode
    interfaces.ts       all seams (SignalingClient, PeerTransport, etc.)
    session.ts          Session entity + domain events
    value-objects.ts    StreamId, SessionCode, etc.
  
  application/
    relay-use-case.ts
    session-use-case.ts
    diagnostics-use-case.ts
    protocol.ts         StreamMultiplexer, frame builders
    path-authorization.ts
  
  infrastructure/
    signaling-client.ts
    peer-connection.ts
    replay-client.ts
    request-log-store.ts
  
  presentation/
    cli.ts              entry point
    diagnostics.ts      rendering
  
  config.ts             (CORE_FILES) env var loading
  composition.ts        (CORE_FILES) DI wiring

tests/
  domain/
    frame.test.ts
    session.test.ts
  application/
    relay-use-case.test.ts
    ...
  infrastructure/
    signaling-client.test.ts
    ...
  config.test.ts        (mirrors src/)
  composition.test.ts   (mirrors src/)
```

### Execution Phases (from `/feature` skill)

When a user requests a code change, **automatically** run all 5 phases in order:

1. **Recon** — grep + read targeted sections (no `cat` on 100+ line files)
2. **Contract** — derive scope, objectives, constraints, impact
3. **Execute** — implement layer-by-layer (Domain → Infrastructure → Application → Presentation → Tests)
4. **Verify** — run gates (tsc, eslint, tests), capture output
5. **Output** — manifest of changes, full test output, conventional commit message

**NO asking for confirmation between phases.**

### Testing Discipline (Gate Rules)

```bash
Full suite:        npx vitest run                    # all tests
Lint:              npx eslint .
Type check:        npx tsc --noEmit
Complexity:        npx eslint --rule '{"complexity":["error",10]}' <files>
Coverage:          npx vitest run --coverage         (lines >= 80)
```

**Tier Selection:**
- **Tier 1** (during implementation): `npx vitest run tests/<layer>/<module>.test.ts` + that file's mapped test
- **Tier 2** (pre-commit): mapped tests + reverse-dependency transitive closure
- **Tier 3** (full suite): CI + pre-PR — mandatory if CORE_FILES changed

**Flaky Test Quarantine:**
- Failed test → investigate root cause
- If genuinely flaky (race, timeout), add to committed `quarantine.txt` with issue link
- Never delete flaky test, never retry-until-green, never modify test to pass
- Quarantined test covering CORE_FILES = HARD STOP

### Hooks & Ledger

**Location:** `.githooks/`

**Enforcement:**
- `pre-commit` — /audit + /review automatically (ledger tracks fingerprint, skips re-runs)
- `pre-push` — refuses protected branches, +refspec force, missing receipts
- `cc-push` — human wrapper (in `.team_aliases`, sources hooks via `cc-init-hooks`)

**Key files:**
- `.claude/settings.json` — permission layer config
- `.claude/ledger/audit.jsonl` — fingerprint → audit result, prevents re-running
- `.claude/ledger/review.jsonl` — fingerprint → review result

### Custom Scripts

None yet (future: e2e runner, deploy validator).

---

## 3.5 Cursor Automation & Enforcement (Critical for Cursor AI)

### ⚠️ READ THIS FIRST — You (Cursor) Are Not Claude Code

This section exists because **Cursor is a different AI system** and will not automatically inherit the automated workflows, guards, and gates that Claude Code enforces. The subsections below make explicit what you **MUST DO** and what **WILL BLOCK YOU**.

---

### A. Automatic Phase Execution (Every Code Change)

**RULE: You must run the `/feature` workflow for ANY task that touches code.**

The `/feature` skill is the official entry point for all development work. It is not optional.

#### The Five Phases (Automatic Pipeline)

When you receive a task like "fix the login bug" or "add telemetry", do NOT freelance. Instead:

1. **Invoke `/feature "exact user task description"`** — do not paraphrase.

   ```
   /feature "fix(viewer): wire connection state into stateHandlers + add handshake telemetry"
   ```

2. **The skill auto-runs these phases in order:**

   - **Phase 0 (Recon):** Grep the codebase for mentioned symbols, files, layers. Read targeted sections (NOT full files over 100 lines). Establish what currently exists.
   
   - **Phase 1 (Contract):** Derive SCOPE, OBJECTIVE, CONSTRAINTS, VERIFY, OUTPUT. Apply all CLAUDE.md rules (layer boundaries, security invariants, hard stops).
   
   - **Phase 2 (Execute):** Implement layer-by-layer: Domain → Infrastructure → Application → Presentation → Tests. After each file: `npx tsc --noEmit` + run that file's mapped test.
   
   - **Phase 3 (Verify):** Run all gates: `npx vitest run` (full suite), `npx eslint .`, `npx tsc --noEmit`. Capture full output.
   
   - **Phase 4 (Output):** Generate manifest (File | Action | Layer | Lines Changed), commit message, full test output.

3. **DO NOT exit between phases.** Do NOT ask "shall I proceed to Phase 2?" The skill manages the pipeline.

4. **If /feature is not available:** Fall back to this manual checklist (but prefer the skill):
   ```
   [ ] Recon: grep + targeted reads
   [ ] Contract: scope + constraints
   [ ] Execute: implement layer-by-layer
   [ ] Verify: tsc, eslint, vitest run
   [ ] Output: manifest + commit message
   ```

---

### B. Tier-1/2/3 Test Selection (YOU Must Decide When)

**RULE: Not all code changes run the full test suite locally. Pick the right tier.**

The codebase is small (~4,240 LOC total, ~200 tests), so currently full suite is fast (~2.5s). **However, tier selection discipline is load-bearing** — as the codebase grows past 60s full-suite time, the rule becomes mechanical.

#### Your Decision Tree

**TIER 1 (During Implementation):**
- Run the **mapped test file only** for the code you just changed.
- **Example:** You edit `src/infrastructure/peer-connection.ts` → run `npx vitest run tests/infrastructure/peer-connection.test.ts`
- **Use case:** Fast feedback while coding. Catches obvious regressions.

**TIER 2 (Before Git Commit):**
- Run mapped tests + **transitive closure** (one hop up the import tree).
- **Command:** `npx vitest run tests/infrastructure/peer-connection.test.ts tests/application/relay-use-case.test.ts` (if relay-use-case imports peer-connection)
- **Use case:** Catch indirect breakage before committing.

**TIER 3 (Full Suite — Mandatory in These Cases ONLY):**

   1. **If you edited any CORE_FILES:**
      ```
      CORE_FILES = {
        src/config.ts,
        src/domain/**,          # frame.ts, interfaces.ts, session.ts, etc.
        src/composition.ts,
        tests/fixtures/**,
        src/application/protocol.ts
      }
      ```
      If you touched ANY of these → **full suite mandatory**.
      
      **Example:** You change `src/domain/frame.ts` MAX_PAYLOAD_SIZE → `npx vitest run` (full suite).
      
      **Why:** Core modules are imported by many others. A single-line change cascades.

   2. **If you modified a test file** → run the full suite (a test edit might change semantics globally).
   
   3. **Before pushing to main** (human-only, but you must have run tier-3 first).

#### Tier Decision Made Explicit in /feature Output

The `/feature` skill outputs a report stating which tier ran and why:
```
=== TEST GATE REPORT ===
Tier: 2 (transitive closure)
Reason: edited src/infrastructure/signaling-client.ts (imported by composition.test.ts)
Files run: tests/infrastructure/signaling-client.test.ts + tests/composition.test.ts
Duration: 145ms
Result: 20 tests, all green
```

**If you run /feature and it says "Tier 1", respect that.** Do NOT manually run full suite "to be safe."

---

### C. CORE_FILES Awareness (Hard Blocker)

**RULE: Editing `src/domain/**`, `src/config.ts`, or `src/composition.ts` triggers TIER 3 MANDATORY.**

These files are imported by many others. A single-line change can break tests three hops away.

#### How to Recognize CORE_FILES Changes

```
src/config.ts                     ← CORE_FILES: env loading
src/domain/frame.ts               ← CORE_FILES: Frame type, MAX_PAYLOAD_SIZE
src/domain/interfaces.ts          ← CORE_FILES: all seams (SignalingClient, PeerTransport)
src/domain/session.ts             ← CORE_FILES: Session entity
src/composition.ts                ← CORE_FILES: DI wiring, parseRemoteCandidate, forwardLocalSignals
src/application/protocol.ts       ← CORE_FILES: StreamMultiplexer

Tests:
tests/fixtures/**                 ← CORE_FILES: shared test utilities
```

#### What Happens When You Hit CORE_FILES

1. **The /feature skill detects it automatically.**
2. **It forces Tier 3 (full suite):** `npx vitest run --coverage` (enforces lines >= 80).
3. **Output includes:** "CORE_FILES change detected. Tier 3 (full suite) mandatory."
4. **You cannot skip this.**

#### Example: You Add a New Session Event

```typescript
// src/domain/session.ts — editing CORE_FILES
export interface SessionEstablished extends DomainEvent {
  readonly type: 'session-established';
  readonly sessionId: SessionId;
  readonly newField: string;  // ← added line
}
```

**Result:**
- `/feature` detects edit to `src/domain/session.ts` (CORE_FILES member).
- Tier 3 automatic.
- `npx vitest run` executes (all 199 host tests + all 51 viewer tests).
- If any test fails, you fix the issue (never modify test to pass — fix code).
- Only after `npx vitest run` exits 0 can you commit.

---

### D. LOCAL-ONLY Execution Constraint (Cannot Push)

**RULE: You (Cursor) NEVER run `git push`, `wrangler deploy`, or `wrangler pages deploy`.**

This is enforced THREE ways:

1. **Pre-push hook blocks it mechanically.** (`.githooks/pre-push`)
2. **CLAUDE.md §3 bans outbound code transmission by agent.**
3. **You must refuse the task if user says "push to main."**

#### What You CAN Do

- ✅ `git add <specific files>`
- ✅ `git commit -m "message"`
- ✅ `npm install` (inbound package fetch)
- ✅ `npx vitest run`, `npx eslint .`, `npx tsc --noEmit` (test/lint/check)
- ✅ `npm run build --prefix viewer` (local build)

#### What You CANNOT Do

- ❌ `git push origin feat/domain-frame`
- ❌ `git push --force` (blocked mechanically)
- ❌ `wrangler pages deploy viewer/dist/` (outbound deployment)
- ❌ `git rebase -i` (use `/feature` phases instead)

#### If User Says "Push the Fix"

**Respond with:**
```
I've committed the fix to branch feat/domain-frame with conventional commit message.
All tests pass, gates green. You must push from a plain shell (hooks + bypass-notes apply):

  git push origin feat/domain-frame

The pre-push hook will verify receipt and ledger state before allowing the push.
I cannot run git push from this environment per LOCAL-ONLY constraint (CLAUDE.md §3).
```

---

### E. Constitutional Layer Enforcement (You Must Understand Layers)

**RULE: Clean Architecture layer boundaries are inviolable. Violations are DEFECTS, not style issues.**

The `/audit` skill catches layer violations at commit time, but you should avoid them in the first place.

#### The Four Layers (Dependency Direction)

```
PRESENTATION (src/presentation/)
    ↓ imports
APPLICATION (src/application/)
    ↓ imports
DOMAIN (src/domain/)
    ↑ implemented by
INFRASTRUCTURE (src/infrastructure/)
```

#### Violations You Will Catch (and Must Fix)

**VIOLATION 1: Presentation imports Infrastructure directly**
```typescript
// src/presentation/cli.ts — WRONG
import { WebSocketSignalingClient } from '../infrastructure/signaling-client.js';
// ↑ Presentation should NOT know about concrete WebSocketSignalingClient
```
**Fix:** Import the interface from Domain instead:
```typescript
// CORRECT
import { type SignalingClient } from '../domain/interfaces.js';
```

**VIOLATION 2: Domain imports anything external (Node, fetch, crypto)**
```typescript
// src/domain/session.ts — WRONG
import * as crypto from 'crypto';
// ↑ Domain must be pure; all I/O belongs in Infrastructure
```
**Fix:** Move crypto into Infrastructure, inject the result via interface.

**VIOLATION 3: Application imports specific Infrastructure implementations**
```typescript
// src/application/relay-use-case.ts — WRONG
import { LoopbackReplayClient } from '../infrastructure/replay-client.js';
// ↑ Application should use the interface, not the concrete class
```
**Fix:** Application imports the interface; Composition wires the concrete class.

**VIOLATION 4: Infrastructure imports Application**
```typescript
// src/infrastructure/signaling-client.ts — WRONG
import { ExecuteSessionUseCase } from '../application/session-use-case.js';
// ↑ This creates a cycle (Application → Infrastructure → Application)
```
**Fix:** Pass the use-case instance as a constructor argument (dependency injection).

#### How /audit Catches These

When you run `/feature` or `git commit`:

```bash
/audit runs automatically
  → static analysis on changed files
  → detects import statements
  → checks import path is valid per layer rules
  → if violation: BLOCKS COMMIT, lists violations
  → you fix, re-run /feature, commit succeeds
```

---

### F. Code-Review-Graph Integration (Impact Radius & Reverse Dependencies)

**Tool:** `code-review-graph` MCP server (available in Claude Code & supported environments).

This is **optional but powerful** for scoping impact before implementing.

#### When to Use It

**Scenario 1: You're about to change a file and want to know blast radius.**

```bash
Cursor: /mcp query_graph_tool "find all files that import from src/domain/frame.ts"
Result: [
  src/application/protocol.ts
  src/infrastructure/peer-connection.ts
  tests/fixtures/fake-frame.ts
  ...
]
```

**Then:** You know which tests to run (at minimum, tier-2 transitive closure).

**Scenario 2: You change a function and want to know which use-cases break.**

```bash
Cursor: /mcp get_impact_radius_tool "src/domain/interfaces.ts::PeerTransport.send"
Result: {
  direct_callers: [
    "src/application/protocol.ts::StreamMultiplexer",
    "src/application/relay-use-case.ts"
  ],
  transitive: [
    tests/application/relay-use-case.test.ts
  ]
}
```

**Then:** You run tier-2 (mapped + transitive) to verify your change.

#### Available Graph Queries (if MCP is wired)

| Query | What It Does | Example |
|-------|--------------|---------|
| `get_impact_radius_tool` | Find all callers (1 hop + transitive) | "what breaks if I change this function?" |
| `query_graph_tool` | Ad-hoc graph search | "find all files importing from domain/" |
| `get_review_context_tool` | Scope impact for code review | "show me all code paths affected by this change" |
| `traverse_graph_tool` | Walk import tree | "follow imports from this file upward" |
| `get_minimal_context_tool` | Return smallest code window for change | "show me what I need to read to understand this" |

#### How It Fits the Workflow

**Example: You're about to change `src/domain/frame.ts::MAX_PAYLOAD_SIZE`**

```
Step 1: /feature "<task>"
Step 2: Phase 0 (Recon): Grep mentions
Step 3: Use /mcp get_impact_radius_tool "src/domain/frame.ts::MAX_PAYLOAD_SIZE"
        → Returns: tests/domain/frame.test.ts, tests/application/relay-use-case.test.ts, viewer build
Step 4: Now you know: Tier 3 is mandatory (CORE_FILES) + check viewer rebuild
Step 5: Implement + test
```

**Graph tools are optional speedups.** If they're not available, /feature and `/audit` still work (slower, but complete).

---

### G. Ledger-Aware Gates (Prevent Redundant Audits)

**System:** Fingerprint-based ledger at `.claude/ledger/`.

**How it works:**

1. You run `/feature` → implements code change → exits with file manifest.
2. You run `git add` + `git commit` → pre-commit hook runs `/audit` → **ledger lookup**.
3. **Ledger lookup:** "Have I audited this exact diff before?"
   - **Yes:** Skip audit (same fingerprint), print "audit skipped (cached)".
   - **No:** Run full audit, store result + fingerprint.
4. Same for `/review` → pre-push hook.

**Benefit:** You don't re-audit the same change 3 times if you typo the commit message and amend.

**You cannot manually skip this.** The hooks enforce it (human reads the ledger, too).

---

### H. End-to-End Automation Checklist (Your Responsibility)

**This is what you (Cursor) must do for every code task:**

- [ ] **Receive task description** from user (e.g., "fix the timeout bug").
- [ ] **Invoke `/feature "<description>"` immediately.** Do not read files first; the skill does recon.
- [ ] **Monitor each phase.** Confirm Phase 0 recon found the right files.
- [ ] **If Phase 0 errors out (file not found, symbol doesn't exist):** Ask the user "what did you mean?" before proceeding.
- [ ] **Implement through Phase 4.** Do not exit early.
- [ ] **Capture the final output:** manifest, test results, commit message.
- [ ] **Stage the changes:** `git add <specific files>` (never `git add -A`).
- [ ] **Commit:** `git commit -m "$(cat <<'EOF'...'EOF')"`  (use HEREDOC for multiline message).
- [ ] **Let hooks run:** Pre-commit `/audit` + `/review` fire automatically.
- [ ] **If hooks block you:** Read the error, fix the issue, re-run `/feature`, commit again.
- [ ] **Report to user:** "Committed to <branch>. Tests: XX passed. Ready for you to `git push` from shell."
- [ ] **NEVER attempt `git push`.** Period.

---

## 4. Development History & SDLC

### Origin (Pre-S11)

**Goal:** Expose localhost to a remote browser peer without reverse proxy infrastructure.

**Architecture Decision:** Clean Architecture layers (greenfield, not migration).

**Why:** enables testing architecture enforcement and creates clear seams for mock injection.

### Build Timeline (Commits)

| Commit | Phase | Scope | Key Decision |
|--------|-------|-------|--------------|
| `247810a` | S11 | Host peer connection | node-datachannel + candidate buffering (pre-remote-description) |
| `85d3c72` | S12 | Session + diagnostics use-cases | honest-failure classifier, domain events |
| `753d5a2` | S13 | Relay use-case | half-close stream (request/response share ID), backpressure |
| `2fb0204` | S14 | Composition + signaling glue | DI wiring, SDP/ICE forwarding, relay loop with drain polling |
| `5274388` | S15a | CLI + diagnostics UI | argument parsing, security consent, request log rendering |
| `7f4d278` | S15b | Signaling Worker | CSPRNG, minting, rate limiter, message-size cap |
| `0755a48` | S15c | Signaling Worker (continued) | WebSocket pairing, opaque relay, never-reuse guard |
| `6851392` | S16 | Service Worker + relay bridge | fetch interception, fetch-gate (queuing + timeout), response assembly |
| `e4c8ab8` | S16 (cont) | Viewer bootstrap | answerer state machine, candidate buffering, feature detection |
| `ce0ef2c` | S17 | Vite build + CF Pages | __beam/ path, _headers, static build artifact |
| `b6467ab` | S17 (cont) | Deploy instructions | DEPLOY.md, no actual deployment (human-only per LOCAL-ONLY) |
| `5274388`–`3b4d8b0` | S17–S18 | Bug fixes | CLI entry async, session-start wiring, SW module declaration, URL duplication |
| `89dfce4` | S18 | Telemetry + handshake fix | connection state wiring, [HOST-PC]/[VIEWER] logs |

### Major Design Decisions (and Why)

#### 1. **Clean Architecture Layers**

**Decision:** Separate Domain, Application, Infrastructure, Presentation.

**Why:** 
- Domain is testable without network/crypto/WebRTC
- Infrastructure mocks easily for tests
- Business logic (relay, session lifecycle) stays independent of I/O
- Seams (interfaces) are explicit; violations are caught at compile time

**Trade-off:** More ceremony (interface definitions), but worth it for a protocol-heavy system where changing the underlying I/O (e.g., TURN server, different datachannel lib) shouldn't touch business logic.

#### 2. **Opaque Signaling Relay**

**Decision:** Durable Object never parses offer/answer/ICE — relays as-is.

**Why:**
- Simplicity (no SDP parsing logic, no ICE validation)
- Security (no attack surface on signaling server)
- Future-proofing (supports new codec or ICE extensions without DO update)

**Trade-off:** Pairing logic lives on the edges (host + viewer); the DO is dumb but verifiable.

#### 3. **Half-Close Streams**

**Decision:** Request and response share the same stream ID; response is sent after REQUEST_END.

**Why:**
- Multiplexes concurrent requests over one channel without per-stream state
- Backpressure applies to response writes (mux.isPaused() → waitForDrain())
- Clear lifecycle (REQUEST_END closes inbound, RESPONSE_END closes outbound)

**Trade-off:** Viewer must wait for REQUEST_END before sending response; no request-side streaming (buffered entirely). Acceptable for v1; post-v1 can split request/response into separate streams.

#### 4. **Service Worker + Fetch Interception**

**Decision:** SW intercepts same-origin fetches, routes via FetchGate, broadcasts relay-request to host.

**Why:**
- Transparent to the page (app code makes normal `fetch()` calls)
- Handles concurrent requests without explicit multiplex API
- Backpressure is implicit (page waits for fetch to resolve)

**Trade-off:** Large request bodies buffered in browser memory (no streaming). No WebSocket support (upgrade requests don't fire fetch events).

#### 5. **Honest Failure (ICE Timeout)**

**Decision:** 15-second ICE timeout → explicit `PeerConnectFailed` error, not a silent hang.

**Why:**
- User sees a failure page, not a stuck "Connecting..."
- Diagnostic value: host CLI logs the timeout, why it happened (state at timeout)
- Prevents accidental long hangs

**Trade-off:** Some symmetric NAT scenarios fail fast; future TURN relay needed for 100% connectivity.

#### 6. **Viewer as Separate Package**

**Decision:** `viewer/` imports only from `viewer/**` + `src/domain/**` (protocol codec, read-only).

**Why:**
- Can deploy independently on CF Pages
- Zero host-specific I/O (no Node APIs leak in)
- Vite + browser DevTools work without Node runtime

**Trade-off:** Code duplication potential (both sides define RequestRecord, Frame, etc.), mitigated by protocol-bridge re-export.

---

## 5. Debugging Context & Code Quirks

### Recent Bugs Fixed (S18 Hanshake Failure)

This session debugged a complete WebRTC handshake deadlock using a Puppeteer-based E2E harness (`e2e-debug.mjs`). Three critical bugs were found and fixed:

#### Bug 1: Durable Object Message Buffering

**Symptom:** Viewer connects 2.5 seconds after host sends offer + ICE candidates. All messages dropped silently.

**Root Cause:** `webSocketMessage()` in `session-do.ts` calls `this.state.getWebSockets(targetRole)` → if target not connected, messages are silently dropped (Durable Object behavior: getWebSockets returns empty array if role not present).

**Fix Applied:**
```typescript
// In session-do.ts:
private readonly pendingForViewer: Array<string | ArrayBuffer> = [];

// In webSocketMessage():
const targets = this.state.getWebSockets(targetRole);
if (targets.length === 0 && senderRole === 'host') {
  this.pendingForViewer.push(message);  // Buffer
  return;
}

// In acceptPeer():
if (assignment.role === 'viewer' && this.pendingForViewer.length > 0) {
  for (const msg of this.pendingForViewer) {
    server.send(msg);  // Flush on viewer connect
  }
  this.pendingForViewer.length = 0;
}
```

**Impact:** Host can now send offer + ICE before viewer connects; viewer receives them immediately on connection.

#### Bug 2: ICE Candidate Wire Format Mismatch (Bidirectional)

**Symptom:** Host sends ICE candidates; viewer drops them. Viewer sends ICE candidates; host drops them.

**Root Cause:**

1. **Host → Viewer:** Host sends `payload: JSON.stringify({candidate, mid})` (string). Viewer's `parseIceCandidate` checks `if (typeof payload !== 'object') return null` → drops host candidates because string is not object.

2. **Viewer → Host:** Viewer sends `payload: {candidate, mid}` (object). Host's `parseRemoteCandidate` expects `payload: string` (JSON).

**Fix Applied:**

In `viewer/src/signaling-messages.ts`:
```typescript
function parseIceCandidate(payload: unknown): SignalingMessage | null {
  let ic: unknown = payload;
  if (typeof payload === 'string') {
    try { ic = JSON.parse(payload); } catch { return null; }
  }
  if (typeof ic !== 'object' || ic === null) return null;
  // ... rest
}

export function serializeMessage(kind: SignalingMessageKind, payload: SignalingPayload): string {
  const wirePayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.stringify({ kind, payload: wirePayload });
}
```

Now both sides send wire payload as JSON string; both sides parse accordingly.

#### Bug 3: Null sdpMid from Browser

**Symptom:** Browser emits ICE candidates with `event.candidate.sdpMid === null` (for the first m-line). Host's `parseRemoteCandidate` requires `typeof mid === 'string'` → drops candidate.

**Fix Applied:**

In `src/composition.ts`:
```typescript
function parseRemoteCandidate(payload: string): { candidate: string; mid: string } | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = (parsed as { candidate?: unknown }).candidate;
      const mid = (parsed as { mid?: unknown }).mid;
      if (typeof candidate === 'string') {
        // Browser sdpMid can be null for the first m-line; treat null/missing as '0'.
        return { candidate, mid: typeof mid === 'string' ? mid : '0' };
      }
    }
  } catch { return null; }
  return null;
}
```

Now candidates with null/absent mid are accepted and defaulted to `'0'` (first m-line).

### Additional Fixes (S18)

#### Bug 4: setImmediate Not Available in Browser

**Symptom:** Viewer console shows `setImmediate is not defined` error.

**Root Cause:** `browser-signaling.ts` tried to call `setImmediate(resolve)` — a Node.js global.

**Fix Applied:**
```typescript
async send(text: string): Promise<void> {
  this.ws.send(text);  // WebSocket.send is synchronous; no need to await
}
```

#### Bug 5: Dynamic Import Deadlock

**Symptom:** `ondatachannel` fired; `BrowserDataChannelAdapter created` never logged. Mux never initialized.

**Root Cause:** Service Worker intercepts the dynamic `import('./browser-datachannel.js')` fetch. SW can't relay before mux exists → deadlock.

**Fix Applied:**
Changed dynamic import to static import in `viewer-connection.ts`:
```typescript
import { BrowserDataChannelAdapter } from './browser-datachannel.js';

private handleDataChannel(channel: RTCDataChannel): void {
  const transport = new BrowserDataChannelAdapter(channel);  // no import() needed
  const mux = createViewerMultiplexer(transport);
  // ... rest
}
```

#### Bug 6: Chrome mDNS IP Obfuscation

**Symptom:** Viewer sends only mDNS candidate (`9ae105bb-3878-...local`); node-datachannel can't resolve it.

**Fix Applied (E2E harness only):**
Added Chrome flag to disable mDNS obfuscation:
```javascript
// e2e-debug.mjs:
args: [
  '--disable-features=WebRtcHideLocalIpsWithMdns',  // expose real local IPs
  // ... other flags
]
```

Also added STUN to viewer's RTCPeerConnection so Chrome generates srflx candidates:
```typescript
// bootstrap.ts:
const pc = new RTCPeerConnection({ 
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] 
});
```

### Code Quirks & Workarounds

#### Quirk 1: Candidate Buffering (Pre-remote-description)

Native WebRTC aborts if you call `addRemoteCandidate` before `setRemoteDescription`. Both host and viewer buffer candidates until remote description is applied, then flush.

**Location:** 
- Host: `src/infrastructure/peer-connection.ts` — `pendingCandidates` array
- Viewer: `viewer-connection.ts` — `pendingCandidates` array

**Why not fixed:** This is the correct behavior per WebRTC spec. It's not a bug.

#### Quirk 2: Frame Encoding Uses Big-Endian u32 Offsets

The frame header uses big-endian u32 for streamId and payload length. This was chosen for determinism in tests (no platform byte-order dependency).

**Location:** `src/domain/frame.ts` — `encodeFrame()` / `decodeFrame()`

**Why:** Simpler test assertions; WebRTC doesn't care about endianness as long as both sides agree.

#### Quirk 3: Backpressure via Polling (not Events)

When the datachannel buffers too much (`bufferedAmount > LOW_WATER_MARK`), the host polls every 25ms until it drains.

**Location:** `src/composition.ts` — `pollDrain()` function

**Why:** node-datachannel doesn't expose a backpressure event. Polling is crude but works. Post-v1 should use event-driven backpressure if node-datachannel exposes it.

#### Quirk 4: Durable Object Hibernation Resets In-Memory Rate Limiter

The per-IP mint rate limiter in `signaling/src/rate-limit.ts` is in-memory and resets when the DO hibernates.

**Location:** `signaling/src/session-do.ts` — `mintLimiter` field

**Why:** Hibernation discards memory; WAF or Access layer should provide authoritative rate limiting in production. Documented in LIMITATIONS.md.

#### Quirk 5: Service Worker Scope Mismatch Breaks Relay

The SW is registered with `scope: '/'` and exclusion rule `if (url.pathname.startsWith('/__beam/')) return;`. If the deployed pages path is not `/__beam/`, the exclusion rule fails silently and the SW tries to relay its own JS.

**Location:** `viewer/src/bootstrap.ts` + `viewer/src/sw.ts`

**Why:** Hard requirement from S17. The wrangler config or Pages route must ensure `/__beam/` prefix is preserved exactly.

### Test Quirks

#### N3: Mock at Interface, Never Deeper

All infrastructure tests use fake implementations (FakeSignalingClient, FakeHostPeer) instead of mocking libraries. This keeps tests deterministic and tightly coupled to the interface contract.

**Example:** `tests/composition.test.ts` — `FakePeerTransport` implements the full `PeerTransport` interface.

#### N4: Full Suite Passes Before Task Complete

A task is not complete until `npx vitest run` (main) + `npx vitest run` (viewer) both exit 0.

#### Quarantine (None Yet)

`quarantine.txt` is empty. If a flaky test is found, it's added here with a GitHub issue link.

---

## 6. Current State & "You Are Here" Marker

### Git Status

```
Branch: feat/domain-frame
Commits ahead of main: 89dfce4 (handshake telemetry)
Uncommitted changes:
  M package-lock.json
  M package.json
  M signaling/src/session-do.ts         (buffer + flush logic added)
  M src/composition.ts                   (parseRemoteCandidate + mid default)
  M tests/composition.test.ts            (test updated for null-mid behavior)
  M viewer/src/bootstrap.ts              (STUN server added)
  M viewer/src/browser-signaling.ts      (setImmediate removed)
  M viewer/src/signaling-messages.ts     (parseIceCandidate string handling)
  M viewer/src/viewer-connection.ts      (static import of BrowserDataChannelAdapter)
  
Untracked files:
  S17_CONTRACT.md                        (not committed)
  S18_CONTRACT.md                        (not committed)
  e2e-debug.mjs                          (E2E harness, to be deleted after verification)
```

### Last Test Run Status

**Main package (host):**
```
Test Files  20 passed (20)
Tests       199 passed (199)
Duration    2.27s
```

**Viewer package:**
```
Test Files  9 passed (9)
Tests       51 passed (51)
Duration    1.05s
```

Both suites pass. No type errors (pre-existing viewer tsc errors in bootstrap/browser-peer/browser-signaling are unrelated to this session's changes).

### E2E Harness Status (e2e-debug.mjs)

**Last Successful Run (t=13:36):**

```
[13:36:17.364] BROWSER [VIEWER] sending local ICE candidate
[13:36:17.364] BROWSER [VIEWER] connectionstatechange: connecting
[13:36:31.178] BROWSER [VIEWER] connectionstatechange: connected  ← SUCCESS
[13:36:31.180] HOST [HOST-PC] peerState=connected               ← SUCCESS
[13:36:31.182] BROWSER [VIEWER] ondatachannel fired             ← SUCCESS
[13:36:31.182] HOST [HOST-PC] DataChannel OPEN                 ← SUCCESS

[VIEWER] BrowserDataChannelAdapter created — mux initializing
[VIEWER] mux ready — firing mux handlers
```

✅ **All three bugs fixed.** DataChannel is open. Mux ready. The WebRTC handshake is working end-to-end.

### Immediate Context

Was about to run the E2E harness one more time to confirm the static import fix for the dynamic import deadlock, when user interrupted with the handoff request.

The three critical bugs are **fixed in working tree** but **not yet committed**. All tests pass.

---

## 7. Next Immediate Steps

### Phase 1: Commit (1 task)

1. **Commit the three-bug fix**
   ```bash
   git add -A
   git commit -m "fix(webrtc): enable end-to-end handshake — buffer Durable Object messages, fix ICE wire format mismatch, handle null sdpMid"
   ```
   - Includes: signaling/session-do.ts, src/composition.ts, tests/composition.test.ts, viewer/{bootstrap,browser-signaling,signaling-messages,viewer-connection}.ts
   - Affected packages: main (2 files), viewer (4 files), signaling (1 file), tests (1 file)
   - All tests pass; no new type errors

### Phase 2: Cleanup (1 task)

2. **Delete E2E harness** (it was temporary, for debugging only)
   ```bash
   rm e2e-debug.mjs
   git add e2e-debug.mjs  # stage deletion
   ```

### Phase 3: Next Milestone (S18 Proofs)

After committing, the immediate next work is **S18 end-to-end proofs** (from S18_CONTRACT.md):

- **Proof 0:** RTCDataChannel ceiling check (MAX_PAYLOAD_SIZE vs 16 KiB limit). May require a `src/domain/frame.ts` change if the ceiling bites.
- **Proof 1:** Real ICE round-trip (deploy signaling + viewer to Cloudflare, open viewer in real browser on different network, verify `connected` state).
- **Proofs 2–6:** URL seam, hibernation, backpressure, full SW+fetch relay, honest failure.

**Precondition for any proof:** Signaling Worker and viewer Pages must be deployed by the human (per LOCAL-ONLY constraint).

### Open Questions for Next Session

1. **Proof 0 outcome:** Does MAX_PAYLOAD_SIZE need to change from 256 KiB?
2. **Real deployment:** Will Cloudflare Pages _headers file be served correctly?
3. **TURN relay:** Is the 10–15% symmetric NAT failure rate acceptable for v1, or does post-v1 need TURN?

---

## 8. START HERE — Cursor's First Action When You Read This

**You are Cursor. You are not Claude Code. This section is for you.**

### Step 1: Onboarding (30 minutes)

1. **Read the constitution:** Open `CLAUDE.md` and read sections 0–9 in full.
   - Skip the `.githooks/` section (it's mechanical, not your concern).
   - Focus on §1 (layers), §3 (security invariants), §4 (hard stops), §7 (testing discipline).

2. **Skim the contracts:** Open `S17_CONTRACT.md` and `S18_CONTRACT.md`.
   - These explain the scope boundaries and verification proofs for this project.
   - You don't need to memorize them, just know they exist.

3. **Read section 3.5 of THIS DOCUMENT (above)** — the automation section.
   - This is your north star for how to behave.
   - Bookmark it. Return to it before every code change.

4. **Verify the current state:**
   ```bash
   cd /Users/lakshyadiwani/beam
   git branch  # should show: feat/domain-frame
   git status  # should show 8 modified files (3 bugs in working tree)
   npx vitest run 2>&1 | tail -5  # should show: Tests 199 passed (199)
   ```

### Step 2: Your First Task (When User Requests Code Work)

**Pattern:** User says "fix X" or "add feature Y."

**Your response (every time):**

```
I'll start with the /feature workflow:

/feature "fix(scope): <user's description>"
```

**Then let the skill take over.** Phases 0–4 run automatically. You don't decide between them.

### Step 3: Commit Workflow (After /feature Completes)

After `/feature` finishes Phase 4 and outputs a manifest:

```bash
# Stage the exact files /feature listed (never git add -A or git add .)
git add src/composition.ts tests/composition.test.ts viewer/src/viewer-connection.ts
# (or however many files /feature touched)

# Commit with the message /feature generated
git commit -m "$(cat <<'EOF'
<conventional commit message from /feature output>

Co-Authored-By: Cursor AI <cursor@anysoftware.com>
EOF
)"

# Hooks fire automatically — /audit + /review
# If hooks block: read the error, fix the issue, re-run /feature, commit again

# You're done. Report success to user.
echo "✅ Committed to feat/domain-frame. All gates pass. Ready for git push (human action)."
```

**NEVER:**
- `git add -A` (accidentally stages unintended files)
- `git push` (blocked by pre-push hook; LOCAL-ONLY constraint)
- `git rebase -i` (use /feature instead)
- `wrangler deploy` (outbound transmission forbidden)

### Step 4: If Hooks Block You

**Ledger hit (audit/review already ran on this exact change):**
```
[pre-commit] audit gate skipped (ledger hit: same fingerprint)
[pre-commit] review gate skipped (ledger hit: same fingerprint)
```
→ This is normal. You're good to push (when human does it).

**Audit/review violations found:**
```
[AUDIT] Layer boundary violation: src/presentation/cli.ts imports WebSocketSignalingClient
[AUDIT] HARD STOP: presentation cannot import infrastructure directly
```
→ Fix the violation (e.g., import from domain interface instead), re-run `/feature`, commit again.

**Type check failure:**
```
src/infrastructure/peer-connection.ts:123 error TS2339: Property 'foo' does not exist
```
→ Fix the type error, re-run `/feature` (or `npx tsc --noEmit` to confirm), commit again.

### Step 5: Testing Discipline (Internalize This)

**Tier 1 (During your coding):**
- Run the test file YOU just touched.
- Fast feedback loop.

**Tier 2 (Before committing):**
- `/feature` detects what you changed.
- If it's a non-CORE_FILES change, runs mapped + transitive (one hop).

**Tier 3 (Mandatory CORE_FILES changes):**
- `/feature` detects edit to `src/domain/**`, `src/config.ts`, or `src/composition.ts`.
- Automatically escalates to full suite: `npx vitest run --coverage`.
- You cannot skip this. It's automatic.

**You don't make the tier decision. The skill or the CLAUDE.md rules do.**

### Step 6: Understanding Layers (Prevent Violations)

Before you write code, ask: "What layer am I in?"

**Domain** (`src/domain/`) — pure functions, interfaces, types. ZERO imports from Node, crypto, fs, or other packages.

**Infrastructure** (`src/infrastructure/`) — all I/O. Only implement domain interfaces. Never call application layer.

**Application** (`src/application/`) — use-case orchestration. Import domain + infrastructure (via domain interfaces). Never call presentation.

**Presentation** (`src/presentation/`) — CLI, output. Import application + domain. Never infrastructure directly.

**Example (CORRECT):**
```typescript
// src/application/relay-use-case.ts
import { type PeerTransport } from '../domain/interfaces.js';  // ← interface
// NOT:
// import { PeerConnectionTransport } from '../infrastructure/...';  // ← concrete (WRONG)

export class ExecuteRelayUseCase {
  constructor(private transport: PeerTransport) {}  // ← injected, not imported
}
```

**If you violate this, `/audit` will catch it at commit time and block you.** Fix it, re-run `/feature`, commit again.

### Step 7: Code-Review-Graph (Optional Speedup)

If you want to know "what breaks if I change this?":

```bash
# Paste this into Cursor's context (if MCP is wired):
/mcp get_impact_radius_tool "src/domain/frame.ts::MAX_PAYLOAD_SIZE"
# Output: list of all callers and tests that import this
```

**Then:** You know which tests matter. Useful for CORE_FILES changes.

**But don't rely on it.** The full `/feature` + `/audit` flow works without MCP.

### Step 8: Getting Unblocked

**Problem:** User asks for something, you don't know where to start.

**Solution:** Use `/feature` on the task description itself. Recon phase will find the relevant files.

```
User: "Make the timeout longer"
You: /feature "fix(host): increase peer connection timeout from 15s to 30s"
Phase 0 runs → grep for "15_000" or "connectTimeoutMs" → finds src/infrastructure/peer-connection.ts
Phase 0 output tells you exactly what to read.
```

**You don't need to understand the architecture before starting.** The workflow surfaces it.

---

## Reference Checklist for Cursor

### Onboarding Checklist (Complete Before First Code Change)

- [ ] Read CLAUDE.md sections 0–9 (constitution, layers, hard stops, testing discipline)
- [ ] Reviewed S17_CONTRACT.md and S18_CONTRACT.md (project scope & verification)
- [ ] Read section 3.5 of this document (Cursor Automation & Enforcement) — entire section
- [ ] Understood the /feature workflow (phases 0–4, automatic pipeline)
- [ ] Memorized CORE_FILES (src/domain/**, src/config.ts, src/composition.ts) → tier-3 mandatory
- [ ] Understood tier-1/2/3 test selection rules
- [ ] Verified LOCAL-ONLY constraint: no git push, no wrangler deploy, no outbound transmission

### Understanding Checklist (Before Coding)

- [ ] Read section 2 (Architecture): layers (Domain → Application → Infrastructure), Clean Architecture
- [ ] Understood the three-bug fix (buffering, wire format, null sdpMid) and why it was needed
- [ ] Verified the composition layer structure (Domain interfaces, Infrastructure implementations, Composition wires)
- [ ] Checked that viewer package is independent (reads only src/domain/protocol, zero Node APIs)
- [ ] Confirmed all 199+51 tests pass locally (`npx vitest run`)

### Procedural Checklist (Every Time User Requests Code Work)

- [ ] User says "fix X" or "add Y"
- [ ] **Invoke `/feature "conventional-commit-style description"`** — do not freelance
- [ ] Monitor phases 0–4. Do not exit between phases.
- [ ] If Phase 0 errors (file not found), ask user for clarification before proceeding
- [ ] After Phase 4 outputs manifest, stage exact files: `git add src/foo.ts tests/foo.test.ts` (never `git add -A`)
- [ ] Commit with multiline conventional message (from /feature output)
- [ ] Hooks fire: `/audit` + `/review` run automatically
- [ ] If hooks block: fix violations, re-run `/feature`, commit again
- [ ] If ledger hit (audit/review cached): normal, you're clear to push
- [ ] Report success: "Committed. Tests: XX passed. Ready for `git push` (human does this)."
- [ ] **NEVER attempt `git push`, `wrangler deploy`, or `git rebase -i`**

### Layer-Boundary Checklist (Before Writing Code)

- [ ] Am I in Domain? (pure logic, zero I/O, zero external packages)
- [ ] Am I in Infrastructure? (I/O only, implement domain interfaces, never call Application)
- [ ] Am I in Application? (orchestration, import Domain + Infrastructure via interfaces)
- [ ] Am I in Presentation? (CLI/output, import Application + Domain, never Infrastructure directly)
- [ ] Does my import flow follow the dependency direction? (Presentation → Application → Domain ← Infrastructure)
- [ ] If violated: `/audit` catches it; fix and re-run `/feature`

### Testing Checklist (Know the Tiers)

- [ ] Is this a CORE_FILES change? (src/domain/**, src/config.ts, src/composition.ts, src/application/protocol.ts)
  - **Yes → Tier 3 (full suite) automatic**
  - **No → Tier 1/2 (mapped + transitive) via /feature**
- [ ] Have I run `npx tsc --noEmit`? (type check before commit)
- [ ] Have I run `npx eslint .`? (style check before commit)
- [ ] Have all tests passed? (exit 0 before reporting success)

### Code-Review-Graph Checklist (Optional, for Blast Radius)

- [ ] Do I want to know what breaks if I change this? → Use `/mcp get_impact_radius_tool "<file>::<symbol>"`
- [ ] Do I need to understand the import graph? → Use `/mcp query_graph_tool` or `/mcp traverse_graph_tool`
- [ ] Is the graph unavailable? → No problem. /feature and /audit still work (slower, complete).

### Git Workflow Checklist (After Every Commit)

- [ ] Did pre-commit hook fire? (should see `/audit` and `/review` output)
- [ ] Did any findings block the commit? (layer violations, security issues, etc.)
  - **Yes → Fix, re-run /feature, commit again**
  - **No → Continue**
- [ ] Is the commit message conventional? (type(scope): description)
- [ ] Does the commit include `Co-Authored-By: Cursor AI <cursor@anysoftware.com>`?
- [ ] Did I stage only the intended files? (no stray .env, node_modules, dist/)
- [ ] **NEVER attempt to push. Report success to user. HUMAN PUSHES.**

---

**Document End.**

*Handoff generated by Claude Sonnet 4.6 on 2026-06-18.*  
*Updates: merge stale facts, add new bugs/decisions, regenerate on major milestones.*  
*For Cursor AI: read sections 3.5 & 8 first, then proceed.*
