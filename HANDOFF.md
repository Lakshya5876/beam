# Beam — Agent Handoff Document

**Last updated:** 2026-06-20  
**Branch:** `feat/domain-frame`  
**HEAD:** `e900069`  
**Suite:** 206/206 passing · 87.47% line coverage  
**Status:** Feature-complete for v1 local testing. Needs live deployment on personal laptop for S18 proofs.

---

## 1. What Beam Is

Beam is a **WebRTC-based localhost tunneling CLI** for developers. A developer running a local dev server (`localhost:3000`) runs `bm` in their terminal, gets a shareable viewer URL plus a 6-digit session code, shares both out-of-band with a collaborator, and the collaborator opens the URL, enters the code, and gets a proxied live view of the localhost server — **no traffic ever touches Cloudflare** (only SDP/ICE signaling goes through it).

**Stack:** TypeScript (strict), Node ≥ 22, Vitest, ESLint (flat config), Cloudflare Worker + Durable Object (signaling), Cloudflare Pages (viewer).  
**Key native dep:** `node-datachannel` v0.32.1 — native addon for WebRTC on Node.js.

---

## 2. Repository Layout

```
beam/
├── src/                      Host CLI — Clean Architecture
│   ├── domain/               Pure business logic, zero deps (CORE_FILES)
│   │   ├── frame.ts          Wire protocol: 9-byte header, 9 frame types
│   │   ├── session.ts        Session entity: lifecycle state machine
│   │   └── interfaces.ts     Seam interfaces: SignalingClient, PeerTransport, etc (CORE_FILES)
│   ├── application/
│   │   ├── protocol.ts       Stream multiplexer — CORE_FILES
│   │   ├── relay-use-case.ts HTTP request relay orchestration
│   │   ├── session-use-case.ts Session lifecycle
│   │   ├── diagnostics-use-case.ts Request log queries
│   │   └── path-authorization.ts --allowed-paths enforcement (pure, no I/O)
│   ├── infrastructure/
│   │   ├── peer-connection.ts  node-datachannel WebRTC adapter
│   │   ├── signaling-client.ts WebSocket signaling + PIN hash registration
│   │   ├── replay-client.ts    HTTP replay to localhost (127.0.0.1 only)
│   │   └── request-log-store.ts In-memory ring buffer for diagnostics
│   ├── presentation/
│   │   ├── cli.ts            Entry point: interactive URL prompt, PIN generation, session start
│   │   └── diagnostics-view.ts Request log rendering
│   ├── composition.ts        DI root — ONLY place infrastructure binds to domain (CORE_FILES)
│   └── config.ts             ONLY env access point (CORE_FILES)
│
├── viewer/                   Browser-side — Vite build → Cloudflare Pages
│   ├── src/
│   │   ├── bootstrap.ts      Orchestrator: feature-detect → SW register → PIN gate → WebRTC
│   │   ├── sw.ts             Service Worker: intercepts fetch(), encodes Beam frames
│   │   ├── sw-bridge.ts      PostMessage types between SW and bootstrap
│   │   ├── sw-fetch-gate.ts  Queues fetches before mux-ready; timeout → 504
│   │   ├── viewer-connection.ts ViewerConnection: WebRTC + signaling state machine
│   │   ├── browser-peer.ts   RTCPeerConnection adapter
│   │   ├── browser-signaling.ts WebSocket adapter (no setImmediate)
│   │   ├── browser-datachannel.ts RTCDataChannel adapter (static import — not dynamic)
│   │   ├── pages.ts          Pure HTML generators: PIN entry, PIN failed, PIN locked, etc.
│   │   ├── request-serializer.ts  Encodes fetch Request → Beam frames
│   │   ├── response-assembler.ts  Decodes Beam frames → ReadableStream Response
│   │   ├── protocol-bridge.ts Re-exports shared protocol types for browser use
│   │   ├── viewer-url.ts     URL construction: buildViewerSignalingUrl()
│   │   ├── signaling-messages.ts  Unified ICE/SDP JSON serialization
│   │   └── main.ts           Entry: feature detection + bootstrap
│   ├── test/                 Vitest tests for viewer package
│   └── dist/                 Built output (gitignored) — ready for Cloudflare Pages deploy
│
├── signaling/                Cloudflare Worker + Durable Object
│   ├── src/
│   │   ├── worker.ts         Worker entry: routes WebSocket upgrades to DO
│   │   ├── session-do.ts     Durable Object: minting, pairing, PIN verify, ICE relay
│   │   ├── pin-store.ts      hashPin() + storage key constants + PIN_MAX_ATTEMPTS=3
│   │   ├── pairing.ts        Pure role assignment: host/viewer, two-peer cap
│   │   ├── session-code.ts   CSPRNG 26-char codes, ~134-bit entropy, never-reuse guard
│   │   ├── rate-limit.ts     Per-IP fixed-window: 30 mints/60s
│   │   ├── message-size.ts   64 KiB signaling message cap
│   │   └── used-token-store.ts  DO storage-backed code uniqueness guard
│   ├── test/                 Vitest tests for signaling package
│   └── wrangler.jsonc        Deploy config (note: .jsonc, NOT .toml)
│
├── tests/                    Host unit tests (mirrors src/)
├── docs/                     Planning artifacts: PRD, TRD, BACKEND_SCHEMA, USER_FLOW, THREAT_MODEL, DISCOVERY
├── DEPLOY.md                 Deploy instructions (personal laptop only — never on work laptop)
├── LIMITATIONS.md            Known limitations: no TURN, SPA-only, no WebSocket proxy, etc.
├── CLAUDE.md                 Engineering constitution — READ THIS FIRST, governs everything
└── S18_CONTRACT.md           Live E2E proof spec (7 proofs to run after deploy)
```

