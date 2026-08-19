# Beam — Architecture

## Overview

Beam proxies HTTP requests from a remote browser to a local development server using a WebRTC DataChannel as the transport. The signaling server (a Cloudflare Durable Object) is used only to establish the peer connection; it carries no application data.

```
┌──────────────────────────────────────────────────────┐
│                   Viewer (Chrome)                    │
│  ┌─────────────────────────────────────────────────┐ │
│  │            Service Worker (/__beam/sw.js)       │ │
│  │  intercepts fetch() → serialises → DataChannel  │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────┬───────────────────────────┘
                           │ WebRTC DataChannel (DTLS)
                           │ (direct P2P after ICE)
┌──────────────────────────┴───────────────────────────┐
│                 bm CLI (Node >= 22)                  │
│  ┌─────────────────────────────────────────────────┐ │
│  │           StreamMultiplexer (protocol.ts)       │ │
│  │  demux frames → ExecuteRelayUseCase             │ │
│  └──────────────────────────┬──────────────────────┘ │
│                             │ http.request()          │
│                             ▼                         │
│                     127.0.0.1:<port>                  │
└──────────────────────────────────────────────────────┘
          │ WebSocket (wss://)         │ WebSocket (wss://)
          ▼                           ▼
┌─────────────────────────────────────────────────────┐
│        Cloudflare Durable Object (signaling)        │
│  Assigns roles, verifies PIN, relays SDP/ICE only   │
└─────────────────────────────────────────────────────┘
```

## Layer map (Clean Architecture)

```
src/domain/           Pure business logic — no I/O, no framework
  frame.ts            Wire format: encode/decode, StreamId, FrameType
  session.ts          Session state machine (idle → active → closed)
  interfaces.ts       Repository + transport interfaces (seams)

src/application/      Use-case orchestration
  relay-use-case.ts   REQUEST_* → http.request() → RESPONSE_* frames
  session-use-case.ts Session lifecycle (start / establish / close)
  protocol.ts         StreamMultiplexer: demux, backpressure, limits
  path-authorization.ts  --allowed-paths enforcement
  diagnostics-use-case.ts  Request log query

src/infrastructure/   All I/O — implements domain interfaces
  peer-connection.ts  WebRTC DataChannel (node-datachannel)
  signaling-client.ts WebSocket signaling (node-datachannel WebSocket)
  replay-client.ts    Loopback HTTP relay (node:http)
  mdns-resolve.ts     ICE candidate mDNS resolution (dns-sd / UDP)
  request-log-store.ts  In-memory request log (ring buffer)

src/presentation/     CLI + diagnostics surface
  cli.ts              Arg parsing, prompts, session start, PIN
  diagnostics-view.ts Request log rendering

src/composition.ts    Composition root — only file that binds concretions
src/config.ts         Single source of truth for env / process.env access
```

Dependency direction: `Presentation → Application → Domain ← Infrastructure`

The domain layer has **zero** external dependencies. Infrastructure depends on domain interfaces, never on application logic. The composition root is the only file that imports concrete infrastructure alongside application use-cases.

## Frame protocol

Every HTTP round-trip is serialised into typed frames sent over the DataChannel.

```
┌──────────┬───────────────┬────────────────┬─────────────────────┐
│ type (1) │ streamId (4)  │ payloadLen (4) │    payload (N)      │
│ uint8    │ uint32 BE     │ uint32 BE      │ ≤ 16375 bytes       │
└──────────┴───────────────┴────────────────┴─────────────────────┘
Total header: 9 bytes. Max frame: 16384 bytes (SCTP ceiling).
```

Frame types:
| Value | Name | Direction | Payload |
|-------|------|-----------|---------|
| 1 | REQUEST_HEAD | Viewer → Host | JSON: `{method, path, headers}` |
| 2 | REQUEST_BODY_CHUNK | Viewer → Host | Raw bytes |
| 3 | REQUEST_END | Viewer → Host | Empty |
| 4 | RESPONSE_HEAD | Host → Viewer | JSON: `{status, headers}` |
| 5 | RESPONSE_BODY_CHUNK | Host → Viewer | Raw bytes |
| 6 | RESPONSE_END | Host → Viewer | Empty |
| 7 | ERROR | Either | UTF-8 reason string |
| 8 | PING | Either | Empty |
| 9 | PONG | Either | Empty |
| 10 | WS_CONNECT | Viewer → Host | JSON: `{path, protocols}` |
| 11 | WS_ACCEPT | Host → Viewer | JSON: `{protocol}` |
| 12 | WS_REJECT | Host → Viewer | UTF-8 reason string |
| 13 | WS_MESSAGE_HEAD | Either | 1 byte: isBinary flag |
| 14 | WS_MESSAGE_CHUNK | Either | Raw bytes |
| 15 | WS_MESSAGE_END | Either | Empty |
| 16 | WS_CLOSE | Either | JSON: `{code, reason}` |

