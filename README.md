# Beam

Expose your localhost server to a remote browser peer over a direct WebRTC data channel — no cloud relay, no server costs, no account required.

```
npm install -g @beamtunnel/cli

bm 3000
# or
bm http://localhost:3000

  Viewer URL:   https://beam-viewer.pages.dev/?signaling=...
  Session code: 482 913

  Share both with your viewer. Press Ctrl-C to end the session.
```

The viewer opens the URL in Chrome, enters the 6-digit code, and from that point every HTTP request they make is forwarded — peer-to-peer — to your local server and back.

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
4. Every browser fetch goes through a service worker, serialised into Beam frames, sent over the DataChannel, replayed to `127.0.0.1`, and the response streamed back.

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full design walkthrough.

---

## Installation

```bash
npm install -g @beamtunnel/cli     # requires Node >= 22

# From source
git clone https://github.com/beamtunnel/beam
cd beam && npm ci && npm run build
```

> **Verify the npm package name** — confirm `@beamtunnel/cli` is unclaimed before publishing.

---

## Usage

```
bm [<local-url>] [options]

Arguments:
  <local-url>   Local server address. Accepts any of:
                  3000                    → http://localhost:3000
                  localhost:3000          → http://localhost:3000
                  http://localhost:3000   → as-is

Options:
  --allowed-paths /a,/b    Restrict which URL paths the viewer may request.
                           An empty value (the default) exposes every route.
  --ttl <seconds>          Session lifetime in seconds (default: no expiry).
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
- **Path restriction**: use `--allowed-paths` to limit exposure. Without it, every route on the target port is reachable by anyone who holds the link and code.
- **No relay after connection**: once the WebRTC data channel is open, no traffic transits the signaling server. Cloudflare Workers cannot read your data.
- **Loopback confinement**: the host always connects to `127.0.0.1:<port>`. Viewer-supplied headers cannot redirect requests to other hosts or ports.
- **Injection guards**: CR/LF in method, path, or any header value is rejected before any socket write. Path traversal segments (`..`, `%2e%2e`) are blocked.

See [SECURITY.md](SECURITY.md) for the full threat model and known limitations.

---

## Limitations

- **SPA / client-side routing only** — top-level navigations reload the page and drop the connection. Server-side rendered apps with full page navigations are not supported in v1.
- **No TURN relay** — ~10–15 % failure rate on symmetric NAT (corporate networks, some mobile carriers).
- **No WebSocket proxying** — WebSocket upgrade requests are not intercepted.
- **Chrome recommended** — the viewer service worker is tested in Chrome. Firefox and Safari have known SW + WebRTC compatibility gaps.

See [LIMITATIONS.md](LIMITATIONS.md) for full details.

---

## Local development

```bash
npm ci
npx vitest run          # 238 tests, ~1s
npm run lint            # eslint
npm run typecheck       # tsc --noEmit
npm run build           # dist/ for publishing
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [DEPLOY.md](DEPLOY.md) for the full workflow.