---

## 3. Dependency Direction (inviolable)

```
Presentation → Application → Domain ← Infrastructure
                                 ↑
                          composition.ts (only place they meet)
```

Never import Infrastructure from Application. Never import Application from Domain. Never import anything from Presentation except in composition.ts. Violations are defects caught by ESLint at commit time.

---

## 4. CORE_FILES (mandatory tier-3 test trigger)

Any change to these requires a full suite run (`npx vitest run --coverage`), not just the mapped test:

```
src/config.ts
src/domain/**
src/composition.ts
tests/fixtures/**
src/application/protocol.ts
```

---

## 5. The Wire Protocol

All data over the RTCDataChannel is binary, one message = one frame:

```
[type:1 byte][streamId:4 bytes big-endian][payloadLength:4 bytes big-endian][payload...]
HEADER_SIZE = 9 bytes
MAX_PAYLOAD_SIZE = 16375 bytes  ← already reduced from 256 KiB to RTCDataChannel SCTP ceiling
MAX_FRAME_SIZE = 16384 bytes
```

Frame types: `REQUEST_HEAD=1, REQUEST_BODY_CHUNK=2, REQUEST_END=3, RESPONSE_HEAD=4, RESPONSE_BODY_CHUNK=5, RESPONSE_END=6, ERROR=7, PING=8, PONG=9`

Stream lifecycle: `REQUEST_HEAD` → `REQUEST_BODY_CHUNK*` → `REQUEST_END` (viewer→host), then `RESPONSE_HEAD` → `RESPONSE_BODY_CHUNK*` → `RESPONSE_END` (host→viewer). Both sides share one `StreamId` (uint32).

`decodeFrame()` is **total** — every input returns either a `Frame` or a typed `FrameDecodeError`, never throws.

---

## 6. Zero-Trust User Flow (Option B — implemented)

```
$ bm
  Enter local URL (e.g. http://localhost:3000): http://localhost:3000

  WARNING: Beam is about to expose your local server.
     Target: http://localhost:3000
     Every route on http://localhost:3000 is reachable by anyone with the link.
     Anyone holding the session link + code can send requests for the life of the session.
     Press Ctrl-C to stop.

  Viewer URL:   https://beam-viewer.pages.dev/?signaling=wss://.../<26-char-session-id>
  Session code: 847 291

  Share both with your viewer. Press Ctrl-C to end the session.
```

**Option B design:** URL carries the opaque 26-char CSPRNG session ID (for DO routing). The 6-digit code is a separate gate — not in the URL, not transmitted over the network in plaintext, only shown in the host terminal.

**PIN validation sequence:**
1. Host CLI: generates `randomInt(100000, 999999)` → prints as `XXX XXX`
2. After minting session code, host sends `{"type":"pin-register","hash":"<sha256>"}` over its signaling WebSocket
3. DO stores hash at `"pin-hash"` key in DO storage (survives hibernation)
4. Viewer opens URL → sees PIN entry form → submits `{"type":"pin","value":"847291"}`
5. DO computes `SHA-256("847291" + ":" + sessionCode)` — same salt the host used
6. Match → `{"type":"pin-ok"}` → pending SDP/ICE flushed → WebRTC starts
7. Mismatch → `{"type":"pin-failed","attemptsLeft":N}` — form re-renders
8. 3 failures → `ws.close(1008, "pin-locked")` — session permanently dead

**Important:** `viewerPinVerified` is in-memory in the DO. If the DO hibernates between pin-ok and ICE, the flag resets to `false`. In practice this doesn't happen (ICE completes within seconds of pin-ok), but it's a documented edge case.

