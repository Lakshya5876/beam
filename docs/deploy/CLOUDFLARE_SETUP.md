# Cloudflare Setup — Signaling Worker + Viewer Pages

Complete, mechanical setup instructions. Run everything in this document on
the **deploy machine only** — never on the governed dev laptop (CLAUDE.md §3
LOCAL-ONLY). Every command is idempotent; re-running is safe.

## 0. Prerequisites

- Node >= 22, npm
- A Cloudflare account (free tier is sufficient — the DO is SQLite-backed)
- The Beam repository (this repo, copied/unzipped)
- `npx wrangler --version` >= 4.x (bundled in `signaling/node_modules`)

Log in once (opens a browser):

```bash
cd signaling
npx wrangler login
npx wrangler whoami         # note your account subdomain: <account>.workers.dev
```

## 1. Deploy the signaling worker

```bash
cd signaling
npm ci
npx wrangler deploy --config wrangler.jsonc
```

- First deploy runs the DO migration (`v1`, SQLite class `SessionDurableObject`)
  automatically — no separate migration step.
- The output prints the live URL:
  `https://beam-signaling.<account>.workers.dev`
- **Record this URL.** It is `SIGNALING_URL` for every later step. The
  WebSocket form is the same URL with `wss://`.

### Worker configuration knobs (already in `wrangler.jsonc` `vars`)

| Var | Default | Meaning |
|-----|---------|---------|
| `ICE_SERVERS` | Google STUN | JSON array of RTCIceServer objects, served publicly at `GET /ice-config` — the viewer fetches this before creating its RTCPeerConnection |
| `MINT_MAX_PER_MINUTE` | `30` | Session-mint rate limit per IP |
| `PIN_MAX_ATTEMPTS` | `3` | PIN attempts before lockout |

To add TURN later: `ICE_SERVERS` is **public** (anyone can GET /ice-config).
Never put long-lived TURN credentials there. Use a TURN provider with
short-lived credentials (e.g. Cloudflare Calls TURN, Twilio NTS) and rotate,
or add an authenticated credential endpoint first.

### Verify the worker

```bash
SIGNALING_URL=https://beam-signaling.<account>.workers.dev

curl -s -X POST $SIGNALING_URL/new            # → {"code":"<26+ chars>"}
curl -s $SIGNALING_URL/ice-config             # → {"iceServers":[{"urls":"stun:..."}]}
curl -s -o /dev/null -w '%{http_code}\n' $SIGNALING_URL/   # → 426 (WS upgrade required) — correct
```

## 2. Deploy the viewer (Cloudflare Pages)

```bash
cd viewer
npm ci
npm run build                                  # outputs viewer/dist/
npx wrangler pages project create beam-viewer --production-branch main   # first time only
npx wrangler pages deploy dist --project-name beam-viewer --branch main
```

- Output prints the live URL: `https://beam-viewer.pages.dev` (or
  `https://<hash>.beam-viewer.pages.dev` for preview deploys — use the
  production alias).
- **If the project name `beam-viewer` is taken**, pick another
  (`beam-viewer-<yourname>`) and use that URL everywhere `VIEWER_URL` appears.

### Verify the viewer (all three must pass)

```bash
VIEWER_URL=https://beam-viewer.pages.dev

# 1. SW header — REQUIRED. Without it Chrome throws SecurityError on register().
curl -sI $VIEWER_URL/__beam/sw.js | grep -i service-worker-allowed
# → Service-Worker-Allowed: /

# 2. Root page serves the app shell
curl -s $VIEWER_URL/ | grep beam-root
# → <main id="beam-root">

# 3. SW bundle is JavaScript, not an HTML 404 fallback
curl -sI $VIEWER_URL/__beam/sw.js | grep -i content-type
# → application/javascript (or text/javascript)
```

Check 3 matters: Pages serves `index.html` for unknown paths (SPA fallback).
If the SW file were missing from the build, check 1 and the register() call
would fail confusingly. `_headers` ships from `viewer/public/_headers`.

## 3. DNS requirements

**None for the default setup.** `*.workers.dev` and `*.pages.dev` are fully
managed by Cloudflare, TLS included. This is the recommended v1 path.

Optional custom domains (only if you own a zone on the same Cloudflare account):

| Component | How | DNS record |
|-----------|-----|-----------|
| Signaling worker | Workers → beam-signaling → Settings → Domains & Routes → Custom Domain (e.g. `signal.example.com`) | Created automatically by Cloudflare |
| Viewer Pages | Pages → beam-viewer → Custom domains (e.g. `beam.example.com`) | CNAME `beam` → `beam-viewer.pages.dev` (auto-created if the zone is on the account) |

WebSockets and the DO work unchanged behind a custom domain. If you use custom
domains, substitute them for `SIGNALING_URL` / `VIEWER_URL` everywhere,
including step 4.

## 4. Wire the real URLs into the CLI

The published CLI must default to the URLs you just deployed. In
`src/presentation/cli.ts` replace the compiled placeholders:

```ts
export const DEFAULT_SIGNALING_URL = 'wss://beam-signaling.<account>.workers.dev';
export const DEFAULT_VIEWER_URL = 'https://beam-viewer.pages.dev';
```

`scripts/preflight.sh` fails until this is done — that is intentional.
(Users can always override with `--signaling` / `--viewer` flags or
`BEAM_SIGNALING_URL` / `BEAM_VIEWER_URL` env vars; the defaults are what
`bm 3000` uses out of the box.)

## 5. First live end-to-end test (two networks)

Run this before publishing to npm. Machine A (host) and a phone on cellular
data (viewer) is the strongest test — it exercises NAT traversal for real.

1. Machine A: `python3 -m http.server 3000` (any local server)
2. Machine A: `node dist/presentation/cli.js 3000 --debug`
   (`--debug` prints the signaling/ICE/DTLS timeline to stderr)
3. Note the printed Viewer URL + 6-digit PIN.
4. Phone (cellular, NOT the same Wi-Fi): open the Viewer URL, enter the PIN.
5. Expect "Connected — ready to relay", then browse — requests hit Machine A.

If step 5 fails, capture:
- Host stderr (`--debug` timeline — states, candidate types, failure reason)
- Browser console (`[VIEWER-BOOT]` lines)
- `chrome://webrtc-internals` → ICE candidate grid

Two hosts behind symmetric NATs cannot connect with STUN alone — that is the
documented v1 limitation (LIMITATIONS.md), not a deployment error. Retest from
a different network before concluding the deploy is broken.
