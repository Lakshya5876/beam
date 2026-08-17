# Beam — Security Model

## Threat model

Beam exposes a local HTTP server to an authenticated remote browser peer. The assumed adversary is:

- **Network attacker (passive)**: can observe signaling WebSocket traffic and ICE candidates.
- **Signaling server compromise**: the DO is fully compromised but cannot read data-channel traffic.
- **Malicious viewer**: a peer who obtained a valid link and code and is actively trying to exploit the host.
- **Out of scope**: a compromised host machine; OS-level privilege escalation; WebRTC stack vulnerabilities in libdatachannel/libjuice.

---

## Authentication

### PIN

Every session requires a 6-digit PIN generated locally with Node.js `crypto.randomInt` (CSPRNG). Only a SHA-256 HMAC of `<pin>:<sessionCode>` is sent to the signaling server; the raw PIN never leaves the host.

The viewer submits its guess through the same signaling channel. Three incorrect attempts lock the session.

| Attack | Resistance |
|--------|-----------|
| Online brute-force (single attempt) | < 0.001 % success probability |
| Online brute-force (all 3 attempts) | < 0.003 % success probability |
| Offline hash cracking | SHA-256 of 6 digits + 26-char nonce: 10^6 × salted, fast but brute-forceable if hash is leaked. **The hash must not be logged.** |

The hash is never written to disk, logged, or returned in error messages.

**No signaling relayed before verification, in either direction.** The
Durable Object holds back ALL SDP/ICE traffic — not just the host's offer —
until the PIN is verified; an unverified connection cannot see or inject any
WebRTC signaling. The "viewer" role slot itself is claimed the instant a
second WebSocket connects (before any PIN check), so an attacker who has only
the shareable link — no PIN — could otherwise occupy that sole slot
indefinitely and permanently deny the real viewer (assignRole rejects a third
connection as session-full). Two mitigations close this: the relay gate above
means squatting the slot gains nothing, and a DO alarm evicts an unverified
viewer socket after 2 minutes, bounding how long the denial-of-service can
last. Verified live: an attacker holding the slot with no PIN attempt
receives zero signaling messages, a genuine second viewer is rejected while
the attacker squats, and the slot frees automatically ~2 minutes later.

### Session code

The session code is a 26-character alphanumeric string minted by the signaling Durable Object. It serves as a session identifier, not an authenticator — the PIN is the authenticator.

---

## Transport security

| Leg | Mechanism |
|-----|-----------|
| Host → Signaling DO | WebSocket over TLS (wss://) |
| Viewer → Signaling DO | WebSocket over TLS (wss://) |
| Host ↔ Viewer (data) | DTLS-SRTP over WebRTC DataChannel (post-ICE, direct P2P) |
| Host → Local server | Plain HTTP to 127.0.0.1 (loopback only) |

After the DataChannel is established, **zero relay traffic** passes through the signaling server. Cloudflare cannot read data-channel content.

---

## Request validation

### Loopback confinement (SSRF prevention)

`LoopbackReplayClient` hardcodes the connection target:

```typescript
const LOOPBACK_HOST = '127.0.0.1';  // compile-time constant
// host and port in http.request() are never sourced from viewer input
```

No viewer-supplied value (header, path, method, body) can redirect requests to another IP, hostname, or port. Connections to cloud metadata endpoints (`169.254.169.254`), private ranges (`10.x`, `192.168.x`, `172.16.x`), or other loopback services on different ports are structurally impossible.

**Note**: requests *do* reach `127.0.0.1:<port>`. If your local server serves sensitive admin endpoints, use `--allowed-paths` to restrict exposure.

### Path traversal

Paths containing `..` segments, percent-encoded double-dots (`%2e%2e`, `.%2e`, `%2e.`), or encoded slashes (`%2f`) are rejected before any socket write. This prevents a viewer from using traversal sequences to reach paths above an intended root when the local server serves static files.

Legitimate paths containing literal dots in filenames (e.g., `/api/v1/data.csv`) are unaffected.

### Header injection (request smuggling)

CR (`\r`) or LF (`\n`) in any method, path, header name, or header value is rejected before send. This prevents HTTP/1.1 request-splitting attacks regardless of what the local server does with the input.

Viewer-supplied `host` and `content-length` headers are always discarded and replaced by the loopback values.

### Oversized payloads

| Limit | Value | Enforcement |
|-------|-------|-------------|
| Single frame | 16 384 bytes (SCTP ceiling) | Decoder rejects before payload is touched |
| Request body | 16 MiB | Multiplexer accumulates; relay use-case rejects on exceed |
| Concurrent streams | 256 | Multiplexer tracks open streams; excess yields ERROR frame |
| Total buffer | 16 MiB | Multiplexer triggers backpressure (pause / drain cycle) |
| Single WS message | 1 MiB (per-stream buffer cap) | Same multiplexer cap, released after each message (not held for the connection's lifetime) so a long-lived WS connection can't accumulate unbounded buffered-byte accounting across many small messages while still bounding any one message |

WebSocket relay reuses the same loopback confinement as HTTP relay (host
always connects to `127.0.0.1:<port>`; the path is validated for control
characters and traversal patterns with the identical guards before any socket
opens) and honors `--allowed-paths` the same way.

---

## Known issues

### Signaling rate limiter resets on DO hibernation

The per-IP session-mint rate limiter is held in Durable Object in-memory state. Cloudflare's hibernation API discards in-memory state between WebSocket events, so the limiter resets on idle. Best-effort spam protection only.

**Mitigation**: Apply authoritative rate controls at Cloudflare WAF or Access layer in production.

### PIN window before lock

The three-attempt lock window is enforced in the Durable Object. A race window exists where a fast attacker submits multiple guesses before the first lock propagates, depending on Cloudflare DO scheduling. In practice the window is sub-millisecond.

### No forward secrecy for signaling WebSocket

Signaling messages are protected by TLS, which provides forward secrecy via ephemeral key exchange when the server negotiates ECDHE. This is not under Beam's control.

### Default `--allowed-paths` exposes all routes

Without `--allowed-paths`, every HTTP route on the target port is reachable by any viewer holding the link and code. Run `bm 3000 --allowed-paths /api` to restrict exposure.

### Path traversal in query parameters not normalised

The traversal check covers the path segment (before `?`) and the query string for encoded-slash patterns (`%2f`). Query parameter values are passed through verbatim; if your local server interprets `?file=../../secret` as a filesystem path, that is your server's responsibility.

---

## Reporting vulnerabilities

Open a GitHub issue marked **[SECURITY]**, or email the maintainer directly. Please do not publish proof-of-concept exploits before a fix is available.
