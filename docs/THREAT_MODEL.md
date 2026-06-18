# Beam — Security & Abuse Threat Model

**Version:** 1.0 (MVP + PIN pairing)  
**Date:** 2026-06-19  
**Methodology:** STRIDE (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege)

---

## 1. Trust Boundary Map

```
┌───────────────────────────────────────────────────────────────┐
│  TRUSTED ZONE                                                 │
│  ┌──────────────┐                                            │
│  │ Host process │ — developer's machine; controls TTL, paths │
│  │ (localhost)  │ — process exit = instant tunnel collapse   │
│  └──────┬───────┘                                            │
│         │ TRUST BOUNDARY 1 (RTCDataChannel — DTLS-SRTP)     │
└─────────┼─────────────────────────────────────────────────── ┘
          │
┌─────────┼──────────────────────────────────────────────────── ┐
│  SEMI-TRUSTED ZONE (Cloudflare infrastructure)                │
│  ┌──────▼──────────────────────┐                              │
│  │  Signaling Durable Object   │ — PIN hash storage          │
│  │  (Cloudflare Workers)       │ — SDP/ICE opaque relay      │
│  │                             │ — Session code registry     │
│  └──────┬──────────────────────┘                              │
│         │ TRUST BOUNDARY 2 (WebSocket — TLS 1.3)             │
└─────────┼──────────────────────────────────────────────────── ┘
          │
┌─────────┼──────────────────────────────────────────────────── ┐
│  UNTRUSTED ZONE                                               │
│  ┌──────▼──────────────────────┐                              │
│  │  Viewer (remote browser)    │ — attacker-reachable surface │
│  │  Service Worker + WebRTC    │ — must be validated          │
│  └─────────────────────────────┘                              │
└───────────────────────────────────────────────────────────────┘
```

**Critical invariant:** No HTTP payload ever crosses Trust Boundary 2. The signaling DO only relays SDP/ICE JSON blobs and validates PINs. Application data travels exclusively over the DTLS-SRTP-protected RTCDataChannel (Boundary 1).

---

## 2. Threat Catalog

### T1 — Unauthorized viewer access (link leak)

| Attribute | Value |
|---|---|
| **Category** | Spoofing / Information Disclosure |
| **Actor** | Attacker who obtained the session URL (e.g., from a Slack message) |
| **Attack** | Attacker opens the viewer URL and attempts to access the developer's localhost |
| **Without PIN pairing** | **Succeeds** — URL alone grants viewer access |
| **With PIN pairing** | **Blocked** — attacker connects as `viewer_pending`; must provide the 6-digit PIN to get `viewer` role; PIN was transmitted out-of-band |
| **Residual risk** | Social engineering: attacker tricks host into sharing both URL and PIN simultaneously |
| **Mitigation** | Documentation emphasizes sending URL and PIN via separate channels (e.g., URL in email, PIN over voice) |
| **Implemented** | ✓ PIN validated server-side in DO before any ICE forwarding |

---

### T2 — PIN brute-force

| Attribute | Value |
|---|---|
| **Category** | Elevation of Privilege |
| **Actor** | Attacker with the session URL who attempts to guess the 6-digit PIN |
| **Attack** | Rapidly submits `{"type":"pin","value":"000000"}` through `{"type":"pin","value":"999999"}` |
| **Space** | 10^6 combinations (000000–999999) |
| **Mitigation 1** | 3-strike lockout: after 3 failures, DO closes WebSocket (1008), session permanently locked |
| **Mitigation 2** | Each attempt requires a WebSocket connection + round-trip; even at 100 ms/attempt, 3 attempts = 3 attempts total |
| **Mitigation 3** | Session TTL of ≤ 4 hours limits the window of exposure |
| **Implemented** | ✓ 3-strike lockout (pinattempts stored in DO storage, survives hibernation) |
| **Residual risk** | Attacker with many IPs can create multiple sessions. Not applicable here — brute force is per-session, and the code owner controls whether to re-mint after lockout |

---

### T3 — Phishing (viewer-as-victim)

| Attribute | Value |
|---|---|
| **Category** | Spoofing |
| **Actor** | Attacker who runs Beam, crafts a malicious localhost app, tricks victim into opening the viewer URL |
| **Attack** | Attacker's `beam 3000` exposes a localhost phishing page. Victim opens the viewer link, sees a convincing login form or OAuth screen rendered through the tunnel |
| **Mitigation 1** | Viewer page prominently warns: "You are connecting to a developer's local server. Do not proceed if you did not receive this link from someone you trust." |
| **Mitigation 2** | Viewer URL origin (`beam-viewer.pages.dev`) cannot be spoofed by the attacker — attacker cannot create a fake `beam-viewer.pages.dev` that hosts the same Service Worker |
| **Mitigation 3** | Beam is explicitly a developer tool, not a general-purpose sharing service. Marketing and documentation must not encourage non-developer use cases |
| **Residual risk** | Viewers who ignore the warning, or who receive links from a social-engineering attacker, can be phished. This is an acceptable residual risk for a developer-targeted tool |
| **Post-v1 mitigation** | Optional host identity metadata shown on viewer page ("Host shared this session as: [label]") |

