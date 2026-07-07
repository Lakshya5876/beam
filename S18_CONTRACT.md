# S18 Contract: Live E2E Verification — 7 First-Real-Proofs

**Objective:** Verify Beam end-to-end against a real deployed signaling server and a real
browser RTCPeerConnection. Seven proofs, one of which (Proof 0) is a prerequisite that
may require a code change before the remaining six can be run.

**Prerequisites (before any proof):**
- Signaling Worker and viewer Pages app deployed (per DEPLOY.md) by the human on a
  deploy machine. Agent never runs deploy commands.
- `beam <port>` runs locally against a dev server on a known port.
- Two endpoints: one running the viewer (any machine with Chrome), one running beam CLI.

---

## PROOF 0 — RTCDataChannel ceiling check (prerequisite, run first)

### Why this is the gate for everything else

`MAX_PAYLOAD_SIZE` is currently `256 * 1024 = 262144` bytes. The encoded frame is
`payload.byteLength + HEADER_SIZE (9) = 262153` bytes. Chromium and Firefox implement
SCTP with a per-message interop ceiling of approximately 16 KiB (16384 bytes). A frame
larger than that ceiling may be dropped silently or reset the data channel with no error
surfaced to application code. The N7 unit test verified the arithmetic (frame size =
payload + 9) but not the ceiling fit. If the ceiling bites, every large-body proof fails
silently.

**Run this before the other six proofs. Branch on the result.**

### Procedure

1. Establish a real peer connection (use the same setup as Proof 1 below).
2. On the page side, manually send a `Uint8Array` of exactly `MAX_FRAME_SIZE` bytes
   (262153) over the data channel.
3. On the host side, observe whether the frame arrives intact via the mux `onFrame` handler.

### Branch A — frame arrives intact (ceiling not hit in practice)

Chrome may coalesce SCTP chunks internally above the app-visible layer. If the 262153-byte
frame arrives without corruption or channel reset:
- `MAX_PAYLOAD_SIZE` stays at `256 * 1024`.
- Document the result as "ceiling confirmed clear at 256 KiB in Chrome `<version>`."
- Proceed to Proofs 1–6.

### Branch B — frame dropped, corrupted, or channel reset

If the oversized frame fails at the wire:
1. Change `src/domain/frame.ts` line 26:
   ```ts
   // Before:
   export const MAX_PAYLOAD_SIZE = 256 * 1024;
   // After:
   export const MAX_PAYLOAD_SIZE = 16375; // 16384 (RTCDataChannel ceiling) − HEADER_SIZE (9)
   ```
2. **CORE_FILES change** (`src/domain/**` ∈ CORE_FILES) → TIER 3 required:
   ```bash
   npx vitest run --coverage   # all tests import MAX_PAYLOAD_SIZE symbolically — no test edits needed
   npx eslint --ignore-pattern 'viewer/dist/**' .
   npx tsc --noEmit
   ```
3. Commit: `fix(domain): reduce MAX_PAYLOAD_SIZE to RTCDataChannel 16 KiB interop ceiling`
4. Re-run Proof 0 with the corrected constant to confirm fix.
5. Proceed to Proofs 1–6.

---

## PROOF 1 — Real ICE round-trip

**What it verifies:** S9 candidate buffering, S15b answerer state machine, and basic P2P
connectivity under real NAT conditions.

**Procedure:**
1. Run `beam 3000` (or any port) on the host machine.
2. Copy the session URL printed by the CLI.
3. Open the URL in Chrome on a remote machine (or a different network, to exercise NAT).
4. Observe `RTCPeerConnection` reaches `connected` in the browser console.
5. Check: no `InvalidStateError` on `addIceCandidate` (would indicate the S9 buffering
   regression — candidates arriving before `setRemoteDescription`).

**Pass criteria:** `connected` state reached; no ICE errors in console; viewer renders
"Connected — ready to relay."

---

## PROOF 2 — S8↔S14↔S15b URL seam

**What it verifies:** `buildViewerSignalingUrl(base, code)` in the viewer produces a URL
the signaling DO's `parseSessionCodeFromUrl()` can parse. This is the three-point triangle
established in S14 and verified in unit tests with string equality — Proof 2 verifies it
on the deployed Worker.

**Procedure:**
1. Note the session URL from `beam 3000` — it contains `?signaling=<worker_url>/<code>`.
2. Confirm the viewer's `extractSessionCode()` parses `<code>` correctly (check
   `sessionCode` in the browser console or add a transient log).
3. Confirm the signaling DO pairs the offer and answer (no 404, no pairing failure).
4. Confirm `buildViewerSignalingUrl(base, code)` produces the same URL form as the host's
   `buildUrl(base, code)` — compare the two values directly.

**Pass criteria:** Pairing succeeds; both sides use the same URL form; no 404 from the DO.

---

## PROOF 3 — Durable Object hibernation survival

**What it verifies:** DO pairing state survives a hibernation cycle. The rate-limiter
resets on hibernation (documented in LIMITATIONS.md) but pairing state must not.

