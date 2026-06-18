# Beam — Backend Schema: Host CLI to Viewer Browser

**Version:** 1.0 (MVP + PIN pairing)  
**Date:** 2026-06-19  
**Canonical source:** `signaling/src/session-do.ts`, `src/domain/session.ts`

---

## Overview

The entire backend state for one Beam session lives in **one Durable Object instance**, identified by its session code. There is no database, no external KV, no persistence beyond the DO's own storage. When the session ends, the DO instance is eventually evicted by Cloudflare.

```
npm publish / host CLI
       │
       ▼
  POST /new  ──────────────────────► Registry DO instance
  (mint code)                              │
                                    generates code, stores in
                                    UsedTokenStore (DO storage)
                                           │
                                           ▼
            Session DO instance (keyed by code)
            ┌────────────────────────────────────┐
            │  hostSocket   : WebSocket | null    │
            │  viewerSocket : WebSocket | null    │
            │  pinHash      : string | null       │
            │  pinAttempts  : number              │
            │  state        : SessionState        │
            │  pendingForViewer: Message[]        │
            │  createdAtMs  : number              │
            │  ttlMs        : number              │
            └────────────────────────────────────┘
```

---

## 1. Cloudflare Durable Object State

### 1.1 In-memory state (lost on hibernation — acceptable)

These fields are held in the DO instance class. Because Cloudflare's Hibernation API discards in-memory state between WebSocket events, each handler reconstructs them from socket tags (which survive hibernation).

```typescript
class SessionDurableObject {

  // Per-IP rate limiter for /new (mint) endpoint.
  // In-memory: resets on hibernation — documented limitation (blunts spam only).
  private mintLimiter: RateLimiter  // { maxPerWindow: 30, windowMs: 60_000 }

  // Buffer for host messages (offer + ICE candidates) that arrive before the
  // viewer WebSocket connects.  Flushed to viewer on connection.
  // In-memory: acceptable because host + viewer connect within one ICE window.
  private pendingForViewer: Array<string | ArrayBuffer>

}
```

### 1.2 Persisted state (survives hibernation)

These are written to Durable Object storage:

```typescript
// Key pattern: "used:<code>"  — value: true
// Purpose: guarantee codes are never reused across evictions
used:<session-code>: boolean

// Key pattern: "pin:<code>"  — value: SHA-256 hex digest of (pin + code)
// Purpose: PIN validation after DO hibernates
pin:<session-code>: string  // 64-char hex

// Key pattern: "pinattempts:<code>"  — value: number (0–3)
// Purpose: enforce 3-strike lockout across hibernation cycles
pinattempts:<session-code>: number
```

### 1.3 WebSocket socket tags (survive hibernation)

Socket tags are the only per-connection state that Cloudflare's Hibernation API preserves. Beam uses them to reconstruct peer roles after wake-up:

```typescript
// Assigned at acceptWebSocket(server, [role]):
socket tag: 'host'    // the host's WebSocket
socket tag: 'viewer'  // the viewer's WebSocket (after PIN validation)
socket tag: 'viewer_pending'  // viewer connected but PIN not yet validated
```

---

## 2. Session Lifecycle State Machine

```
                     POST /new
                         │
                         ▼
                    ┌─────────┐
                    │  MINTED │  code stored in UsedTokenStore
                    └────┬────┘
                         │  host WebSocket connects
                         ▼
                    ┌─────────┐
                    │   HOST  │  host socket accepted, tag='host'
                    │ WAITING │  offer + ICE buffered in pendingForViewer
                    └────┬────┘
                         │  viewer WebSocket connects
                         ▼
                  ┌─────────────┐
                  │   VIEWER    │  viewer socket accepted, tag='viewer_pending'
                  │   PENDING   │  PIN hash stored; pendingForViewer NOT flushed yet
                  │  (needs PIN)│
                  └──────┬──────┘
                 wrong PIN │         correct PIN
            (3 strikes) │             │
                         ▼             ▼
                  ┌──────────┐  ┌────────────┐
                  │  LOCKED  │  │  PAIRED    │  tag upgraded to 'viewer'
                  │ ws.close │  │            │  pendingForViewer flushed
                  │ (1008)   │  │ ICE begins │
                  └──────────┘  └─────┬──────┘
                                      │  RTCDataChannel open
                                      ▼
                               ┌────────────┐
                               │  RELAYING  │  HTTP frames flowing P2P
                               └─────┬──────┘
                    Ctrl-C / TTL /    │    viewer disconnect
                    host disconnect   │
                                      ▼
                               ┌────────────┐
                               │   CLOSED   │  both sockets closed
                               └────────────┘  pin:<code> deleted from storage
```

---

## 3. Full Durable Object Message Schema

### 3.1 Host → Signaling (WebSocket messages)

All messages are JSON strings (opaque relay — DO forwards without parsing, except for session management):