Multiple request/response streams are multiplexed on a single DataChannel using `streamId`. The decoder validates the declared payload length against actual bytes before touching the payload — no allocation from peer-supplied values.

A WS connection gets its own stream id from the same id space, framed with a
HEAD/CHUNK*/END triad per message (mirroring REQUEST_*/RESPONSE_*) so message
boundaries survive `MAX_PAYLOAD_SIZE` chunking. `WS_MESSAGE_END` completes one
message but does not close the stream — only `WS_CLOSE` does (see "Multiplexer
and backpressure" below for how per-message buffer accounting keeps a
long-lived WS connection from tripping the buffer caps on cumulative traffic).

The response side streams progressively: the host relays `RESPONSE_HEAD` and
each `RESPONSE_BODY_CHUNK` to the viewer as bytes arrive from the local
server, rather than buffering the full response first. This is required for
SSE and other long-lived responses (which never truly "end" until the app
closes them) and keeps host memory bounded for large downloads.

## Connection setup sequence

```
Host                    Signaling DO              Viewer
 │                           │                      │
 │── POST /new ──────────────▶                      │
 │◀─ { code } ───────────────│                      │
 │── WS /<code> ─────────────▶                      │
 │   (role: host)             │                      │
 │                            │◀── WS /<code> ───────│
 │                            │    (role: viewer)     │
 │── pin-register(hash) ──────▶                      │
 │   [DO holds hash]          │                      │
 │── offer SDP ──────────────▶                      │
 │   [DO buffers, pre-PIN]    │                      │
 │                            │◀── pin-verify(hash) ──│
 │                            │    [DO checks hash]   │
 │                            │── pin-ok ────────────▶│
 │◀─ pin-ok ──────────────────│                      │
 │                            │── offer SDP ─────────▶│
 │◀─ ICE candidates ──────────│──────────────────────▶│
 │── ICE candidates ──────────▶──────────────────────▶│
 │                            │                      │
 │◀════════════ WebRTC DataChannel (direct P2P) ═════▶│
 │                            │   (signaling idle)    │
```

## Multiplexer and backpressure

`StreamMultiplexer` (application layer) enforces:
- Max 256 concurrent streams
- Max 1 MiB per-stream buffer
- Max 16 MiB total buffer

Per-stream buffer accounting is released when the stream's inbound half
closes — for HTTP that's once, at `REQUEST_END`. A WS connection instead
releases it after every `WS_MESSAGE_END`, so the 1 MiB cap bounds any ONE
message rather than the connection's lifetime traffic; without this a
healthy, long-lived WS connection would eventually trip the cap purely from
cumulative small messages.

When the total buffer crosses the high-water mark (1 MiB), the multiplexer pauses the DataChannel read loop. When it drains below the low-water mark (256 KiB), it resumes. This prevents unbounded memory growth under load.

**A separate, lower cap applies on the viewer side first**: the service
worker's fetch gate (`viewer/src/sw-fetch-gate.ts`, `MAX_CONCURRENT_STREAMS`)
allows only 32 concurrent in-flight browser `fetch()`/navigation requests
before returning 504 (`stream-cap-exceeded`) — independent of, and much lower
than, the mux's 256-stream cap. A page issuing more than 32 simultaneous
requests will see 504s well before the host-side cap is ever reached. Raising
one without the other has no effect; both are compile-time constants, not
configuration, in v1.

## mDNS resolution

Chrome hides local IPs in ICE candidates behind ephemeral mDNS hostnames (`UUID.local`) since Chrome 75. `node-datachannel` (libdatachannel / libjuice) does not resolve `.local` names natively.

`mdns-resolve.ts` implements three resolution strategies attempted in order:

