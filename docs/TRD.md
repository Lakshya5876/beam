# Beam — Technical Requirements Document (TRD)

**Version:** 1.0 (MVP)  
**Date:** 2026-06-19  
**Status:** Planning  
**Source of truth:** `src/domain/frame.ts`, `src/application/protocol.ts`, `viewer/src/sw-fetch-gate.ts`

---

## 1. System Overview

Beam has three physical packages and one shared protocol:

```
┌──────────────────────────────────────────────────────────────────┐
│                      BEAM SYSTEM BOUNDARY                        │
│                                                                  │
│  ┌─────────────────┐   WebSocket (signaling only)               │
│  │  HOST (Node.js) │◄──────────────────────────►┌────────────┐  │
│  │  @beamtunnel/cli│                             │  SIGNALING │  │
│  │  node >= 22     │◄──────────────────────────►│  Cloudflare│  │
│  └────────┬────────┘   WebSocket (signaling only)│  Worker +  │  │
│           │                                      │  Durable   │  │
│           │ RTCDataChannel                       │  Object    │  │
│           │ (direct P2P — no Cloudflare)         └────────────┘  │
│           │                                             ▲        │
│  ┌────────▼────────┐   WebSocket (signaling only)       │        │
│  │ VIEWER (Browser)│◄────────────────────────────────────        │
│  │ Service Worker  │                                             │
│  │ Chrome desktop  │                                             │
│  └─────────────────┘                                             │
└──────────────────────────────────────────────────────────────────┘
```

**Traffic routing:** All application data (HTTP request/response frames) flows exclusively over the RTCDataChannel — directly peer-to-peer. The Cloudflare Worker only ever sees SDP blobs, ICE candidates, and PIN validation messages. It never touches HTTP payloads.

---

## 2. Beam Wire Protocol

### 2.1 Frame format

All data is sent as binary `ArrayBuffer` over the RTCDataChannel. Each message is exactly one frame:

```
Offset  Size  Field
  0       1   type        (uint8)
  1       4   streamId    (uint32, big-endian)
  5       4   payloadLength (uint32, big-endian)
  9      ..   payload     (payloadLength bytes)
```

**Total header:** 9 bytes (`HEADER_SIZE = 9`)

### 2.2 Frame types

| Value | Name | Direction | Meaning |
|---|---|---|---|
| 1 | `REQUEST_HEAD` | viewer → host | JSON-encoded `{ method, path, headers }` |
| 2 | `REQUEST_BODY_CHUNK` | viewer → host | Raw body bytes for current stream |
| 3 | `REQUEST_END` | viewer → host | Half-close: no more request body for this stream |
| 4 | `RESPONSE_HEAD` | host → viewer | JSON-encoded `{ status, headers }` |
| 5 | `RESPONSE_BODY_CHUNK` | host → viewer | Raw response body bytes for current stream |
| 6 | `RESPONSE_END` | host → viewer | Half-close: response complete for this stream |
| 7 | `ERROR` | bidirectional | Stream-level error; payload is UTF-8 error string |
| 8 | `PING` | bidirectional | Keepalive; no payload |
| 9 | `PONG` | bidirectional | Keepalive reply to PING |

### 2.3 Stream lifecycle

Each HTTP request/response cycle uses one `StreamId` (uint32, 1 to 2^32-1):

```
VIEWER                           HOST
  │                                │
  ├─REQUEST_HEAD(sid=N)──────────►│
  ├─REQUEST_BODY_CHUNK(sid=N)─┐  │   (zero or more chunks)
  ├─REQUEST_BODY_CHUNK(sid=N)─┘  │
  ├─REQUEST_END(sid=N)──────────►│
  │                               ├─► replay to localhost
  │                               │
  │◄────────────RESPONSE_HEAD(sid=N)─┤
  │◄───RESPONSE_BODY_CHUNK(sid=N)─┐  │
  │◄───RESPONSE_BODY_CHUNK(sid=N)─┘  │
  │◄────────────RESPONSE_END(sid=N)──┤
```

