# Beam — User Flow Document (Zero-Trust)

**Version:** 1.0 (MVP + PIN pairing)  
**Date:** 2026-06-19

---

## Overview

Beam's user flow is divided into three actors:

- **Host:** the developer exposing their localhost (runs the CLI)
- **Viewer:** the remote collaborator (opens the viewer URL in Chrome)
- **Signaling DO:** Cloudflare Durable Object (validates PIN, relays SDP/ICE)

The zero-trust model means **the viewer URL alone grants nothing**. A second secret (the PIN) is required, and it is validated server-side before any WebRTC negotiation begins.

---

## Phase 1 — Host Setup

### Step 1: Install (first time only)

```bash
npm install -g @beamtunnel/cli
```

or for one-off use:

```bash
npx @beamtunnel/cli 3000
```

### Step 2: Start a local dev server

Host already has their app running:

```
Terminal 1: npm run dev        → listening on localhost:3000
Terminal 2: (reserved for Beam)
```

### Step 3: Run the Beam CLI

```bash
beam 3000
```

With optional flags:

```bash
beam 3000 --allowed-paths /demo,/api --ttl 3600
```

| Flag | Default | Description |
|---|---|---|
| `<port>` | (required) | Local port to expose |
| `--allowed-paths` | (none = all) | Comma-separated path prefixes to whitelist |
| `--ttl <seconds>` | 14400 (4 h) | Session expiry; configurable downward only |
| `--signaling <url>` | `wss://signal.beam.dev` | Override signaling server (for self-hosted) |
| `--viewer <url>` | `https://beam-viewer.pages.dev` | Override viewer URL (for self-hosted) |

### Step 4: Host sees consent banner

```
⚠  Beam is about to expose your local server.
   Port: localhost:3000
   Every route on port 3000 is reachable by anyone with the link.
   Anyone holding the session link AND the auth code can send requests
   for the life of the session (up to 60 minutes).
   Press Ctrl-C to stop.
```

If `--allowed-paths` is set:

```
   Only these paths are exposed: /demo, /api
```

**No input required — the CLI proceeds automatically after printing the banner.**

### Step 5: CLI mints session and prints credentials

```
Connecting to signaling server... ✓

┌─────────────────────────────────────────────────────────┐
│  BEAM SESSION ACTIVE                                    │
│                                                         │
│  Viewer URL:                                            │
│  https://beam-viewer.pages.dev/?s=wss://...&c=abc123    │
│                                                         │
│  Auth Code:  4 8 2  9 0 1                              │
│                                                         │
│  Share BOTH the URL and the Auth Code with your viewer. │
│  The Auth Code is ONE-TIME and expires with this session│
│                                                         │
│  Session expires in: 60 minutes                        │
│  Press Ctrl-C to stop immediately.                     │
└─────────────────────────────────────────────────────────┘
```

The Auth Code is:
- 6 digits, generated via `crypto.getRandomValues()`
- **Printed only in the terminal — never sent over the network in plaintext**
- Valid for one session only; destroyed when the session ends

### Step 6: Host shares credentials out-of-band

Host sends **both** the URL and the Auth Code to the viewer via a trusted channel (Slack DM, voice call, email, iMessage). These are two separate pieces of information. Someone who intercepts only the URL cannot connect.

---

## Phase 2 — Viewer Connection

### Step 7: Viewer opens the URL

Viewer opens the URL in Chrome desktop. The Beam viewer page loads from Cloudflare Pages.

**Viewer page initial state (before connection):**

```
┌──────────────────────────────────────────────────────┐
│  🔒 Beam — Secure Localhost Tunnel                   │
│                                                      │
│  You are connecting to a developer's local server.   │
│  This is not a public website. Only proceed if       │
│  you trust the person who sent you this link.        │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  Enter Auth Code                             │   │
│  │  ┌──────────────────────────────────────┐   │   │
│  │  │   _ _ _  _ _ _                       │   │   │
│  │  └──────────────────────────────────────┘   │   │
│  │              [ Connect ]                     │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ⚠ This tunnel grants access to private localhost    │
│     services. Do not enter the code if you did not   │
│     receive it directly from a developer you trust.  │
└──────────────────────────────────────────────────────┘
```

