# Beam — Deploy Instructions

**Important:** Do not run any command in this file on the dev laptop.
All deploy commands transmit code off-machine. Run them on a dedicated
deploy machine or in CI.

---

## Prerequisites

- Node >= 22 and npm
- Wrangler CLI: `npm install -g wrangler` (or `npx wrangler`)
- Cloudflare account with:
  - A Pages project named `beam-viewer`
  - A Workers project for the signaling server

---

## Environment Variables

| Variable | Where Used | Example |
|----------|-----------|---------|
| `SIGNALING_BASE_URL` | `viewer/src/main.ts` at runtime (URL search param) | `https://beam-signal.workers.dev` |

The viewer reads `SIGNALING_BASE_URL` from the `?signaling=` query param — no
build-time injection needed. The host CLI reads its own env vars from `src/config.ts`.

---

## Build (run on any machine including local)

```bash
# Build the viewer bundle — output to viewer/dist/
npm run build --prefix viewer

# Expected output structure:
#   viewer/dist/__beam/sw.js              — service worker (fixed filename)
#   viewer/dist/assets/sw-bridge-*.js     — SW↔main bridge (hashed)
#   viewer/dist/assets/main-*.js          — main app bundle (hashed)
#   viewer/dist/index.html                — root HTML
#   viewer/dist/_headers                  — CF Pages headers config (copied from viewer/public/)
```

---

## Deploy (deploy machine only)

### 1. Signaling Worker

```bash
wrangler deploy --config signaling/wrangler.jsonc
```

No Durable Object migration needed — the DO schema is append-only.

### 2. Viewer (Cloudflare Pages)

```bash
wrangler pages deploy viewer/dist/ \
  --project-name beam-viewer \
  --branch main
```

CF Pages reads `viewer/dist/_headers` automatically and applies the
`Service-Worker-Allowed: /` header to `/__beam/sw.js`. This header is required —
without it, Chrome throws a silent `SecurityError` when `bootstrap.ts` calls
`navigator.serviceWorker.register('/__beam/sw.js', { scope: '/' })`.

---

## Verify After Deploy

```bash
# 1. SW header — must be present, exact value
curl -sI https://beam-viewer.pages.dev/__beam/sw.js | grep Service-Worker-Allowed
# Expected: Service-Worker-Allowed: /

# 2. Root page loads
curl -s https://beam-viewer.pages.dev/ | grep beam-root
# Expected: <main id="beam-root">

# 3. Signaling worker responds
curl -s https://beam-signal.workers.dev/
# Expected: 404 or method-not-allowed (no bare GET handler — this is correct)
```

---

## Path Consistency (do not change without updating sw.ts)

The `/__beam/` path prefix is load-bearing:

| File | Role |
|------|------|
| `viewer/vite.config.ts` | Outputs SW to `dist/__beam/sw.js` |
| `viewer/src/bootstrap.ts` | Registers at `/__beam/sw.js` |
| `viewer/src/sw.ts` | Excludes `/__beam/*` from fetch interception |
| `viewer/public/_headers` | Applies `Service-Worker-Allowed: /` to `/__beam/sw.js` |

Changing any one of these without updating the others will break the relay.

---

## S18 Pre-Flight Checks

Before running the live E2E suite (S18), confirm these items:

1. **RTCDataChannel message size ceiling**: `MAX_PAYLOAD_SIZE` is already set to
   `16375` bytes (`16384 − HEADER_SIZE 9`) — the SCTP interop ceiling. Proof 0
   in S18 confirms this holds at the wire. No code change needed unless Proof 0
   surfaces a lower ceiling on the target browser version.

2. **PIN gate**: The viewer shows a 6-digit PIN form before establishing the
   WebRTC connection. The host CLI prints the PIN at startup. The signaling DO
   verifies the SHA-256 hash and enforces a 3-attempt lockout. No additional
   deploy config needed — it is entirely runtime behaviour in the DO and viewer.

3. **`mux.openStreamIds()` accessor**: The `ViewerConnection` wrapper exposes
   `openStreamIds()` via `trackedStreamIds`. Confirm at S18 that bootstrap's
   `conn.onclose((openStreamIds) => { ... })` receives the correct live IDs under
   real transport-close conditions.