A stream is **open** from `REQUEST_HEAD` until `RESPONSE_END` (or `ERROR`). Both sides must tolerate out-of-order frames across concurrent streams.

### 2.4 Frame size constraints

| Constant | Value | Source |
|---|---|---|
| `HEADER_SIZE` | 9 bytes | `src/domain/frame.ts` |
| `MAX_PAYLOAD_SIZE` | 256 KiB (pre-S18) → 16 375 bytes (post-S18 if Proof 0 fails) | `src/domain/frame.ts:26` |
| `MAX_FRAME_SIZE` | `HEADER_SIZE + MAX_PAYLOAD_SIZE` | `src/domain/frame.ts:27` |

**S18 Proof 0 gate:** The Chromium / Firefox SCTP implementation has a de facto per-message interop ceiling of ~16 384 bytes. Frames larger than this ceiling may be silently dropped or cause a channel reset. If Proof 0 confirms this ceiling is hit, `MAX_PAYLOAD_SIZE` is reduced to `16 375` bytes (16 384 − 9 header bytes). This is a CORE_FILES change and triggers a mandatory Tier-3 test run.

**If the ceiling is NOT hit (Branch A):** `MAX_PAYLOAD_SIZE` stays at 256 KiB. Large bodies (e.g. a 1 MB API response) are split into multiple ≤ 256 KiB frames at the host's relay layer.

**If the ceiling IS hit (Branch B):** Large bodies require more, smaller frames. The mux already handles this transparently — the chunking granularity is just smaller.

### 2.5 Multiplexer limits

From `src/application/protocol.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `MAX_CONCURRENT_STREAMS` | 256 | Max live streams at the host mux simultaneously |
| `MAX_STREAM_BUFFER_BYTES` | 1 MiB | Per-stream receive buffer cap |
| `MAX_TOTAL_BUFFER_BYTES` | 16 MiB | Total buffer cap across all streams |
| `HIGH_WATER_MARK` | 1 MiB | Backpressure: stop sending when bufferedAmount > HWM |
| `LOW_WATER_MARK` | 256 KiB | Resume sending when bufferedAmount < LWM |

From `viewer/src/sw-fetch-gate.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `MAX_CONCURRENT_STREAMS` | 32 | Max concurrent in-flight fetches in the SW |
| `RELAY_TIMEOUT_MS` | 30 000 ms | SW waits 30 s for mux-ready before returning 504 |

---

## 3. WebRTC Architecture

### 3.1 ICE / STUN configuration

```
viewer/src/bootstrap.ts — RTCPeerConnection config:
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
```

ICE candidate types collected:
- `host` — direct LAN addresses (most common in same-network demo)
- `srflx` (server reflexive) — public IP discovered via STUN (most cross-network cases)
- `prflx` (peer reflexive) — discovered during connectivity checks

**Symmetric NAT (failure case):** Approximately 10–15% of networks block direct ICE even with STUN. In v1, these sessions fail with `renderFailed('peer connection failed')` and a documented limitation notice. A TURN relay is the v2 fix.

### 3.2 TURN failover strategy (v2 design)

When ICE fails (all candidate pairs fail, `connectionState = 'failed'`), Beam should retry with TURN credentials:

```
Attempt 1: STUN only (current v1 behavior)
  └─ Failed? → Attempt 2: STUN + TURN (relay)
       └─ Failed? → renderFailed('peer connection failed — check network firewall')
```

TURN provider options ranked by free-tier viability:
1. **Cloudflare Calls TURN** — ~$0.05/GB, zero per-seat fees, same vendor as signaling
2. **Metered.ca** — 50 GB/month free tier (sufficient for dev tool use)
3. **Self-hosted coturn** — $5/month VPS, unlimited; `--turn-server` CLI flag for self-hosted