1. **macOS `dns-sd -G v4`** — invokes the Bonjour daemon directly; sees Chrome's ephemeral records reliably.
2. **Raw UDP multicast** — sends a DNS A-query to `224.0.0.251:5353` with the unicast-response bit set; joins the multicast group to receive responses even when the responder doesn't honour unicast-response.
3. **OS `dns.lookup()` with retries** — last resort; may work after the mDNS record propagates to getaddrinfo.

If all strategies fail, the candidate is skipped. The SRFLX candidate (from STUN) is still attempted and may succeed on networks with hairpin NAT.

**Local testing workaround**: disable `chrome://flags/#enable-webrtc-hide-local-ips-with-mdns` in Chrome to include real local IPs in candidates. This is a local-testing-only change; do not advise users to disable it.

## Service worker design

The viewer's service worker (`viewer/src/sw.ts`) intercepts `fetch()` calls on its scope, EXCEPT the OUTER shell's own shell/bundle on a genuine top-level document navigation (`shouldBypassRelay` in `sw-fetch-gate.ts`: `/`, `/assets/*`, `/__beam/*`) — those bypass to the network so the viewer app itself keeps working on reload. Critically, `shouldBypassRelay` never bypasses a request whose `destination === 'iframe'` — the tunneled-app iframe's OWN navigation to `/` is relayed, not treated as the viewer shell's root, even though the path is identical (see "iframe-shell architecture" below). For every other intercepted request it:

1. Materialises the request body into a `Uint8Array` (v1 limitation: no streaming upload).
2. Encodes REQUEST_HEAD + optional REQUEST_BODY_CHUNK(s) + REQUEST_END frames.
3. Sends them over the DataChannel with backpressure (pauses if `bufferedAmount` is high).
4. Waits for RESPONSE_HEAD then streams RESPONSE_BODY_CHUNK frames into a `ReadableStream`.
5. Resolves the fetch with a synthetic `Response` from that stream.

The SW lives at `/__beam/sw.js` and registers with scope `'/'`. It requires the `Service-Worker-Allowed: /` response header to be set by the server serving `sw.js`.

## iframe-shell architecture

The outer document (where the SW is registered and the RTCPeerConnection
lives) never itself navigates to the tunneled app. Once the DataChannel opens,
`bootstrap.ts` replaces its content with a single full-viewport `<iframe>` and
sets its `src` to `/` — the SW relays that request (per the
`destination === 'iframe'` exception above) to the tunneled app's real root
page. Because the iframe is a separate browsing context, any further
navigation inside it — client-side routed or a genuine server-rendered page
load — unloads only the iframe's document, never the outer one holding the
connection. This is what makes multi-page (not just SPA) tunneled apps work.

## WebSocket relay

A service worker can intercept `fetch()` but has no equivalent hook for
`new WebSocket()`. Instead, every relayed `text/html` response gets a
`<script type="module" src="/__beam/ws-shim.js">` tag injected right after
its opening `<html>` (or `<head>` if there's no `<html>` tag) —
`src/application/html-injection.ts` finds the insertion point byte-by-byte in
a bounded lookahead as the response streams through, so it works without
buffering the whole document, and never touches a compressed
(`Content-Encoding`) response since injecting into compressed bytes would
corrupt them.

The shim (`viewer/src/ws-shim.ts`) replaces `window.WebSocket` inside the
iframe with a lookalike implementing the standard event/property surface
(`readyState`, `onopen`/`onmessage`/`onclose`/`onerror`, `addEventListener`,
`send()`, `close()`). It reaches the outer document directly via
`window.parent.__beamWsBridge` (same-origin, no postMessage needed) —
`viewer/src/ws-bridge.ts` is the outer-side counterpart, opening a stream on
the SAME `StreamMultiplexer` used for HTTP relay. The host side
(`src/application/ws-relay-use-case.ts`, `src/infrastructure/ws-relay-client.ts`)
dials a real WebSocket to `127.0.0.1:<port>` using Node's built-in WebSocket
client (no new dependency) with the same loopback-confinement and path-
validation guards as the HTTP relay path.

## Self-hosted deployment

See [DEPLOY.md](DEPLOY.md) for step-by-step instructions to deploy the signaling Durable Object and viewer Pages to your own Cloudflare account.