---

## 7. Signaling Message Wire Format

All signaling messages are JSON strings. The DO distinguishes **control messages** (have `"type"` field, no `"kind"` field) from **SDP/ICE relay messages** (have `"kind"` field):

| Message | Direction | Consumed by |
|---|---|---|
| `{"type":"pin-register","hash":"<64-char-hex>"}` | host → DO | DO only — never forwarded |
| `{"type":"pin","value":"<6digits>"}` | viewer → DO | DO only — never forwarded |
| `{"type":"pin-ok"}` | DO → viewer | Viewer bootstrap |
| `{"type":"pin-failed","attemptsLeft":N}` | DO → viewer | Viewer bootstrap |
| `{"type":"pin-locked"}` | DO → viewer | Viewer bootstrap |
| `{"kind":"offer","sdp":"..."}` | host → viewer | Relayed opaquely |
| `{"kind":"answer","sdp":"..."}` | viewer → host | Relayed opaquely |
| `{"kind":"ice-candidate","candidate":"...","mid":"..."}` | bidirectional | Relayed opaquely |

**Key quirk:** ICE candidates are JSON strings on the wire (`JSON.stringify` on both sides, `JSON.parse` on both sides). This was a bug that caused a silent handshake failure and was fixed in `509bfdc`. Do not revert.

---

## 8. Key Bug History (don't re-introduce)

All fixed and committed in `509bfdc`:

| Bug | Root cause | Fix location |
|---|---|---|
| DO dropped early host messages | `webSocketMessage` found no viewer target and silently discarded offer + ICE | `session-do.ts`: `pendingForViewer` buffer, flushed on PIN-ok (not on viewer connect) |
| ICE wire format mismatch | Host sent JSON string; viewer expected object. Viewer sent object; host expected string | `signaling-messages.ts`: JSON.stringify on send, JSON.parse on receive, both sides |
| Null `sdpMid` from Chrome | First m-line has no `sdpMid` in Chrome → `null` → `addIceCandidate` throws | `composition.ts`: default to `'0'` when `mid` is not a string |
| `setImmediate` in browser | `BrowserWebSocketAdapter.send()` called `setImmediate()` — Node-only, throws in SW | `browser-signaling.ts`: removed, direct `ws.send()` |
| Dynamic import deadlock | `viewer-connection.ts` dynamically imported `BrowserDataChannelAdapter` — SW couldn't create mux | `viewer-connection.ts`: changed to static import |
| `url` vs `path` field mismatch | Serializer emitted `url`, host decoder expected `path` | `request-serializer.ts`: renamed `url → path` throughout |
| SW sent raw bytes not Beam frames | SW posted raw body bytes; bootstrap expected encoded Beam frames | `sw.ts`: `encodeRequest()` → `encodeFrame()` → one `relay-request` per frame |
| Duplicate `onInbound` listeners | Every relay-request message registered a new listener | `bootstrap.ts`: `listeningStreams` Set guards first-registration-only |
| `mux.onFrame` doesn't exist | Wrong method name | `bootstrap.ts`: `mux.onFrame` → `mux.onInbound` |

---

## 9. Known Limitations (documented, accepted for v1)

- **No TURN relay** — ~10–15% of networks (symmetric NAT) will fail ICE. Host + viewer must be on networks where STUN reflexive candidates work. Documented in `LIMITATIONS.md`.
- **SPA-only** — top-level navigation unloads the viewer page and destroys the RTCPeerConnection. Multi-page SSR apps are not supported in v1.
- **No WebSocket proxy** — SW does not intercept `Upgrade: websocket`. Apps using WebSockets to localhost won't work.
- **Request bodies buffered in memory** — SW reads full body before sending first frame. Large uploads hold full body in tab memory.
- **Desktop Chrome only (tested)** — Safari/Firefox not tested; mobile not optimized.
- **`viewerPinVerified` resets on DO hibernation** — edge case only, noted above.
- **Rate limiter resets on DO hibernation** — best-effort only; Cloudflare WAF should be configured for production.
- **`MAX_PAYLOAD_SIZE = 16375`** — already reduced from 256 KiB to the RTCDataChannel SCTP ceiling. S18 Proof 0 confirms this at the wire level.

---

## 10. Local Development

```bash
# Full host suite
npx vitest run

# With coverage
npx vitest run --coverage    # lines must be ≥ 80%

# Viewer suite
cd viewer && npx vitest run

# Type check
npx tsc --noEmit
cd viewer && npx tsc --noEmit
cd signaling && npx tsc --noEmit

# Lint (all three packages)
npx eslint .

# Local E2E (no deployed stack needed)
# 1. Start signaling locally:
cd signaling && npx wrangler dev
# 2. Start dummy server:
node -e "require('http').createServer((_,r)=>{r.end('hello')}).listen(3000)"
# 3. Run host CLI against local wrangler:
npx tsx src/presentation/cli.ts --signaling ws://localhost:8787
# 4. Build + serve viewer locally:
cd viewer && npm run build && npx wrangler pages dev dist
```

