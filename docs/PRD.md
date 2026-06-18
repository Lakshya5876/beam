# Beam — Product Requirements Document (PRD)

**Version:** 1.0 (MVP)  
**Date:** 2026-06-19  
**Status:** Planning  
**Owner:** Project maintainer

---

## 1. Problem Statement

Developers routinely need to share a locally running web application with a remote collaborator — for QA review, stakeholder demo, or pair debugging — without deploying to a server. Existing solutions require:

- **ngrok / Cloudflare Tunnel:** Account creation, CLI auth tokens, reverse-proxy routing through a third-party server (all traffic traverses their infrastructure)
- **VS Code / GitHub Codespaces port forwarding:** Requires a specific IDE or cloud subscription
- **SSH -L tunneling:** Requires SSH access to a shared server and non-trivial setup

**Beam solves this with zero infrastructure on the developer's machine**, using WebRTC DataChannels for direct peer-to-peer data transfer, and a minimal Cloudflare Worker exclusively for signaling (SDP/ICE exchange) — not for routing traffic.

---

## 2. Target Audience

**Primary:** Developers (frontend, fullstack, mobile app developers) running a local dev server who need to share it with one remote collaborator without deploying.

**Typical user:** Solo developer or small team (1–5 people). No ops background. Uses Vite, React, Vue, or a similar SPA framework. Comfortable with a terminal.

**Anti-target:** Production hosting, always-on tunnels, enterprise compliance environments, mobile app QA (mobile UX not in scope for v1), regulated data (HIPAA, PCI).

---

## 3. MVP Scope

### In scope for v1

| Feature | Description |
|---|---|
| **Host CLI** | `beam <port>` — single command to expose a local port |
| **Consent banner** | Terminal warning listing port, path scope, and session lifetime before tunnel opens |
| **Path authorization** | `--allowed-paths /a,/b` — expose only specific route prefixes, block all others with HTTP 403 |
| **Session TTL** | `--ttl <seconds>` — session auto-expires; default 4 hours; configurable only downward |
| **Zero-trust PIN pairing** | 6-digit one-time PIN displayed in host terminal; viewer must enter it before WebRTC ICE begins; PIN validated server-side at the signaling layer |
| **Viewer web app** | Static page (Cloudflare Pages) with Service Worker that intercepts `fetch()` calls and routes them over the DataChannel |
| **Shared signaling** | Shared Cloudflare Worker + Durable Object for SDP/ICE exchange and PIN validation |
| **Honest failure** | ICE failures, expired sessions, wrong PIN, and host disconnect all surface as named errors with clear UI — no silent hangs |
| **Request log** | Host terminal diagnostics: method, path, status, latency per relayed request |
| **npm packaging** | `npm install -g @beamtunnel/cli` and `npx @beamtunnel/cli` |
| **STUN** | Google STUN (`stun:stun.l.google.com:19302`) for direct ICE path discovery |

### Not in scope for v1 (explicitly)

| Non-goal | Rationale |
|---|---|
| Production hosting / CDN replacement | Beam is ephemeral by design; sessions expire |
| Multi-page server-rendered apps (SSR, PHP, Rails) | Top-level navigation destroys the viewer-side RTCPeerConnection; the iframe-shell fix is post-v1 |
| WebSocket proxying | `Upgrade: websocket` not intercepted by the Service Worker; out of scope |
| TURN relay | ~10–15% symmetric NAT failure rate is documented and accepted for v1 |
| Mobile viewer UX | Desktop browsers only; no responsive layout or touch optimization |
| Team / multi-viewer sessions | Single viewer per session code; second viewer is rejected |
| File system access | Beam is an HTTP relay, not a file sync tool |
| Persistent sessions | Sessions are ephemeral; codes are single-use |
| Audit logs / compliance | No storage of request bodies or access logs beyond terminal diagnostics |

---

## 4. User Stories

### Core relay stories

- **US-1:** As a developer, I want to run `beam 3000` in my terminal so that I get a shareable URL and PIN in under 5 seconds.
- **US-2:** As a developer, I want a clear consent warning before the tunnel opens so that I understand what I'm exposing.
- **US-3:** As a developer, I want to restrict the tunnel to `/demo` and `/api` so that my private routes are not reachable.
- **US-4:** As a developer, I want the tunnel to auto-close after 1 hour so that I don't forget to stop it.
- **US-5:** As a developer, I want to stop the tunnel instantly with Ctrl-C so that access is revoked immediately.

### Viewer stories

- **US-6:** As a QA reviewer, I want to open a URL and enter a PIN so that I know I'm connecting to the right host.
- **US-7:** As a QA reviewer, I want the page to tell me when the host has disconnected so that I'm not confused by a blank page.
- **US-8:** As a QA reviewer, I want failed fetch requests to return HTTP 504 (not a JS error) so that the app I'm reviewing renders a clean error state.

### Security stories

- **US-9:** As a developer, I want to know that only the person I gave the PIN to can access my localhost.
- **US-10:** As a developer, I want the session to be permanently dead if the PIN is entered incorrectly 3 times so that brute-force is impractical.

---

## 5. Success Metrics (MVP)

| Metric | Target at launch | Measurement |
|---|---|---|
| Time-to-tunnel | < 5 s from `beam 3000` to URL printed | Measured locally |
| ICE connection success rate (non-symmetric-NAT networks) | > 90% | S18 proofs across multiple network types |
| PIN pairing success (correct code, first try) | 100% | Integration test |
| PIN brute-force protection | Session locked after 3 failures | Integration test |
| Host Ctrl-C → tunnel collapse | < 500 ms from signal to viewer `renderFailed` | Measured in S18 Proof 6 |
| npm install to first working tunnel | < 3 min (including `npm install -g`) | Manual UX walkthrough |
| Cloudflare free tier headroom | Stays within limits at 500 sessions/day | Cloudflare analytics |

---

## 6. Constraints

- **Node.js >= 22** — required by `node-datachannel` and native Web Crypto APIs
- **Chrome desktop only (viewer)** — Safari and Firefox have known WebRTC DataChannel behavior differences not yet tested
- **Cloudflare Durable Objects** — signaling and PIN validation are DO-bound; no alternative backend supported in v1
- **Single viewer per session** — Durable Object pairing logic rejects a third WebSocket connection
- **No request body streaming** — Service Worker buffers full request body before sending first frame; large uploads hold the body in tab memory

---

## 7. Open Questions (pre-v1)

| # | Question | Owner | Blocker for launch? |
|---|---|---|---|
| OQ-1 | Does Chrome's ~16 KiB SCTP ceiling require app-layer chunking? | Engineering (S18 Proof 0) | Yes — determines MAX_PAYLOAD_SIZE |
| OQ-2 | Does `_headers` file on CF Pages correctly deliver `Service-Worker-Allowed: /`? | Engineering (S18 deploy) | Yes |
| OQ-3 | Is the `beamtunnel` npm org available? | Maintainer | Yes (before publish) |
| OQ-4 | Will the TURN-less failure rate be acceptable to v1 users? | Maintainer | No — acceptable for v1 with documentation |
| OQ-5 | What is the exact PIN UX on the viewer page? | Design (see USER_FLOW.md) | Yes (M3) |
