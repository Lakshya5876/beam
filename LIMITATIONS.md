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

## Desktop-only UX

No mobile-specific layout or touch optimisation has been applied to the viewer. The
connection flow and diagnostics surface are designed for desktop browser viewports.