---

### T4 — Signaling server abuse (session minting at scale)

| Attribute | Value |
|---|---|
| **Category** | Denial of Service |
| **Actor** | Bot or malicious user hitting `POST /new` at high volume |
| **Attack** | Exhausts DO storage with used-code entries, or generates CPU load on the Worker |
| **Mitigation 1** | Rate limiter: 30 mints per IP per 60 seconds (in-memory; best-effort, resets on hibernation) |
| **Mitigation 2** | Never-reuse guard backed by DO storage (prevents code collision; does not prevent volume) |
| **Mitigation 3** | Cloudflare WAF can enforce rate limits at the edge, independent of DO hibernation |
| **Mitigation 4** | DO storage cost per entry is negligible; 1 million used codes ≈ $0 |
| **Residual risk** | In-memory rate limiter resets on hibernation, allowing brief burst above limit post-wake. Documented in LIMITATIONS.md |
| **Implemented** | ✓ (in-memory); Cloudflare WAF rule is recommended for production |

---

### T5 — DataChannel frame injection

| Attribute | Value |
|---|---|
| **Category** | Tampering |
| **Actor** | Network attacker (MITM) attempting to inject or modify frames |
| **Attack** | Inject malicious `REQUEST_HEAD` frames to cause the host to replay unauthorized requests to localhost |
| **Mitigation** | RTCDataChannels are protected by DTLS-SRTP (RFC 8827). All DataChannel messages are encrypted and authenticated at the transport layer. MITM injection is cryptographically prevented |
| **Residual risk** | None at the transport layer. If the attacker compromises the viewer's browser process (out of scope), they could send arbitrary frames |

---

### T6 — Path traversal / unauthorized localhost access

| Attribute | Value |
|---|---|
| **Category** | Elevation of Privilege |
| **Actor** | Legitimate viewer who tries to access routes not intended to be exposed |
| **Attack** | Viewer issues `fetch('/internal/admin')` when host only exposed `/demo` |
| **Mitigation** | `--allowed-paths` flag: Application-layer `isPathAllowed()` checks every request before localhost replay. Returns HTTP 403 without touching localhost |
| **Default behavior** | Without `--allowed-paths`, all routes are exposed — documented and consented to in the banner |
| **Implemented** | ✓ `src/application/path-authorization.ts` |
| **Note** | `--allowed-paths` is a voluntary restriction. Developers who forget to set it expose everything on the port |

---

### T7 — Resource exhaustion (stream flooding)

| Attribute | Value |
|---|---|
| **Category** | Denial of Service |
| **Actor** | Malicious viewer sending many concurrent requests to exhaust host memory |
| **Attack** | Open 1000 concurrent streams to fill the host's stream buffer |
| **Mitigation 1** | `MAX_CONCURRENT_STREAMS = 256` (mux); excess streams rejected with `stream-cap-exceeded` |
| **Mitigation 2** | `MAX_STREAM_BUFFER_BYTES = 1 MiB` per stream |
| **Mitigation 3** | `MAX_TOTAL_BUFFER_BYTES = 16 MiB` total across all streams |
| **Mitigation 4** | SW-side `MAX_CONCURRENT_STREAMS = 32` in `FetchGate` — viewer cannot open more than 32 concurrent streams regardless |
| **Implemented** | ✓ all limits enforced in `src/application/protocol.ts` and `viewer/src/sw-fetch-gate.ts` |

---

### T8 — Malformed frame injection

| Attribute | Value |
|---|---|
| **Category** | Tampering / DoS |
| **Actor** | Compromised viewer, or an attacker who reached the DataChannel somehow |
| **Attack** | Send a frame with `payloadLength = 0xFFFFFFFF` to cause a massive allocation; or send unknown frame types to crash the decoder |
| **Mitigation 1** | `decodeFrame()` is total: every input maps to a `Frame` or a typed `FrameDecodeError` — never throws |
| **Mitigation 2** | `DECLARED_LENGTH_EXCEEDS_CAP` check prevents allocation from peer-supplied length field |
| **Mitigation 3** | `UNKNOWN_FRAME_TYPE` check rejects unknown type bytes with a typed error |
| **Mitigation 4** | `FRAME_TOO_LARGE` check: frame size must be ≤ `MAX_FRAME_SIZE` |
| **Implemented** | ✓ `src/domain/frame.ts:decodeFrame()` |

---

### T9 — Signaling replay attack (SDP/ICE replay)

| Attribute | Value |
|---|---|
| **Category** | Spoofing |
| **Actor** | Attacker who captured a valid SDP offer + session URL from a previous session |
| **Attack** | Re-opens the viewer WebSocket with the old session code, replays the captured SDP answer |
| **Mitigation 1** | Never-reuse token guard: session codes are marked `used` after minting; a code that has already been used for a full session cannot start a new one |
| **Mitigation 2** | RTCDataChannel's DTLS handshake generates fresh key material for every session; replayed SDP does not reuse the same DTLS context |
| **Mitigation 3** | PIN is required before ICE begins; the PIN hash changes with each new session code |
| **Implemented** | ✓ (code-level); DTLS replay protection is provided by the WebRTC stack |

