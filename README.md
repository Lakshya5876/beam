# Beam

Expose your localhost server to a remote browser peer over a direct WebRTC data channel — no cloud relay, no server costs, no account required.

## How to use?

```bash
npm install -g beam-tunnel   # one-time
```

```bash
bm
```

Enter the local URL you want to expose (e.g. `http://localhost:3000`) when prompted, then share the printed viewer URL and session code with your viewer.

The viewer opens the URL in a Chromium-based browser (Chrome, Edge — see Platform support below), enters the 6-digit code, and from that point every HTTP request they make is forwarded — peer-to-peer — to your local server and back, on their own machine, as if they were on yours.

---

## How it works

```
Browser (viewer)
  │  RTCDataChannel (WebRTC, direct P2P)
  ▼
bm CLI (host)
  │  http.request to 127.0.0.1:<port>
  ▼
Your local server
```

1. `bm` connects to the signaling server, mints a session code, and prints the viewer URL.
2. The viewer opens the URL, enters the code. The DO verifies the PIN (SHA-256 hash comparison) and relays the WebRTC offer/answer.
3. ICE negotiation completes; a direct DataChannel opens — no relay traffic touches the signaling server after this point.
4. The viewer shell embeds your app in an iframe and points it at your app's real root page. A service worker intercepts every fetch the iframe (or your app's own JS) makes, serialises it into Beam frames, sends it over the DataChannel, replays it to `127.0.0.1`, and streams the response back — so full page navigations inside your app work normally, without ever tearing down the tunnel.
5. `new WebSocket(...)` calls in your app are relayed too: an injected script replaces `WebSocket` inside the iframe (a service worker cannot intercept the WebSocket constructor the way it intercepts `fetch()`), routing frames over the same DataChannel to a real WebSocket the host dials against your local server.

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full design walkthrough.

---

## Platform support

**Host: Windows only, for now.** Beam has not been built, tested, or verified
on macOS or Linux in this release — treat those as unsupported rather than
assumed-working, even though nothing in the architecture is Windows-specific
by design.

**Viewer: Chromium-based browsers only** (Chrome, Edge, and other
Chromium-family browsers, on any OS). Confirmed working end-to-end on real
hardware across a real cross-device, cross-network connection: Windows host →
Android Chrome viewer on mobile data. Automated coverage (`e2e-app-compat.mjs`)
additionally verifies the full request/response surface on Chrome and Edge on
Windows.

**Does not currently work: WebKit-based browsers** — this means Safari on any
platform, and **every** browser on iOS/iPadOS (Apple requires all iOS browsers,
including Chrome and Firefox for iOS, to use WebKit underneath). Confirmed via
a real device test: the WebRTC connection itself succeeds
(`DataChannel OPEN`), but the page never loads — WebKit has a known gap in
Service-Worker interception of iframe navigation, which the viewer's
architecture depends on. This is a real, verified limitation, not a guess;
see LIMITATIONS.md for the mechanism.

Firefox has not been tested in this release.

---

## Installation

```bash
npm install -g beam-tunnel     # requires Node >= 22 — one-time
```

