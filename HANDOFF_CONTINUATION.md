# Beam — Live-Deploy Debug Handoff (Continuation)

**Author:** Cursor agent (live-debug session)
**Date:** 2026-06-29
**Reads on top of:** `HANDOFF.md` (architecture baseline — read that FIRST for layout, wire protocol, layer rules).
**This document covers:** everything that happened AFTER `HANDOFF.md` was written (its HEAD was `e900069`), through the first real two-machine deployment and live debugging, up to the one bug that is still open.

> Read `CLAUDE.md` before touching anything. Local-only rules still apply: the agent NEVER runs `git push` or `wrangler deploy`. The human deploys from their personal Windows laptop.

---

## 1. TL;DR for the incoming agent

The full pipeline now works end-to-end EXCEPT the very last hop:

- Host CLI mints a session, connects signaling over `wss://`, prints viewer URL + 6-digit PIN. ✅
- Viewer loads, registers SW, PIN gate passes, WebRTC negotiates, **DataChannel OPENs**. ✅
- Viewer page logs `mux ready` and `sending mux-ready to SW`. ✅
- **`fetch('/test')` in the viewer tab returns HTTP 504 `Beam: relay unavailable / timeout` after 30 s.** ❌ ← THE OPEN BUG

The 504 reason is literally `timeout` (from `sw-fetch-gate.ts` `enqueue`'s `setTimeout`). That means the Service Worker instance that handled the fetch had `gate.ready === false`, i.e. it never saw a `mux-ready`. The page DID send `mux-ready` (it's in the logs). **Conclusion: the SW that received `mux-ready` is not the same SW instance that handled the fetch — the SW was terminated/respawned in between and its in-memory `gate` state was lost.** Full diagnosis + recommended fix in §6. This is the next thing to fix.

The currently deployed viewer bundle is `main-DaVcTFb1.js` — confirmed live in the Windows console — so all fixes listed below ARE deployed. The 504 is a genuine remaining gap, not a stale build.

---

## 2. Exact git state right now

```
HEAD: 135bc86  fix(relay): prevent TypeError propagation and WS-close tearing down DataChannel
Branch: feat/domain-frame
Suite: 206/206 passing, ~87.5% line coverage (verified this session)
```

**Uncommitted, modified, NOT yet staged (these are live in the deployed bundle / running host — commit them):**

- `src/infrastructure/signaling-client.ts` — `buildUrl()` now rewrites `https://→wss://` and `http://→ws://` before appending the code. Without this the host CLI fails with `SignalingConnectFailed: failed to open socket` because `node-datachannel` needs a `ws(s)://` scheme. **One-line change. Host-side. Run via `tsx` so it's already active for the human's live runs.**
- `viewer/src/bootstrap.ts` — two changes (both built into the deployed bundle):
  1. **Offer-drop race fix:** `requestPinVerification` now returns `MessageEvent[] | null` instead of `boolean`. After `pin-ok` it keeps buffering all non-PIN WS messages and returns them; `bootstrap` replays them into the WS (via `dispatchEvent`) after `ViewerConnection` is constructed, so the host's offer/ICE that the DO flushes immediately after `pin-ok` can't be dropped before the connection's handler is attached.
  2. **mux-ready controller timing fix:** `wireRelayBridge` no longer bails when `navigator.serviceWorker.controller` is null. It defines `sendMuxReady()` which, if the controller isn't there yet, waits for `controllerchange` (once) then posts `mux-ready`. The `relay-response` post now re-reads `navigator.serviceWorker.controller` each time with a null guard.