TURN credentials must be short-lived HMAC-derived tokens (RFC 8489 §9.2), never static passwords embedded in client code.

### 3.3 Connection timeout

Host-side: `DEFAULT_CONNECT_TIMEOUT_MS = 60 000 ms` (60 seconds from `src/infrastructure/peer-connection.ts`).  
Rationale: ICE on complex NAT topologies requires time for all candidate pairs to be tested.

---

## 4. Signaling Protocol

### 4.1 Transport

WebSocket connections to the Cloudflare Worker URL:
- Host: `wss://signal.<domain>.dev/<session-code>` — first connection, gets `host` role
- Viewer: same URL — second connection, gets `viewer` role (pending PIN validation)

### 4.2 Message format

All signaling messages are UTF-8 JSON strings (after ICE wire-format unification). The Durable Object relays them opaquely with two exceptions:
1. `{"type":"pin","value":"<digits>"}` — consumed by the DO for PIN validation (never forwarded)
2. `{"type":"pin-ok"}` — emitted by the DO to the viewer on successful validation (not forwarded to host)

### 4.3 Session code properties

| Property | Value |
|---|---|
| Alphabet | `[a-z0-9]` (36 symbols) |
| Length | 26 characters minimum |
| Entropy | ≈ 134 bits (`26 × log₂(36)`) |
| Source | Web Crypto `getRandomValues` with rejection-sampling (no modulo bias) |
| Reuse | Prevented by DO's `UsedTokenStore` (backed by Durable Object storage) |
| Expiry | Tied to session TTL; code is permanently invalid after `RESPONSE_END` or host disconnect |

### 4.4 PIN pairing (Zero-Trust UX — M3)

A 6-digit numeric PIN is generated on the host side at session creation:

```
Generation:  crypto.getRandomValues() → 6 digits [000000–999999]
Hashing:     SHA-256(pin + session_code) → stored in DO
Transmission: host CLI prints to terminal only — never sent to signaling or viewer
Validation:  viewer submits pin via WebSocket; DO checks hash; max 3 attempts before close(1008)
Timing:      viewer WebSocket accepted immediately, but no ICE forwarding until pin-ok
```

Detailed schema in `BACKEND_SCHEMA.md`.

---

## 5. Service Worker Architecture

### 5.1 Scope and exclusions

The Service Worker is registered at scope `/` (`Service-Worker-Allowed: /` header required).

**Intercepted:** all `fetch()` requests from the viewer page with a same-origin URL, except:
- `/__beam/*` — Beam's own assets (SW file, main bundle, index.html)

**Not intercepted:**
- Cross-origin requests (natural browser behavior)
- `Upgrade: websocket` requests (not a fetch interception target)
- Navigation requests (would destroy the peer connection — see LIMITATIONS.md)

### 5.2 Request encoding

When the SW intercepts a `fetch`:

1. Extracts `method`, `pathname + search` → `path`, and headers from `FetchEvent.request`
2. Reads the full request body into a `Uint8Array` (buffered — no streaming in v1)
3. Calls `encodeRequest(requestLike)` → produces an array of `Frame` objects (one per chunk)
4. For each frame: calls `encodeFrame(frame)` → `Uint8Array`, posts as `relay-request` to `bootstrap.ts`
5. Returns a `Promise<Response>` that resolves when `RESPONSE_END` or `ERROR` is received

### 5.3 FetchGate (SW ↔ bootstrap bridge)

The `FetchGate` in `sw-fetch-gate.ts` queues incoming fetch requests before the mux is ready and routes them once the DataChannel is open:

```
SW receives fetch → enqueue(streamId, 30s timeout, gate)
  └─ if gate.ready:
        gate.openStreams < 32 → resolve(ok)
        else → resolve(ok:false, 504 stream-cap-exceeded)
  └─ if !gate.ready:
        push to pending queue
        timeout after 30s → resolve(ok:false, 504 timeout)

bootstrap.ts posts 'mux-ready' → onMuxReady() → flush all pending items
bootstrap.ts posts 'relay-error' → onMuxGone() → drain pending, resolve all ok:false, 504
```

