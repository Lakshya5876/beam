---
name: project-beam-state
description: Current state of the Beam project — what's done, what's next, key architectural facts
metadata:
  type: project
---

Beam is a WebRTC-based localhost tunneling CLI. Stack: TypeScript strict, Node ≥ 22, Vitest, Cloudflare Worker + DO (signaling), Cloudflare Pages (viewer). Binary name: `bm`.

**Why:** Developer shares a local dev server with a remote collaborator over a P2P data channel. Only SDP/ICE signaling touches Cloudflare; no traffic goes through it.

**Current state (as of 2026-06-20):** Feature-complete for v1. All 206 tests pass, 87.47% line coverage. `feat/domain-frame` branch, HEAD `e900069`. Deploy bundle built (`viewer/dist/` is current). Local E2E green.

**Commits landed:**
- `e900069` — DEPLOY.md fixes (wrangler.jsonc ref, build output, S18 pre-flight)
- `f99f11a` — M3: full PIN pairing (DO register/verify/lockout, viewer PIN gate, host hash send)
- `4f4359f` — CLI rewrite: `bm` UX, interactive URL prompt, CSPRNG 6-digit PIN
- `ca77b2d` — MAX_PAYLOAD_SIZE → 16375 (RTCDataChannel SCTP ceiling)
- `3491360` — docs/ planning suite
- `509bfdc` — 9 WebRTC bugs fixed

**Next steps (in order):**
1. Human deploys on personal laptop: `wrangler deploy --config signaling/wrangler.jsonc` + `wrangler pages deploy viewer/dist/ --project-name beam-viewer --branch main`
2. Human runs S18 live proofs (7 proofs, spec in S18_CONTRACT.md). Proof 0 (DataChannel ceiling) gates everything else.
3. Agent task: npm packaging — rename to `@beamtunnel/cli`, add `"bin":{"bm":"dist/cli.js"}`, tsc→dist pipeline, `.npmignore`
4. Optional post-v1: TURN relay (Cloudflare Calls or Metered.ca) for symmetric NAT

**How to apply:** Reference for prioritizing and scoping new tasks. Step 3 (npm packaging) is the next agent task after S18 proofs pass.