**Committed in `135bc86` (this session's three robustness fixes):**

| File | Fix | Why |
|---|---|---|
| `viewer/src/sw.ts` | Wrapped entire `handleFetch` body in `try/catch`; any throw → `make504('internal: …')` + `trackStreamClose`. | `encodeRequest`/`makeFrame` throws on oversized header JSON (>16 KiB), which surfaced as `TypeError: Failed to fetch` instead of a clean 504. |
| `viewer/src/viewer-connection.ts` | `socket.onclose` now only calls `peer.close()` if `this.mux === null`. | A signaling-WS idle-timeout after the DataChannel is open was tearing down the live relay (1006 close). |
| `signaling/src/session-do.ts` | Wrapped both `peer.send()` call sites (`relayMessage` + `flushPendingToViewer`) in `try/catch`. | A stale WS handle after DO hibernation threw inside `webSocketMessage`, crashing the isolate and 1006-closing every peer. |

**Already committed before this session (in `f99f11a` / `509bfdc`) — do not redo:** the DO hibernation persistence refactor (`PIN_VERIFIED_KEY`, `PENDING_PREFIX`, `PENDING_COUNT_KEY` in `session-do.ts`), the ICE JSON wire-format fix, null `sdpMid → '0'`, `setImmediate` removal, static datachannel import, `url→path` rename, `encodeRequest` wiring, `listeningStreams` dedupe, `onFrame→onInbound`. See `HANDOFF.md §8`.

**Untracked (intentional — see `HANDOFF.md §13`):** `HANDOFF.md`, `S17/S18_CONTRACT.md`, `e2e-*.mjs`, `handoff_cursor.md`, `memory/`, and two deploy zips: `beam-deploy.zip` (full tree, old) and `beam-patch.zip` (12 KB, the 5-file patch used this session).

**Action item for incoming agent:** commit `signaling-client.ts` + `bootstrap.ts` (they pass all gates; they're already deployed/running). Suggested message: `fix(relay): wss scheme rewrite + post-pin-ok replay + controllerchange mux-ready`.

---

## 3. The deployment topology the human is actually using

This is NOT the local-dev flow in `HANDOFF.md §10`. The human runs a real two-machine setup:

- **Mac (this repo):** runs the host CLI via `npx tsx src/presentation/cli.ts …`. Also runs a dummy origin server: `node -e "require('http').createServer((req,res)=>{res.end('Hello, this is wakalaka.')}).listen(4242)"` on `http://localhost:4242`. (I started this server in the background this session; verified it returns `Hello, this is wakalaka.`)
- **Cloudflare (deployed from a personal Windows laptop, signed in with personal Google account):**
  - Signaling Worker + DO: `https://beam-signaling.lakshyahappy.workers.dev`
  - Viewer (Cloudflare Pages, project `beam-viewer`): each deploy gets a new hash subdomain, e.g. `https://9e3230f6.beam-viewer.pages.dev`. **The viewer URL changes on every `wrangler pages deploy`** — the human pastes the fresh one into the CLI `--viewer` flag.
- **Windows laptop:** the viewer/collaborator browser (incognito each time to avoid stale SWs).

**Host CLI invocation the human uses:**
```
npx tsx src/presentation/cli.ts \
  --signaling https://beam-signaling.lakshyahappy.workers.dev \
  --viewer https://<latest-pages-hash>.beam-viewer.pages.dev
```
Then types `http://localhost:4242` at the prompt.

**Deploy commands the human runs on Windows (NOT the agent):**
```
cd beam-deploy\signaling
npx wrangler deploy --config wrangler.jsonc
cd ..
npx wrangler pages deploy viewer\dist\ --project-name beam-viewer --branch main
```

**Patch-zip workflow (to avoid re-zipping `node_modules`):** `node_modules` already exists on Windows from an earlier `npm ci`. So changed files are shipped as a tiny `beam-patch.zip` (built on Mac) containing only the changed sources + rebuilt `viewer/dist/`, extracted over `beam-deploy\` with overwrite. This session's `beam-patch.zip` contained: `signaling/src/session-do.ts`, `viewer/dist/index.html`, `viewer/dist/__beam/sw.js`, `viewer/dist/assets/main-DaVcTFb1.js`, `viewer/dist/assets/sw-bridge-CExQHa_s.js`.

> NOTE: `wrangler pages deploy` ships `viewer/dist/` (already-built static assets), so the Windows side does NOT need to rebuild the viewer — the Mac builds it (`npm run build --prefix viewer`) and ships `dist/` in the zip. The signaling Worker IS built/bundled by wrangler on deploy from `signaling/src`.

---

## 4. How to rebuild + repackage (Mac side)

```bash
# type-check everything
npx tsc --noEmit
npx tsc --noEmit -p signaling/tsconfig.worker.json
# build the viewer (emits viewer/dist/, asset hashes change when source changes)
npm run build --prefix viewer
# full gate
npx vitest run            # 206/206 expected

# build the patch zip (adjust the main-*.js / sw-bridge-*.js hashes to the new build output)
rm -f beam-patch.zip
zip beam-patch.zip \
  signaling/src/session-do.ts \
  viewer/dist/index.html \
  viewer/dist/__beam/sw.js \
  viewer/dist/assets/main-XXXXXXXX.js \
  viewer/dist/assets/sw-bridge-XXXXXXXX.js
```
The asset filenames are content-hashed by Vite — read the actual names from the `npm run build` output (or `viewer/dist/assets/`) before zipping. If you change `bootstrap.ts` or `sw.ts` you MUST rebuild and re-ship the new `dist/`.

---

## 5. End-to-end test procedure (what "working" looks like)

1. Mac: dummy origin on `:4242` running.
2. Mac: start CLI with the latest `--viewer` pages URL, enter `http://localhost:4242`. Copy the printed Viewer URL + 6-digit code.
3. Windows: open Viewer URL in a **fresh incognito window**, enter the PIN, click connect.
4. Page should show **"Connected — ready to relay."** (this already works).
5. In that tab's console: `fetch('/test').then(r=>r.text()).then(t=>console.log('RESULT:',t))`
   - **Expected:** `RESULT: Hello, this is wakalaka.`
   - **Currently:** 504 `Beam: relay unavailable / timeout` ← the open bug.
6. Final acceptance: open `https://<hash>.beam-viewer.pages.dev/test` in a new tab of the same incognito window → should render `Hello, this is wakalaka.`.

**Stale Service Worker is a recurring footgun.** Between attempts, either use a brand-new incognito window or run in the console:
```js
navigator.serviceWorker.getRegistrations().then(rs => { rs.forEach(r => r.unregister()); console.log('cleared', rs.length); });
```
Then hard-reload.

---

## 6. THE OPEN BUG — full diagnosis + recommended fix

### Symptom
After `DataChannel OPEN` + `mux ready` + `sending mux-ready to SW`, `fetch('/test')` hangs ~30 s then returns 504 with body `<h1>Beam: relay unavailable</h1><p>timeout</p>`. On the Mac (host) terminal there is **no** new activity after `DataChannel OPEN` — the request frames never reach the host.

### Root cause (high confidence)
The Service Worker's readiness lives in **in-memory module state**: `gate` in `viewer/src/sw-fetch-gate.ts` (`ready`, `source`, `openStreams`, …). The page tells the SW it's ready exactly once, via a one-shot `mux-ready` postMessage (`bootstrap.ts → wireRelayBridge → sendMuxReady`). Service Workers are terminated aggressively when idle and respawned on the next event. When Chrome/Cloudflare kills the SW after it processes `mux-ready` and then spins up a **fresh** SW instance to handle the `fetch`, that new instance has `gate.ready === false` and `gate.source === null`. Nothing ever re-delivers `mux-ready`, so `enqueue` sits until its 30 s timer fires → 504 `timeout`. The host never sees the request because the SW never posted any `relay-request` (it was stuck in the gate).

Why we're confident it's lifecycle and not a stale bundle: the live console shows `main-DaVcTFb1.js` (the newest build with every fix), `sending mux-ready to SW` IS logged (so `controller` was non-null and the post happened), and the 504 reason is exactly `timeout` (the gate path), not `no-source` or `internal`.

### Recommended fix (SW pulls the handshake instead of relying on a one-shot push)
Make readiness recoverable after a SW restart. Two coordinated changes:

1. **`viewer/src/sw-bridge.ts`** — add a new message type `{ type: 'request-mux-ready' }` (SW → page) to `SwMessage`, its parser, and serializer.

2. **`viewer/src/sw.ts`** — in `handleFetch`, when `enqueue` would have to wait (gate not ready), proactively pull:
   - Set `gate.source` directly from the fetch event's client: in the `fetch` listener capture `event.clientId` (or `event.resultingClientId`) and `self.clients.get(clientId)` → that's the WindowClient that issued the request; use it as the relay target instead of depending on the dead instance's stored `gate.source`.
   - `self.clients.matchAll({ type: 'window' })` → post `{ type: 'request-mux-ready' }` to each, so a page whose mux is open re-announces. Keep the existing 30 s timeout as the backstop.

3. **`viewer/src/bootstrap.ts`** — hoist the live `mux` + `sessionCode` into a scope the SW-message listener can see, and when a `request-mux-ready` arrives AND the mux is open, re-post `mux-ready`. (Right now `wireRelayBridge` only sends it once.)

This makes the handshake idempotent and restart-safe: any fetch after a SW respawn re-triggers the announce, the page replies, the gate flips ready, and queued fetches drain.

### Cheaper interim probe (optional, to confirm the diagnosis before building the fix)
Have the human reproduce, then **immediately** (within ~2 s of "Connected — ready to relay", before the SW can idle out) run the `fetch('/test')`. If it succeeds when fast and 504s when slow, that confirms SW termination is the cause. Also: in DevTools → Application → Service Workers, watch the SW flip to "stopped" — fetching while stopped triggers a fresh start with empty `gate`.

### Tests to add with the fix (per `CLAUDE.md §7 N1/N2`)
- `viewer/test/sw-fetch-gate.test.ts`: a fetch enqueued before ready, then a `request-mux-ready`→`mux-ready` round trip, resolves `{ok:true}` and does not 504.
- `viewer/test/sw-bridge.test.ts`: round-trip parse/serialize of the new `request-mux-ready` type; malformed → null.

---

## 7. Outstanding work, in priority order

1. **Fix the SW readiness/restart bug (§6).** This is the only thing between "negotiates" and "actually relays HTTP." Rebuild viewer, ship a new `beam-patch.zip`, human redeploys Pages.
2. **Commit the two uncommitted files (§2).** They're already live; just not in git.
3. **Re-run S18 live proofs** (`S18_CONTRACT.md`, Proofs 0–6) once §1 passes. Proof 0 (DataChannel 16 KiB ceiling) gates the rest.
4. **npm packaging** (`HANDOFF.md §12 Step 3`): `@beamtunnel/cli`, bin `bm`, `tsc → dist/`, `.npmignore`. ~4–6 h.
5. **TURN relay** (optional, post-v1) for symmetric-NAT networks — see `LIMITATIONS.md`.

---

## 8. Gotchas the next agent will hit

- **Pre-commit gate + sandbox:** `.githooks/gate.sh` writes `.claude/gate_state.json`; in the tool sandbox this fails with `EPERM: rename gate_state.json.tmp`. Re-run the commit with `required_permissions: ["all"]`. The gate runs the full tier-3 suite (~12 s) and is what produced the green report on `135bc86`.
- **Viewer asset hashes change every build.** Don't hard-code `main-DaVcTFb1.js`; read the build output.
- **Pages URL changes every deploy.** The `--viewer` flag must be updated each time; the viewer URL embeds `?signaling=…/<sessionId>` which the host CLI builds from `--signaling` + the freshly minted code.
- **`viewer/dist` is gitignored** — `git add viewer/dist` fails. That's expected; it ships via the zip, not git.
- **Local-only invariant (`CLAUDE.md §3`):** no `git push`, no `wrangler deploy`, no network egress of repo contents from the agent. The human does all deploys.
- **DO hibernation** already handled for PIN/pending state (persisted to `state.storage`); don't reintroduce in-memory-only session state there.