### 5.4 Response streaming

Responses stream to the page via `ReadableStream` (`ResponseAssembler`). Chunks arrive as `RESPONSE_BODY_CHUNK` frames and are enqueued without waiting for the full body. `RESPONSE_END` signals `ReadableStreamDefaultController.close()`.

---

## 6. Path Authorization

Implemented in `src/application/path-authorization.ts` (Application layer — pure, no I/O).

- Empty allow-list: every route is reachable (default, documented in consent banner)
- Non-empty allow-list: path must **equal** or be a **path-segment prefix** of an entry
  - `/api` allows `/api` and `/api/v2/users` but NOT `/apifoo`
  - 403 is returned **before** any localhost replay (no request leaves the host process)

---

## 7. Host Infrastructure (Node.js)

### 7.1 WebRTC (node-datachannel)

Host uses `node-datachannel` v0.32.1 (package.json). This is a native addon wrapping `libdatachannel`. The adapter in `src/infrastructure/peer-connection.ts` bridges `node-datachannel`'s callback API to the `PeerTransport` domain interface.

**Critical:** `node-datachannel` ships pre-built binaries for common Node/OS/arch combinations. If a target platform lacks a pre-built binary, `npm install` falls back to a native build (requires `cmake` + C++ toolchain). This is a packaging concern for the npm publish step.

### 7.2 Clean Architecture enforcement

| Layer | Directory | Rule |
|---|---|---|
| Domain | `src/domain/` | Zero external dependencies; pure TypeScript |
| Application | `src/application/` | Imports Domain only; no I/O |
| Infrastructure | `src/infrastructure/` | Implements Domain interfaces; all I/O |
| Presentation | `src/presentation/` | Parses CLI args, formats output; calls Application |
| Composition | `src/composition.ts` | The single file that wires everything together |

Layer violations are detected by ESLint rules enforced at commit time.

---

## 8. Build & Distribution

### 8.1 Host CLI (npm package)

```json
{
  "name": "@beamtunnel/cli",
  "bin": { "beam": "dist/cli.js" },
  "engines": { "node": ">=22.0.0" }
}
```

Build: `tsc --project tsconfig.build.json` → `dist/`  
Install: `npm install -g @beamtunnel/cli`  
Run: `beam 3000` or `npx @beamtunnel/cli 3000`

### 8.2 Viewer (Cloudflare Pages)

Build: `npm run build --prefix viewer` → `viewer/dist/`  
Deploy: `wrangler pages deploy viewer/dist/ --project-name beam-viewer` (human action per DEPLOY.md)  
Critical file: `viewer/dist/__beam/sw.js` must be served with `Service-Worker-Allowed: /`

### 8.3 Signaling (Cloudflare Worker)

Deploy: `wrangler deploy --config signaling/wrangler.toml` (human action per DEPLOY.md)  
No migration required — DO schema is append-only.

---

## 9. Non-Functional Requirements

| Requirement | Target | Current state |
|---|---|---|
| Type safety | `tsc --noEmit` exits 0 | ✓ |
| Test coverage | Lines ≥ 80% | ✓ 89.4% |
| Linting | `eslint .` exits 0 | ✓ |
| Cyclomatic complexity | ≤ 10 per function | ✓ |
| Connect time (STUN, same region) | < 5 s | ✓ (observed ~2–3 s locally) |
| Session tear-down latency | < 500 ms from Ctrl-C to `renderFailed` | Pending S18 Proof 6 |
| Memory ceiling (host) | Total mux buffer ≤ 16 MiB | ✓ enforced by `MAX_TOTAL_BUFFER_BYTES` |
| Memory ceiling (viewer) | Full request body in SW tab memory | Documented limitation; ≤ browser tab memory (~512 MB) |