That's it. `bm` is now on your PATH — every time after this, just run `bm`
(see [Options](#options) below). There's no reinstalling, no re-cloning, nothing
else to set up for day-to-day use.

> **Don't use `npx beam-tunnel`.** On Windows it fails immediately with
> `'bm' is not recognized as an internal or external command` — a confirmed,
> root-caused `npx`-on-Windows issue, not a Beam bug (see
> [LIMITATIONS.md](LIMITATIONS.md)). `npm install -g` is also the better fit
> for a tool you'll run more than once: `npx` re-downloads the package on
> every single invocation.

**Updating** to a newer release: run `npm install -g beam-tunnel` again.

**Building from source** is only needed if you're contributing to Beam
itself, not to use it — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Options

Run `bm` with no arguments and it asks for your local server address
interactively — nothing to remember, nothing to look up:

```
bm
  Enter local URL (e.g. http://localhost:3000): 3000
```

The prompt accepts any of `3000`, `localhost:3000`, or `http://localhost:3000`.
For scripting or repeat use, the same value can be passed directly as an
argument instead, skipping the prompt: `bm 3000`.

```
bm [<local-url>] [options]

Arguments:
  <local-url>   Local server address (optional — prompted for if omitted).
                Accepts any of:
                  3000                    → http://localhost:3000
                  localhost:3000          → http://localhost:3000
                  http://localhost:3000   → as-is

Options:
  --allowed-paths /a,/b    Restrict which URL paths the viewer may request.
                           An empty value (the default) exposes every route.
  --ttl <seconds>          Session lifetime in seconds (default: 4 hours,
                           which is also the maximum — --ttl can only set
                           it lower, never higher).
  --signaling <url>        Override the signaling server URL.
  --viewer <url>           Override the viewer base URL.
  --ice <urls>             Comma-separated ICE servers for the host peer,
                           e.g. stun:host:port or turn:user:pass@host:port.
                           Overrides BEAM_ICE_SERVERS and the compiled default.
  --ipv4-only              Drop IPv6 ICE candidates on both the host AND the
                           viewer (the CLI appends `&ipv4=1` to the printed
                           viewer URL so the browser side filters too). Use
                           if connections are slow to establish or fail
                           outright on a dual-stack network — an IPv6
                           candidate pair was seen stalling nomination for
                           ~10s before an IPv4 pair won anyway; symptom:
                           --debug shows `iceState=checking` for many seconds
                           before `connected`. Does not help with symmetric
                           NAT (see LIMITATIONS.md) — that needs TURN, not
                           address-family filtering.
  --debug                  Print a timestamped connection timeline (signaling,
                           ICE candidates, DTLS/DataChannel state, relay/
                           direct path) to stderr.
```

Every network endpoint above can also be set via environment variable —
`BEAM_SIGNALING_URL`, `BEAM_VIEWER_URL`, `BEAM_ICE_SERVERS` — with the CLI
flag taking precedence. See [docs/deploy/ENVIRONMENT.md](docs/deploy/ENVIRONMENT.md)
for the full configuration reference, including the deep-diagnosis
`BEAM_NATIVE_LOG` knob.

### Examples

```bash
# Expose port 3000, unrestricted
bm 3000

# Expose only the /api subtree
bm 3000 --allowed-paths /api

# Expose multiple paths
bm http://localhost:8080 --allowed-paths /api,/assets,/health

# Session expires after 1 hour
bm 3000 --ttl 3600

# Use a self-hosted signaling server
bm 3000 --signaling wss://my-signal.example.com --viewer https://my-viewer.example.com

# Diagnose a slow or failing connection
bm 3000 --debug

# Force IPv4-only ICE (mitigates dual-stack connect stalls)
bm 3000 --ipv4-only
```

---

## Security model

- **Authentication**: every session requires a 6-digit PIN. The host generates it locally (CSPRNG); only its SHA-256 hash is registered with the signaling server. A brute-force attempt against a 6-digit PIN succeeds with probability < 0.003 % on the first try.
- **No signaling before verification**: the signaling Durable Object relays nothing — in either direction — until the PIN is verified. Holding the link alone is not enough to see or inject any WebRTC signaling. An unverified second connection to a session (someone who has the link but not the PIN) is evicted automatically after 2 minutes so it cannot permanently occupy the session and lock out the real viewer.
- **No silent reconnection**: if either side's connection to the signaling server drops before the WebRTC handshake completes, that pairing is invalidated — whoever reconnects, including the real host, must re-register/re-enter the PIN before any further signaling is relayed. This closes off a "reconnect as the old peer" hijack window; the trade-off is that a genuine network blip mid-handshake means restarting `bm` rather than silently resuming. Once the peer-to-peer data channel is actually open, this no longer applies — the signaling server is out of the picture entirely at that point.
- **Path restriction**: use `--allowed-paths` to limit exposure — it also gates WebSocket connections, not just HTTP. Without it, every route on the target port is reachable by anyone who holds the link and code.
- **No relay after connection**: once the WebRTC data channel is open, no traffic transits the signaling server. Cloudflare Workers cannot read your data.
- **Loopback confinement**: the host always connects to `127.0.0.1:<port>`, for both HTTP and WebSocket relay. Viewer-supplied headers cannot redirect requests to other hosts or ports.
- **Injection guards**: CR/LF in method, path, or any header value is rejected before any socket write. Path traversal segments (`..`, `%2e%2e`) are blocked.

See [SECURITY.md](SECURITY.md) for the full threat model and known limitations.

---

## Limitations

- **TURN relay must be configured per deployment** — Beam prefers a direct peer-to-peer path and falls back to a TURN relay automatically when ICE cannot find one (symmetric NAT, CGNAT). The fallback only exists if the deployment supplies TURN credentials; without them the deployment is STUN-only and still fails on those networks. Setup is in `docs/deploy/CLOUDFLARE_SETUP.md`. Verified against a live Metered account: `path=direct` on a normal network, `path=relay` when forced through the relay (real HTTP request relayed through it), and a deterministic failure when neither is available — see LIMITATIONS.md.
- **WebSocket relay has caveats** — supported (HMR, chat, realtime apps all work), but the browser's `WebSocket` API doesn't expose cookies as headers, so the loopback WS handshake doesn't carry the browser's cookies. Apps that gate a WS connection on cookie session auth won't authenticate over the relay.
- **HTML shim injection is skipped for compressed responses** — a `Content-Encoding: gzip/br/deflate` HTML response is relayed byte-for-byte unmodified (correctly), but without the WebSocket shim, so `new WebSocket()` calls on that page won't be relayed.
- **Windows-only host, Chromium-only viewer, for now** — see "Platform support" above for exactly what is and isn't verified, including the WebKit/iOS gap found via real device testing.

See [LIMITATIONS.md](LIMITATIONS.md) for full details.

---

## Local development

```bash
npm ci
npx vitest run          # ~1s (run in signaling/ and viewer/ too — 3 independent packages)
npm run lint            # eslint
npm run typecheck       # tsc --noEmit
npm run build           # dist/ for publishing
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [DEPLOY.md](DEPLOY.md) for the full workflow.
