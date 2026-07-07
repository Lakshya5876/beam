# Beam v1 — Known Limitations

## SPA / single-document apps only

Beam v1 supports single-document and client-side-routed (SPA) applications — those
that route via `history.pushState` and issue no top-level (server-side) navigations
after the initial page load (Vite dev server, React Router, Vue Router, etc.).

**Server-rendered multi-page apps are not supported.** The RTCPeerConnection and
multiplexer live in the viewer page. A tunneled top-level navigation unloads that
document, destroying the peer connection mid-flight. The new document has no
connection to serve itself from — a deadlock, not a recoverable error.

The iframe-shell architecture (outer shell holds the connection; inner frame
navigates freely) resolves this and is planned for a post-v1 release.

## No TURN relay (~10–15% failure rate on symmetric NAT)

Beam uses direct peer-to-peer ICE without a TURN relay server. Connections fail on
symmetric NAT topologies, which affect an estimated 10–15% of networks (corporate
firewalls, some mobile carriers). Desktop-only; mobile network NAT behavior varies.

`--ipv4-only` (both host and viewer — see README) mitigates a *different*
failure mode: slow or failed nomination on dual-stack networks racing IPv6
against IPv4 candidate pairs. It does not help symmetric NAT; that failure
looks identical (`iceState` never leaves `checking`/`disconnected`) but has
no address-family workaround — only TURN fixes it, and TURN is out of scope
for v1 (see `signaling/src/ice-config.ts` for the config surface a future
TURN integration would use). `BEAM_ICE_SERVERS`/`--ice` already accepts
`turn:` URLs if you have your own TURN server; Beam does not provision one.

## Reloading the viewer tab always starts a fresh connection

The service worker excludes the viewer's own shell (`/`), its bundle
(`/assets/*`), and `/__beam/*` from relay (`sw-fetch-gate.ts` `shouldBypassRelay`)
so that a page reload can always re-fetch and re-run the bootstrap script,
rather than hanging while the SW tries to relay the viewer's own JS through a
peer connection that no longer exists post-unload. A reload always re-runs
the PIN gate on the *same* session (the signaling URL + code are in the query
string) — it does not resume the in-page connection state, since the
RTCPeerConnection and multiplexer are destroyed on unload (see "SPA /
single-document apps only" above).

**Reserved paths**: if the tunneled target itself serves `/assets/*`, that
prefix is shadowed by the viewer's own bundle instead of being relayed —
a collision, not a crash. Avoid exposing a top-level `/assets/` route on the
tunneled server, or accept the shadowing in v1.

## No WebSocket proxying

Beam relays HTTP/1.1 request-response cycles over the WebRTC data channel. WebSocket
upgrade requests (`Upgrade: websocket`) are not intercepted by the service worker and
will fail or fall through to the network. Apps that depend on WebSocket connections
to the proxied origin are not supported in v1.

## Large request bodies buffered in browser memory

The service worker fully materializes request bodies (file uploads, large POST payloads)
into a `Uint8Array` in browser memory before sending the first relay frame. There is no
request-side streaming or backpressure in v1. The response side does stream via
`ReadableStream` (S4.1 backpressure). Large uploads will temporarily hold the full body
in the viewer tab's memory.

## Per-IP mint rate limiter resets on hibernation

The signaling Durable Object's per-IP session-code mint rate limiter is held in memory.
Cloudflare's hibernation API discards in-memory instance state between WebSocket events,
so the rate limiter resets each time the DO hibernates. This provides best-effort spam
protection only; authoritative rate controls should be applied at the Cloudflare WAF or
Access layer for production use.

## Chrome mDNS candidate obfuscation (local development)

Chrome 75+ hides local IP addresses in ICE candidates behind ephemeral mDNS hostnames
(`UUID.local`) via the `enable-webrtc-hide-local-ips-with-mdns` flag, which is **on by
default**. The host CLI resolves these using three strategies (macOS `dns-sd`, raw UDP
multicast query, OS `getaddrinfo`); however, mDNS resolution for ephemeral WebRTC
records can fail depending on OS version and network configuration.

**Symptoms**: connection succeeds through the signaling server but the data channel
never opens; the CLI logs `mDNS UUID.local unresolvable — skipped`.

**Workaround** (local testing only): in Chrome, navigate to
`chrome://flags/#enable-webrtc-hide-local-ips-with-mdns`, set to **Disabled**, and
relaunch. Chrome will then include real local IP addresses in ICE candidates. Do not
advise end users to disable this flag — it exists for privacy reasons.

On the same machine (host and viewer on the same laptop), the SRFLX candidate (from
STUN) requires hairpin NAT which is not available on all home and corporate routers;
ICE may only succeed via the mDNS host candidate. This is a local-only issue.

## Desktop-only UX

No mobile-specific layout or touch optimisation has been applied to the viewer. The
connection flow and diagnostics surface are designed for desktop browser viewports.

## `npm install` may need a C++ toolchain (node-datachannel native build)

`node-datachannel` ships prebuilt binaries fetched by `prebuild-install` for
common platform/arch/Node-ABI combinations. Its own `install` script is:

```
prebuild-install -r napi || (npm install --ignore-scripts --production=false && npm run _prebuild)
```

If no matching prebuild exists (uncommon platform, very new/old Node, or no
network access to GitHub releases at install time), it falls back to
compiling from source via `cmake-js`, which requires `cmake` and a C++
compiler on the install machine — neither is installed by `npm install`
itself. On a fresh deploy machine with no build tools, this fails with a
`cmake-js` / `node-gyp`-style error, not an obvious "please install cmake"
message.

**Mitigation**: verify `npm install` succeeds on the actual target OS/arch/Node
combination before publishing (RELEASE_CHECKLIST.md Phase 0/4). If it fails,
either install `cmake` + a C compiler on that machine, or use a Node version
with an available prebuild.