```typescript
// WebRTC offer (forwarded to viewer once paired)
{
  type: 'offer',
  sdp: string  // SDP blob
}

// ICE candidate (forwarded to viewer; buffered if viewer not yet connected)
{
  type: 'ice',
  candidate: string,
  mid: string   // sdpMid, defaults to '0' for first m-line
}

// Session close (host Ctrl-C or TTL)
// Note: this is derived from WebSocket close event, not a message
// ws.close(1000, 'host-closed') → DO purges session
```

### 3.2 Viewer → Signaling (WebSocket messages)

```typescript
// PIN submission (consumed by DO; never forwarded to host)
{
  type: 'pin',
  value: string  // 6-digit string, e.g. "482091"
}

// WebRTC answer (forwarded to host; only sent after pin-ok)
{
  type: 'answer',
  sdp: string
}

// ICE candidate (forwarded to host)
{
  type: 'ice',
  candidate: string,
  mid: string
}
```

### 3.3 Signaling → Viewer (DO-originated messages)

```typescript
// Sent by DO after successful PIN validation (not forwarded to host)
{
  type: 'pin-ok'
}

// Sent by DO after 3 failed PIN attempts
// DO also calls ws.close(1008, 'pin-locked')
{
  type: 'pin-failed',
  reason: 'max-attempts'
}

// Sent by DO if PIN attempt fails but attempts remain
{
  type: 'pin-failed',
  reason: 'wrong-pin',
  attemptsLeft: number  // 2, 1
}
```

### 3.4 Signaling → Host (DO-originated messages)

```typescript
// Sent by DO when viewer successfully pairs (informational, optional)
{
  type: 'viewer-joined'
}

// Sent by DO when viewer disconnects
{
  type: 'viewer-left'
}
```

---

## 4. PIN Hashing Specification

```
Input:    pin_digits (6-char decimal string) + session_code (26-char [a-z0-9] string)
Concat:   input = pin_digits + ":" + session_code
Hash:     SHA-256(UTF-8(input)) → 32 bytes
Storage:  hex-encode → 64-char string stored at key "pin:<session_code>"
```

Using the session code as a salt prevents rainbow-table lookups across sessions.  
SHA-256 is sufficient here: the 6-digit PIN space is small (10^6), but the 3-strike lockout makes brute force impractical at the signaling layer before hash computation is relevant.

```typescript
// Pseudo-code for the DO
async function hashPin(pin: string, code: string): Promise<string> {
  const input = new TextEncoder().encode(`${pin}:${code}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

---

## 5. /new Mint Endpoint Schema

### Request

```
POST /new
Host: signal.<domain>.dev
Content-Type: (none required)
```

### Response (200 OK)

```json
{ "code": "abc123xyz789..." }
```

Code length: 26 characters, `[a-z0-9]`.

### Response (429 Too Many Requests)

```
rate limited
```

Rate limit: 30 mints per IP per 60 seconds (in-memory, resets on DO hibernation).

### Response (503 Service Unavailable)

```
mint exhausted
```

Occurs when all 8 CSPRNG sampling attempts collide with used codes (astronomically rare at 134-bit entropy; effectively unreachable in practice).

---

## 6. WebSocket Upgrade Endpoint Schema

### Request

```
GET /<session-code>
Host: signal.<domain>.dev
Upgrade: websocket
Connection: Upgrade
```

### Role assignment

| Existing roles in DO | Assigned role |
|---|---|
| None | `host` |
| `host` only | `viewer_pending` |
| `host` + `viewer` or `viewer_pending` | Rejected: `session-full` (WebSocket closes 1013) |

### Session-full rejection

```
HTTP 101 (WebSocket upgrade accepted)
ws.close(1013, 'session-full')
```

The WebSocket is briefly opened before closing to correctly handle the HTTP 101 / WebSocket close sequence.

---

## 7. TTL Enforcement

Session TTL is enforced on the host side (`src/domain/session.ts`):

```typescript
DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000  // 4 hours
```

When the TTL expires:
1. Host's `ExecuteSessionUseCase.isExpired()` returns true
2. Host calls `runtime.close('ttl-expired')`
3. Host WebSocket closes → DO receives `webSocketClose` event
4. DO closes viewer WebSocket with `ws.close(1001, 'host-closed')`
5. DO deletes `pin:<code>` from storage (cleanup)
6. Viewer receives `renderFailed('session expired')`

The TTL is enforced by the host process — it is not a DO alarm. This means a host that is killed (not gracefully stopped) relies on WebSocket close events for cleanup.

---

## 8. Data Retention Policy

| Data | Where stored | Retention |
|---|---|---|
| Session code | DO storage (`used:<code>`) | Permanent (never-reuse guard) |
| PIN hash | DO storage (`pin:<code>`) | Deleted on session close/TTL |
| PIN attempt counter | DO storage (`pinattempts:<code>`) | Deleted on session close |
| SDP/ICE blobs | In-memory (`pendingForViewer`) | Discarded after flush or DO eviction |
| HTTP request/response frames | Never stored — P2P only | N/A |
| IP addresses | DO in-memory mint limiter | Session (discarded on hibernation) |
| Request logs | Host terminal only (`src/infrastructure/request-log-store.ts`) | Process lifetime |

**No HTTP payloads are ever stored or logged on Cloudflare infrastructure.**
