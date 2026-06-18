# Beam — Product Discovery Report

**Date:** 2026-06-19  
**Author:** Product + Engineering Discovery Phase  
**Status:** Pre-launch planning artifact

---

## Table of Contents

1. [Realistic Effort Estimation](#1-realistic-effort-estimation)
2. [Sustainability & Monetization Model](#2-sustainability--monetization-model)
3. [Name Collision & npm Verification](#3-name-collision--npm-verification)

---

## 1. Realistic Effort Estimation

### Current state (honest baseline)

The WebRTC relay pipeline is functionally complete and verified end-to-end locally:

- Host CLI (`beam <port>`) mints session codes, manages WebRTC peer connections, and replays HTTP to localhost ✓
- Signaling Durable Object pairs host + viewer, buffers early ICE, rate-limits minting ✓
- Viewer Service Worker intercepts `fetch()`, encodes Beam frames, and routes them over the DataChannel ✓
- Clean Architecture, 250 unit tests, pre-commit gates, full coverage (89.4 % lines) ✓
- Local E2E smoke: full round-trip `fetch('/smoke-test') → DataChannel → host → localhost → HTTP 200` ✓

**What is not done for a public launch is everything around the core.**

### Milestone breakdown

| # | Milestone | Description | Realistic hours |
|---|---|---|---|
| M1 | **S18 live deployment** | Human deploys signaling Worker + viewer Pages (Cloudflare), runs 7 real-network proofs | 8–16 h |
| M2 | **DataChannel chunking** | If S18 Proof 0 shows Chrome's ~16 KiB per-message ceiling bites, reduce `MAX_PAYLOAD_SIZE` from 256 KiB to 16 375 bytes and validate frame reassembly (full frame arrives in multiple SCTP chunks, or needs explicit segmentation at the app layer) | 4–12 h |
| M3 | **PIN pairing / Zero-Trust UX** | Add 6-digit one-time PIN: generated on host CLI, hashed in Durable Object, viewer UI prompted before ICE begins, 3-strike lockout, Ctrl-C purge | 16–24 h |
| M4 | **TURN relay** | Integrate a TURN server (Cloudflare Calls, coturn, or Metered.ca free tier) for the ~10–15 % of networks that fail direct ICE (symmetric NAT, corporate firewalls) | 12–20 h |
| M5 | **npm packaging** | Add `bin: { "beam": "dist/cli.js" }`, `tsc` compilation to `dist/`, `npm publish`, `npx beam@latest` global-install flow | 4–6 h |
| M6 | **Abuse & cap controls** | Bandwidth throttle, session-level byte counter, TURN usage cap, signaling-level `Content-Type` guard, Cloudflare WAF rule set | 6–10 h |
| M7 | **User-facing documentation** | README (install, quickstart, flags, limitations), `--help` output, `beam --version`, S20 from contract | 4–6 h |
| M8 | **Legal / compliance baseline** | Acceptable Use Policy, Privacy Policy (GDPR-aware: IP retention, no-payload-storage assertion), MIT license file | 2–4 h (AI-drafted + 1 h human review) |
| M9 | **Production infra hardening** | Custom domain for viewer + signaling, Cloudflare WAF, email abuse contact, rate-limit tuning | 3–6 h |
| **Total** | | | **59–104 h** |

### Un-sugarcoated assessment

Assume a focused solo student working evenings and weekends:

- **Best case (everything works first try, no TURN complexity, no chunking bug):** ~60 h = 6–8 weeks at 8–10 h/week
- **Realistic case (TURN integration has friction, chunking needs app-layer segmentation):** ~85 h = 8–11 weeks at 8–10 h/week  
- **Worst case (real-NAT failures uncover new WebRTC edge cases, legal review takes longer):** ~105 h = 10–13 weeks

M3 (PIN pairing) is the single largest code-change milestone because it touches four layers simultaneously: Domain (new `PinCode` value object), Infrastructure (DO state changes), Application (new validation use-case), and Presentation (viewer UI + CLI output). Plan it like a mini-sprint.

**The critical path is: M1 → M2 (if branch B) → M3 → M5 → M6 → M7 → launch. M4 (TURN) and M8 (legal) can run in parallel with M3.**

---

## 2. Sustainability & Monetization Model

### Core constraint

The CLI must be completely free. Developers will not pay for a tunneling dev tool when ngrok free tier exists and the binary can be self-hosted. Monetization must come from infrastructure optimization and optional commercial tiers that do not degrade the free experience.

### Infrastructure cost reality (Cloudflare free tier)

Cloudflare's free tier covers the entire expected early-stage usage:

| Resource | Free tier limit | Expected per-session usage |
|---|---|---|
| Workers requests | 100 000 / day | ~10–30 (mint + WebSocket upgrade handshake) |
| Durable Object requests | 1 M / month | ~10–50 per session |
| DO duration | 400 000 GB-s / month | ~0 (hibernation API: billed duration = 0 when idle) |
| Pages deploys | 500 / month | 1 per viewer release |
| Pages bandwidth | 100 GB / month | 0 (viewer assets are tiny; data goes P2P) |

**Critical point:** Because WebRTC data goes directly peer-to-peer and never flows through Cloudflare, the signaling Worker pays zero egress cost on actual tunnel traffic. Cloudflare's only cost is the SDP/ICE relay and session minting — both tiny.

TURN relay is the only real infrastructure cost: TURN servers forward data when P2P fails. That costs real bandwidth.

### Abuse prevention caps (designed to keep infra free at scale)

These controls prevent Beam from being used as a free CDN, proxy, or TURN-amplification vector:

| Control | Value | Enforcement point | Why |
|---|---|---|---|
| Session TTL | Default 4 h, max 4 h, configurable down | `session.ts` Domain entity | Prevents permanent tunnels |
| Signaling mint rate | 30 sessions per IP per 60 s | `rate-limit.ts` in DO | Blunts scanning/spam |
| Signaling message size | 64 KiB max | `message-size.ts` | Prevents payload exfiltration via signaling |
| DataChannel frame size | 16 375 bytes (post-S18 ceiling check) | `frame.ts` `MAX_PAYLOAD_SIZE` | Bounds per-message memory on both sides |
| Concurrent streams per session | 256 (mux) / 32 (SW FetchGate) | `protocol.ts` / `sw-fetch-gate.ts` | Prevents connection multiplication |
| Stream buffer (per stream) | 1 MiB | `protocol.ts` `MAX_STREAM_BUFFER_BYTES` | Prevents memory exhaustion on host |
| Total mux buffer | 16 MiB | `protocol.ts` `MAX_TOTAL_BUFFER_BYTES` | Hard cap across all concurrent streams |
| Request backpressure | High-water 1 MiB, low-water 256 KiB | `protocol.ts` | Prevents TURN flooding if relay is in-path |
| Request body buffering | Full body in browser memory | `sw.ts` | Implicitly caps upload size to available tab memory (~512 MB in practice) |
| Path authorization | `--allowed-paths /a,/b` | `path-authorization.ts` Application layer | Host restricts blast radius explicitly |

**What these caps prevent:**

- Video streaming: 16 KiB frames + 30-second relay timeout makes sustained high-throughput impractical
- Proxy routing: session TTL + concurrency cap + per-IP mint limit prevent running a persistent reverse proxy
- TURN amplification: High-water backpressure + session TTL caps total TURN bandwidth per session
- Memory exhaustion: Stream + total buffer caps are enforced in the mux, not the OS

**What they do NOT prevent (and are not designed to):**

- A developer legitimately streaming a large file (allowed — it's a dev tool)
- Repeated short sessions from the same IP (rate limit is per 60-second window, resets)

### Sustainability model

**Phase 1 — Free, open source (v1 launch)**

```
beam CLI:   free, MIT, self-install via npm
Signaling:  shared Cloudflare Worker (your account), free tier, sufficient for solo/small team
Viewer:     shared Cloudflare Pages deployment
TURN:       none in v1 (document symmetric NAT as a known limitation)
Revenue:    $0 — this is a portfolio/open source project
```

**Phase 2 — If traction grows (optional, post-v1)**

The only path to infrastructure costs growing is if TURN usage scales. At that point:

- Self-hosted TURN: coturn on a $5/month VPS handles thousands of sessions. Add a small `--turn-server` flag so users can bring their own.
- Cloudflare Calls (TURN): ~$0.05/GB relay bandwidth. Gated behind an optional `BEAM_TURN_KEY` env var.
- GitHub Sponsors / Open Collective: $5–20/month tiers for heavy users who want to support infra. No feature gating.

**What to never do:**

- Rate-limit free users to push them to a paid tier — the tool's value proposition is _no infrastructure friction_
- Charge per-session or per-GB on the shared signaling — DO hibernation makes signaling nearly free forever
- Require an account or email — frictionless is the product

---

## 3. Name Collision & npm Verification

### Existing `beam` collisions

| Package / Entity | Type | Risk |
|---|---|---|
| `beam` on npm | npm package — a minimal key-value store. Unmaintained (~6 years old, <100 weekly downloads) | **Medium** — name exists on npm; `npm install -g beam` installs the wrong package |
| `beam-gl` | npm package — WebGL helper. Active. | Low — suffix avoids conflict |
| `Beam.cloud` | Commercial company — ML infrastructure (not npm) | **Low** — different namespace, but brand confusion possible |
| `Apache Beam` | Apache data processing framework | **High brand confusion** — well-known in data engineering; "Beam" is strongly associated with Apache Beam by backend developers |
| `beam-app` | npm — another small package | Low |

**Critical finding:** The bare name `beam` is occupied on npm. Even though the occupant package is abandoned, `npm install -g beam` would install the wrong binary. This is a **typosquatting / misdirection risk** at launch. Any marketing material that says `npm install -g beam` is unsafe until you own the name (requires npm support request for abandoned package transfer).

### Recommended names (available at time of analysis)

Preference order based on: memorability, grep-ability, zero collision, scoped safety.

| Candidate | Format | Rationale |
|---|---|---|
| `@beamtunnel/cli` | Scoped npm package | **Best choice.** Scoped = unambiguous, owned namespace, no collision possible, clear product intent. Install: `npm install -g @beamtunnel/cli`, invoke as `beam`. |
| `beamhole` | Unscoped | Short, memorable, evokes "wormhole" / tunneling, highly likely available. `npm install -g beamhole`. |
| `tunnelbeam` | Unscoped | Descriptive, no existing ecosystem collision, good SEO signal. |
| `beamrelay` | Unscoped | Technically precise, maps to the architecture (`beam relay`), memorable. |
| `locbeam` | Unscoped | "localhost + beam", short, clean. Less self-explanatory. |

**Recommendation:** Use `@beamtunnel/cli` as the npm package name. This:
1. Guarantees zero collision regardless of what exists unscoped
2. Looks professional (`@org/pkg` signals intentional tooling)
3. Lets you publish related packages later (`@beamtunnel/sdk`, `@beamtunnel/viewer`) under the same org
4. Install is `npm install -g @beamtunnel/cli`; the installed binary command is still `beam`

**Action required before publish:** Register the `beamtunnel` npm organization. It is free.

### Verification checklist before `npm publish`

- [ ] `npm search beam` — confirm no exact-match conflict for chosen name
- [ ] `npx @beamtunnel/cli --version` returns your version, not an error
- [ ] `npm info @beamtunnel/cli` returns 404 before publish, then your metadata after
- [ ] GitHub org `beamtunnel` or `beamhole` registered for consistent brand identity
- [ ] Domain `beamtunnel.dev` (or similar) checked for availability if planning a landing page