---

### T10 — Host secrets in request logs

| Attribute | Value |
|---|---|
| **Category** | Information Disclosure |
| **Actor** | Anyone reading the host terminal output |
| **Attack** | Request log entries reveal sensitive path structure or query parameters |
| **Mitigation** | Logs show `method`, `path`, `status`, and latency — never request/response bodies or headers |
| **Implemented** | ✓ `src/infrastructure/request-log-store.ts` |
| **Developer responsibility** | Path-only logs still reveal route structure; developer should use `--allowed-paths` to minimize exposure surface |

---

### T11 — npm package supply chain

| Attribute | Value |
|---|---|
| **Category** | Tampering |
| **Actor** | Attacker who publishes a malicious package named `beam` or similar on npm |
| **Attack** | User runs `npm install -g beam` and gets attacker's binary instead of Beam |
| **Mitigation 1** | Use scoped package name `@beamtunnel/cli` — impossible to squat a scoped package under a different org |
| **Mitigation 2** | `"private": true` must be removed and replaced with `"publishConfig": { "access": "public" }` before first publish; two-factor authentication required on npm org |
| **Mitigation 3** | Do not use the bare name `beam` (occupied by an unrelated package) |
| **Implemented** | Partially — scoped name recommended but package not yet published |

---

## 3. Security Invariants (from CLAUDE.md — enforced at commit)

These are non-negotiable and mechanically verified by the pre-commit gate:

| Invariant | Verification |
|---|---|
| Secrets/keys never written to disk | `git secrets` scan in gate.sh |
| `.env` never committed | `.gitignore` + pre-commit diff scan |
| Raw exceptions never returned to clients | Application-layer error wrapping |
| User input never interpolated into queries | Parameterised only; ESLint rule |
| Secrets never in logs | Log store only records method/path/status |
| Env access only through `src/config.ts` | ESLint `no-process-env` equivalent rule |
| HTTP payloads never stored on Cloudflare | Signaling layer design constraint; DO schema confirms |

---

## 4. What Beam Does Not Protect Against

These are out-of-scope for v1 and documented explicitly:

| Attack | Why out of scope |
|---|---|
| Compromised developer machine | If localhost is already compromised, Beam is irrelevant |
| Attacker who received both URL + PIN from the developer | Social engineering; no technical countermeasure for willful sharing |
| Browser zero-days in viewer's Chrome | Out of Beam's control |
| Network-level interception between viewer and host DataChannel | WebRTC DTLS-SRTP handles this; key compromise of WebRTC stack is Chromium's responsibility |
| Content-level attacks (XSS in the hosted app) | Beam relays whatever localhost returns; developers are responsible for their own app security |
| Long-term persistent access | Session TTL and single-use codes are by design; no "permanent beam link" feature |

---

## 5. Abuse Scenarios & Infrastructure Protection

### Scenario A: Beam used as an anonymous web proxy

**Attack:** Attacker runs `beam 3000` where localhost:3000 is a Tor-to-clearnet bridge or proxy service.

**Controls:**
- Session TTL ≤ 4 hours — no persistent proxy
- Per-IP mint rate limit prevents rapid re-session to appear persistent
- Cloudflare Terms of Service prohibit this use; Cloudflare's network-layer detection applies

### Scenario B: Beam used to stream video

**Attack:** Developer (or attacker) tries to use Beam to stream video content to a viewer.

**Controls:**
- `MAX_PAYLOAD_SIZE` (16 KiB or 256 KiB) + backpressure high-water mark makes sustained high-throughput inefficient
- 32-stream SW cap limits parallel segment downloads typical of video streaming
- No `Content-Type` filtering (not implemented) — developer responsibility to scope paths

### Scenario C: Beam used for sustained cryptocurrency mining (drive-by)

**Attack:** Beam used to deliver a crypto miner JavaScript payload to the viewer's browser.

**Controls:**
- Beam doesn't host content — it tunnels from the developer's localhost
- A developer who does this is violating the Acceptable Use Policy
- Cloudflare's content scanning applies to Pages assets (not tunnel traffic)

---

## 6. Recommended Production Hardening (post-v1)

| Control | Effort | Impact |
|---|---|---|
| Cloudflare WAF rate rule (30 req/min/IP on `/new`) | Low | Removes in-memory limiter dependence |
| Cloudflare Bot Management on signaling Worker | Medium | Blocks automated session minting bots |
| TURN credentials as short-lived HMAC tokens | Medium | Prevents TURN relay abuse if credentials leak |
| Abuse email (`abuse@beamtunnel.dev`) | Low | Legal and community trust signal |
| Acceptable Use Policy (public) | Low | Legal cover; deterrent |
| CSP headers on viewer page | Low | Reduces XSS attack surface from tunneled content |
| Subresource Integrity on viewer JS bundle | Low | Detects CDN-level tampering |
