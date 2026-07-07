# Configuration Reference — every knob in one place

Resolution order everywhere: **CLI flag > environment variable > compiled
default**. Nothing else reads `process.env` (Architecture Guidelines §3 — all env access
goes through `src/config.ts`).

## Host CLI (`bm`)

| Env var | Flag | Default | Meaning |
|---------|------|---------|---------|
| `BEAM_SIGNALING_URL` | `--signaling <url>` | compiled `DEFAULT_SIGNALING_URL` | Signaling worker endpoint (`wss://…`; `https://…` is auto-rewritten) |
| `BEAM_VIEWER_URL` | `--viewer <url>` | compiled `DEFAULT_VIEWER_URL` | Viewer Pages base URL printed in the session link |
| `BEAM_ICE_SERVERS` | `--ice <urls>` | libdatachannel default (Google STUN) | Comma-separated ICE URLs for the host peer: `stun:host:port`, `turn:user:pass@host:port?transport=udp` |
| `BEAM_MINT_TIMEOUT_MS` | — | `5000` | HTTP timeout for the session-mint POST |
| `BEAM_LOG_LEVEL` | — | `info` | Reserved (structured log level) |
| `APP_PORT` | — | `8080` | Reserved (diagnostics surface) |
| — | `--debug` | off | Verbose connection timeline (signaling, ICE, DTLS, relay) to stderr |
| — | `--allowed-paths /a,/b` | all paths | Path allow-list enforced host-side |
| — | `--ttl <seconds>` | none | Session time-to-live |

TURN credentials passed via `BEAM_ICE_SERVERS`/`--ice` exist only in the
shell/process — never written to disk (§3). Prefer the env var over the flag
for credentials so they don't land in shell history.

## Signaling worker (`signaling/wrangler.jsonc` → `vars`)

| Var | Default | Meaning |
|-----|---------|---------|
| `ICE_SERVERS` | `[{"urls":"stun:stun.l.google.com:19302"}]` | JSON array of RTCIceServer objects served at `GET /ice-config` (viewer fetches this). PUBLIC — no long-lived TURN credentials. |
| `MINT_MAX_PER_MINUTE` | `30` | Per-IP mint rate limit |
| `PIN_MAX_ATTEMPTS` | `3` | PIN attempts before lockout |

Malformed values fall back to the defaults — the worker never crashes on bad
config.

## Viewer (static bundle — no build-time env)

| Input | Source | Meaning |
|-------|--------|---------|
| `?signaling=<url>/<code>` | session link printed by the CLI | Signaling endpoint + session code |
| `?session=<code>` | alternative to path-suffix form | Session code only |
| ICE servers | fetched from `GET <signaling-origin>/ice-config` at connect time; falls back to Google STUN on any failure | Deploy-time ICE without rebuilding the viewer |

The viewer intentionally has **zero** baked-in deployment values: rotating a
STUN/TURN host is a `wrangler.jsonc` var change + worker redeploy, no Pages
redeploy.

## `.env.example` (root)

`.env.example` is agent-write-protected; it should carry this block (add via
human edit if missing):

```
# Beam — environment template. Placeholder keys ONLY; real values are
# injected at shell level and NEVER written to disk (Architecture Guidelines §3).
BEAM_LOG_LEVEL=info
APP_PORT=8080
# Deployment endpoints (flag > env > compiled default)
BEAM_SIGNALING_URL=
BEAM_VIEWER_URL=
# Comma-separated ICE URLs for the host peer. TURN credentials only ever
# at shell level.
BEAM_ICE_SERVERS=
BEAM_MINT_TIMEOUT_MS=5000
```