**Procedure:**
1. Host mints a session code (CLI prints URL).
2. Wait > 30 seconds without any WebSocket activity (forces the DO to hibernate).
3. Open the viewer URL. The viewer connects — the DO must wake, retrieve the stored offer,
   and complete pairing.

**Pass criteria:** Pairing completes after a cold-wake cycle; session is not lost.

---

## PROOF 4 — S4.1 backpressure (slow localhost)

**What it verifies:** `waitForDrain()` prevents unbounded buffer growth when the localhost
server is slow. Tests the half-close stream lifecycle (S4.1) under real throughput pressure.

**Procedure:**
1. Point beam at a localhost server that returns a large response slowly (e.g., a 10 MB
   file served with artificial 1 ms delay between chunks).
2. Relay the request through the viewer.
3. Monitor `RTCDataChannel.bufferedAmount` on the viewer side (check via browser DevTools
   or a temporary log in `BrowserDataChannelAdapter`).

**Pass criteria:** `bufferedAmount` stays bounded (does not grow unboundedly); response
completes intact; no OOM in the viewer tab.

---

## PROOF 5 — Full SW + fetch interception E2E

**What it verifies:** The complete relay path: SW intercepts a real `fetch()` from the
viewer page, routes through `handleFetch` and `FetchGate`, page writes frames to the mux,
host replays to localhost, response streams back through `ResponseAssembler`, and the
page receives a real HTTP response.

**This is the primary S18 proof.**

**Procedure:**
1. With peer connection active and SW registered, open DevTools on the viewer page.
2. In the console, run: `fetch('/api/ping').then(r => r.text()).then(console.log)`.
3. Observe in the Network tab: the request appears as "fulfilled by Service Worker."
4. Observe on the host side: the relay log shows the request arriving and being replayed.
5. Confirm the response body matches what localhost returns.

**Pass criteria:**
- SW intercepts the fetch (Network tab shows "(Service Worker)" as the initiator).
- Response body is correct and intact.
- No 504 in the browser.
- `/__beam/sw.js` and `/assets/main-*.js` do NOT appear as intercepted requests (exclusion
  predicate is working).
- `mux.openStreamIds()` / `conn.openStreamIds()`: confirm the stream is tracked while
  in-flight and cleared after `RESPONSE_END` (check that `trackedStreamIds` in
  `ViewerConnection` returns to empty after the fetch completes).

---

## PROOF 6 — S19 honest failure (forced symmetric NAT)

**What it verifies:** ICE failure surfaces as a named, fast error — not a silent hang.
`renderFailed()` is shown; relay-error reaches the SW; queued fetches resolve with 504.

**Procedure:**
1. Enable a firewall rule or connect via a symmetric NAT network (some mobile hotspots).
2. Start beam and open the viewer.
3. Observe ICE failure: `RTCPeerConnection.connectionState` reaches `failed`.
4. Observe viewer renders `renderFailed('peer connection failed')`.
5. While the connection is failing, issue a `fetch('/api/test')` from the viewer page.

**Pass criteria:**
- Viewer shows the failure page promptly (no silent hang > 30s).
- The queued fetch resolves with a 504 (not a thrown error — B3 invariant holds at the
  browser level).
- Browser console shows `relay-error` with `reason: 'disconnect'` posted to the SW.

---

## Critical Path

```
Proof 0 (ceiling gate)
  └─ Branch A (clear) or Branch B (fix + re-verify)
       └─ Proof 1 (ICE round-trip) — basic P2P gate
            └─ Proof 5 (SW + fetch E2E) — the primary proof
                 └─ Proofs 2, 3, 4, 6 — in any order after Proof 1
```

Proofs 2, 3, 4, and 6 are independent of Proof 5 and can run in any order. Proof 0 and
Proof 1 are strict prerequisites for all others.

---

## If Proof 0 Branch B fires: scope of the frame.ts change

`src/domain/frame.ts` is in CORE_FILES (`src/domain/**`). Changing `MAX_PAYLOAD_SIZE`
triggers:
- TIER 3 mandatory (full suite, not just domain tests).
- All tests import `MAX_PAYLOAD_SIZE` symbolically — no test edits needed. The chunking
  tests (`relay-use-case.test.ts`, `request-serializer.test.ts`) will pass with the smaller
  constant unchanged.
- Re-run `npm run build --prefix viewer` to ensure the updated constant propagates into
  `dist/__beam/sw.js` and `dist/assets/main-*.js`.
- If the viewer is already deployed, re-deploy after the fix commit (human action per
  DEPLOY.md).

---

## Out of scope for S18

- `wrangler deploy` / `wrangler pages deploy` — human-only action per LOCAL-ONLY constraint.
- S20 (README, final LIMITATIONS.md, MIT license) — deferred.
- TURN relay — explicitly out of scope per LIMITATIONS.md; symmetric NAT failure is the
  documented behavior, not a defect.