The page does NOT attempt any WebSocket or WebRTC connection yet.

### Step 8: Viewer enters the Auth Code

Viewer types the 6-digit code (received from host out-of-band) and clicks Connect (or presses Enter).

**What happens (viewer browser → signaling DO):**

1. Viewer page connects its WebSocket to the signaling server
2. DO assigns role `viewer_pending` (socket tag: `'viewer_pending'`)
3. Viewer sends: `{"type":"pin","value":"482901"}`
4. DO computes `SHA-256("482901:<session-code>")` and compares to stored hash
5. If match: DO upgrades socket tag to `'viewer'`, sends `{"type":"pin-ok"}` to viewer, flushes `pendingForViewer` (the host's buffered offer + ICE candidates)
6. Viewer page transitions to "Connecting..." state

**What the DO does NOT do on PIN submission:**
- Does not forward the PIN to the host
- Does not forward the PIN to any log or storage

### Step 9: WebRTC ICE negotiation begins

Only after PIN validation succeeds:

```
Viewer receives offer (from pendingForViewer flush)
    ↓
Viewer sets remote description
    ↓
Viewer sends answer → DO relays to host
    ↓
Host sets remote description
    ↓
Both sides exchange ICE candidates (bidirectional, via DO relay)
    ↓
ICE connectivity checks complete
    ↓
RTCDataChannel opens (state: 'open')
    ↓
Viewer registers Service Worker at scope '/'
    ↓
bootstrap.ts posts 'mux-ready' to SW
    ↓
FetchGate opens: queued fetches are flushed
```

**Viewer page state during ICE:**

```
  Connecting to localhost:3000...
  ████████░░░░░░░░  (animated progress)
```

### Step 10: Tunnel active

RTCDataChannel reaches `'open'` state. Service Worker is registered. The viewer page loads the proxied content via the tunnel.

**Viewer page state:**

```
  ✓ Connected — relay active
  Host: localhost:3000
  Session expires in: 58 minutes
```

All `fetch()` calls from the viewer page are now intercepted by the Service Worker and routed over the DataChannel to the host's localhost.

---

## Phase 3 — Active Session

### Normal relay (invisible to user)

```
Viewer page runs fetch('/api/users')
    ↓  (intercepted by Service Worker)
SW → encodeRequest() → Beam frames → relay-request postMessage
    ↓
bootstrap.ts → DataChannel.send(frame)
    ↓
Host receives frame → decodeFrame() → authorize path → replay to localhost:3000
    ↓
localhost returns HTTP 200 + JSON body
    ↓
Host → RESPONSE_HEAD + RESPONSE_BODY_CHUNK(s) + RESPONSE_END frames
    ↓
Viewer SW receives frames → ResponseAssembler → ReadableStream → Response
    ↓
fetch() resolves with the real HTTP response
```

### Request log (host terminal)

```
[BEAM] GET /api/users → 200 OK  (142ms)
[BEAM] GET /api/products → 200 OK  (89ms)
[BEAM] POST /api/checkout → 403 Forbidden (path not in --allowed-paths)
```

---

## Phase 4 — Error Flows

### Wrong PIN entered

```
Viewer enters wrong code and clicks Connect.
DO validates: hash mismatch.
DO sends: {"type":"pin-failed","reason":"wrong-pin","attemptsLeft":2}
```

**Viewer page:**

```
  ✗ Wrong Auth Code. 2 attempts remaining.
  ┌──────────────────────────────────────┐
  │   _ _ _  _ _ _                       │
  └──────────────────────────────────────┘
              [ Try Again ]
```

### PIN locked (3 failures)

```
DO sends: {"type":"pin-failed","reason":"max-attempts"}
DO closes WebSocket: ws.close(1008, 'pin-locked')
```

**Viewer page:**

```
  🔒 Session locked after 3 failed attempts.
     Contact the host to start a new session.

     [ Close tab ]
```

The session code is permanently invalidated. The host must run `beam` again to start a new session.

### ICE failure (symmetric NAT)

```
RTCPeerConnection.connectionState → 'failed'
ViewerConnection emits 'close' event
```

**Viewer page:**

```
  ✗ Connection failed: peer connection failed

  This may be due to a strict network firewall (symmetric NAT).
  Beam v1 does not include a TURN relay.

  Workarounds:
    • Try from a different Wi-Fi or network
    • Ask the host to use --signaling with a self-hosted TURN endpoint
```

**SW behavior on disconnect:** `onMuxGone()` is called → all queued/open fetches resolve with `HTTP 504 Gateway Timeout`.

### Host killed / Ctrl-C mid-session

```
Host process exits → node-datachannel closes DataChannel → DO receives WebSocket close
```

**Viewer page (if DataChannel was open):**

```
  ✗ Host disconnected.
     The developer stopped their Beam session.

  [ Close tab ]
```

**Active fetches in the viewer page return HTTP 504 immediately.**

### Session TTL expires (host-side)

Host's `ExecuteSessionUseCase.isExpired()` triggers:

```
Host calls runtime.close('ttl-expired')
    ↓
Host WebSocket closes
    ↓
DO closes viewer WebSocket
    ↓
Viewer: renderFailed('session expired')
```

**Viewer page:**

```
  ✗ Session expired.
     This Beam session has reached its time limit.
```

### Session URL opened after host stopped

If viewer opens a link for a session that no longer exists:

```
Viewer WebSocket connects → DO has no host socket
    ↓ (after PIN validation passes — viewer is legitimate)
DO sends {"type":"viewer-joined"} but no host relay target exists
    ↓
60-second ICE timeout fires
    ↓
renderFailed('connect-timeout')
```

**Better UX (post-v1 improvement):** DO should detect no-host-present on viewer connect and immediately send `{"type":"host-gone"}` to fail fast.

---

## Phase 5 — Session Termination

### Normal termination (host Ctrl-C)

```
Host presses Ctrl-C
    ↓
SIGINT handler fires → runtime.close('host interrupted (SIGINT)')
    ↓
ExecuteSessionUseCase.closeSession() called
    ↓
Signaling WebSocket disconnected
    ↓
node-datachannel peer connection closed
    ↓
DO receives host WebSocket close event
    ↓
DO closes viewer WebSocket (code 1001, reason 'host-closed')
    ↓
DO deletes 'pin:<code>' from storage
    ↓
Viewer: renderFailed('host disconnected')
    ↓
SW: onMuxGone() → all pending fetches → HTTP 504
    ↓
Link is permanently invalid (code marked used in UsedTokenStore)
```

**Expected end-to-end latency from Ctrl-C to viewer `renderFailed`:** < 500 ms (S18 Proof 6 target).

---

## Summary: States of the Viewer UI

| State | Trigger | UI |
|---|---|---|
| `loading` | URL opened, before JS loads | Browser native loading |
| `pin-entry` | JS loaded, session exists | PIN input form + trust warning |
| `connecting` | PIN accepted, ICE in progress | Spinner + "Connecting..." |
| `connected` | DataChannel open | Session info + live relay |
| `pin-wrong` | Wrong PIN, attempts remain | Error + retry field |
| `pin-locked` | 3 wrong PINs | Locked error, no retry |
| `failed-ice` | connectionState = 'failed' | ICE failure with instructions |
| `failed-host-gone` | Host disconnected during relay | "Host disconnected" |
| `failed-expired` | TTL reached | "Session expired" |
| `failed-timeout` | 60-second ICE timeout | "Could not connect" |