---

## 11. Commit Gates (enforced by `.githooks/gate.sh` on every `git commit`)

1. Secrets scan on staged diff
2. Layer-boundary + config-module injection checks
3. `npx eslint .` — zero errors
4. `npx tsc --noEmit` — zero errors
5. Cyclomatic complexity ≤ 10 on changed `src/` files
6. `npx vitest run --coverage` — all tests pass, lines ≥ 80%

First attempt may fail in sandbox with `EPERM: rename gate_state.json.tmp`. Run with `required_permissions: ["all"]` outside sandbox.

**`git push` is NEVER run by the agent.** LOCAL-ONLY constraint: `CLAUDE.md §3`. No remote is configured. The human pushes from a plain shell after adding a remote.

---

## 12. What's Done vs. What's Next

### Done (all committed, all gated)

| Commit | What |
|---|---|
| `e900069` | DEPLOY.md fixes: wrangler.jsonc ref, build output, S18 pre-flight |
| `f99f11a` | M3: full PIN pairing — DO register/verify/lockout, viewer PIN gate, host hash send |
| `4f4359f` | CLI rewrite: `bm` UX, interactive URL prompt, CSPRNG 6-digit PIN |
| `ca77b2d` | `MAX_PAYLOAD_SIZE` → 16 375 bytes (RTCDataChannel SCTP ceiling) |
| `3491360` | docs/: PRD, TRD, BACKEND_SCHEMA, USER_FLOW, THREAT_MODEL, DISCOVERY |
| `509bfdc` | 9 WebRTC bugs fixed, local E2E smoke test green |

### Next (in order)

**Step 1 — Human deploys on personal laptop** (no agent needed):
```bash
# Personal laptop only — unzip from Google Drive
wrangler deploy --config signaling/wrangler.jsonc
wrangler pages deploy viewer/dist/ --project-name beam-viewer --branch main
curl -sI https://beam-viewer.pages.dev/__beam/sw.js | grep Service-Worker-Allowed
```

**Step 2 — S18 live proofs** (human runs, agent may help diagnose):
Open `S18_CONTRACT.md` and run Proofs 0–6 in order. Proof 0 (DataChannel ceiling) is the gate for everything else.

**Step 3 — npm packaging** (agent task, ~4–6h):
- Rename package: `@beamtunnel/cli` (bare `beam` is taken on npm by an unrelated package; Apache Beam causes brand confusion)
- Binary name: `bm` (not `beam` — confirmed clean via PATH scan and npm search)
- Add `"bin": { "bm": "dist/cli.js" }` to `package.json`
- Add `tsc` → `dist/` build pipeline
- Add `.npmignore`
- Verify `npx @beamtunnel/cli` works globally

**Step 4 — TURN relay** (optional, post-v1):
Integrate Cloudflare Calls or Metered.ca for symmetric NAT failover. Gate on whether S18 Proof 1 shows unacceptable failure rate.

---

## 13. Untracked Files (intentional — do not commit)

```
S17_CONTRACT.md        — planning contract, superseded
S18_CONTRACT.md        — live proof spec, human runs this
e2e-smoke.mjs          — Puppeteer smoke test harness (local E2E)
e2e-stress.mjs         — stress test harness
e2e-stress-concurrent.mjs — concurrent streams test
handoff_cursor.md      — older handoff document, superseded by this file
```

---

## 14. Constitution Rules the Agent Must Follow

Read `CLAUDE.md` in full before touching anything. Key rules:

- **No `git push`** — ever. `git remote` shows no remotes; it's enforced structurally.
- **No `wrangler deploy`** — ever. Outbound transmission of code is human-only.
- **Hard stops** (await human before proceeding): new runtime deps/lockfile changes, auth/authz changes, new env vars, CI changes, `.gitignore` changes, editing `CORE_FILES` list.
- **CORE_FILES change → tier-3 mandatory** — full suite + coverage, not just the mapped test.
- **Never modify a test to make it pass** — fix the code under test.
- **Never silence with try/catch** — fix the error.
- **Three-strike rule** — max 3 fix attempts for any failing test; on third failure, stop and report.
- **Layer order for implementation**: Domain → Infrastructure → Application → Presentation → Tests.
- **Stubs-first for 3+ files**: write all stubs, compile-check all at once, then add logic.
