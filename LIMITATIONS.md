# Beam v1 — Known Limitations

## Platform scope: Windows host, Chromium viewer, for now

**Host**: Windows only. Nothing in the architecture is Windows-specific by
design (the native WebRTC layer, node-datachannel, ships prebuilt binaries
for macOS and Linux too), but macOS and Linux hosts have not been built,
run, or verified in this release. Treat them as unsupported, not
assumed-working.

**Viewer**: Chromium-based browsers (Chrome, Edge, and the Chromium family)
on any OS. Verified two ways: automated (`e2e-app-compat.mjs`, Chrome and
Edge on Windows) and on real hardware across a real cross-device,
cross-network connection (Windows host, Android Chrome viewer on mobile
data — see "WebKit-based browsers do not currently work" below for the
device this was cross-checked against).

## WebKit-based browsers do not currently work (Safari, all of iOS)

This means Safari on any platform, and **every** browser on iOS/iPadOS —
Apple requires all iOS browsers, including Chrome and Firefox for iOS, to
use WebKit underneath rather than their own engine, so "Chrome on iPhone" is
WebKit wearing a Chrome skin, not Chromium.

Confirmed via a real device test (iPhone, opened via Chrome for iOS), not
inferred: the underlying WebRTC connection succeeds completely — ICE
negotiates, `DataChannel OPEN` fires, `peerState=connected` — but the
tunneled page never renders. Cross-checked on the same host session against
a genuine Chromium browser (Android Chrome, different device, same host),
which worked immediately. The failure is isolated to the relay layer, not
WebRTC: zero request frames ever reach the host after the DataChannel opens,
meaning the iframe's navigation request never reaches the service worker
pipeline at all.

The suspected mechanism (not yet root-caused to a specific line, since
remote iOS debugging wasn't available): WebKit has documented, longstanding
gaps in Service Worker interception of iframe navigation requests, an area
where its behavior diverges from Chromium's. The viewer's whole architecture
depends on exactly that interception (see "The iframe-shell architecture"
below) — the outer shell embeds the tunneled app in an iframe and relies on
the service worker to intercept the iframe's own navigation to relay it over
the DataChannel.

Firefox has not been tested in this release, on any platform.

## The iframe-shell architecture (how full navigation works, and where it doesn't)

The viewer page is a thin **outer shell**: it holds the RTCPeerConnection, the
service worker registration, and the DataChannel multiplexer. Once connected, it
embeds your tunneled app in an `<iframe>` pointed at your app's own root page —
the iframe is a genuinely separate browsing context, so full page navigations
inside it (client-side routed *or* traditional server-rendered) do not tear down
the outer shell's WebRTC connection. This is a real architectural fix, not a
workaround: earlier designs that ran the RTCPeerConnection directly in the
top-level document could only support single-page apps, because a tunneled
top-level navigation would unload the document holding the connection.

**What this does NOT fix**: the iframe still shares the viewer's origin
(`beam-viewer.pages.dev` or wherever you deploy it) with every other Beam
session that has ever run in the same browser profile — see "Session storage
isolation" below. It also does not change the fact that your app's origin, as
the browser sees it, is the viewer's origin — not `localhost`. Absolute URLs,
OAuth redirect URIs, or CORS rules your app hardcodes against its own
`localhost:<port>` origin will not resolve the way they would un-tunneled;
Beam rewrites self-referential `Location` redirect headers (see below) but does
not rewrite arbitrary absolute URLs inside HTML/JS/CSS bodies.

### Self-referential redirects ARE rewritten

If your app redirects to itself using an absolute URL — `Location:
http://localhost:3000/dashboard` — Beam rewrites it to a path-relative
`/dashboard` before relaying it, so the browser resolves it against the tunnel's
own origin instead of trying (and failing) to reach `localhost` on the
**viewer's** machine. Only `Location` headers pointing at `localhost` or
`127.0.0.1` (any port) are rewritten; a redirect to a genuinely different host is
left untouched.

## Session storage isolation (same browser profile, different sessions)

Every Beam session currently uses the same viewer origin. If you run two
*different* tunneling sessions from the same browser profile — even at
different times, not simultaneously — cookies, `localStorage`, and the Cache
API your tunneled app sets are **not** isolated between them: session B could
see (or silently collide with) storage session A's app left behind. Using a
fresh browser profile, an incognito/private window, or clearing site data for
the viewer's origin between sessions avoids this. A real fix requires
per-session subdomains (a bigger infrastructure change, deferred — see
`docs/TRD.md` if you're picking this up later). This is not a concern for a
single ongoing host+viewer pairing, only for reusing the same browser across
unrelated sessions.

## TURN relay: supported, but only if the deployment configures it

Beam prefers a direct peer-to-peer path and falls back to a TURN relay when ICE
cannot find one — symmetric NAT (common on corporate firewalls) and carrier-
grade NAT (common on mobile networks and a growing number of home ISPs) are the
cases that need the fallback. The fallback is automatic and per-connection:
relay servers are offered alongside STUN and standard ICE candidate
prioritization nominates a relay pair only when no direct pair passes its
connectivity checks. Beam never routes traffic through TURN by choice.

**A deployment with no TURN configured still fails on those networks.** TURN is
opt-in per deployment because it needs a provider account; see
`docs/deploy/CLOUDFLARE_SETUP.md`. With it unset, `GET /ice-config` reports
`x-beam-turn: not-configured` and the viewer says so explicitly when a
connection fails, rather than showing a generic error.

Credential handling: credentials are minted server-side, per mint, and expire
(default 4h). The long-lived provider secret is a Worker secret and never
reaches a client. `/ice-config` is public by design — a peer needs it before it
can prove anything about a session — which is exactly why what it serves is
short-lived. Never put a long-lived TURN credential in the `ICE_SERVERS` var;
it is served verbatim to anyone who asks.

`BEAM_ICE_SERVERS`/`--ice` still accepts `turn:` URLs for a self-hosted coturn;
those are merged with whatever `/ice-config` serves rather than replacing it.

`--ipv4-only` (both host and viewer — see README) mitigates a *different*
failure mode: slow or failed nomination on dual-stack networks racing IPv6
against IPv4 candidate pairs. It does not help symmetric NAT/CGNAT.

**Verification status:** all three ICE paths are covered by
`e2e-connection.mjs` and have been run against a live Metered TURN account —
not just asserted to compile. DIRECT connects on a normal network and reports
`path=direct` (TURN is not the default transport). The no-relay-available
failure path fails deterministically with a stage-tagged diagnostic. The
relay path — forcing `iceTransportPolicy:'relay'` on BOTH peers, so no direct
pair can win — completed through Metered's real infrastructure
(`DataChannel OPEN path=RELAY (TURN)`) and relayed a real HTTP request through
it. Re-running this requires your own provider credentials
(`BEAM_E2E_TURN_APP` / `BEAM_E2E_TURN_SECRET`); without them the suite skips
that one scenario loudly rather than reporting a false pass.

One real bug surfaced only by this live testing, not by any unit test: the
Metered provider called the injected `fetch` as `this.fetchImpl(...)` — a
method call, so `fetch`'s `this` became the provider instance rather than the
global scope. Node's `fetch` tolerates that; a real Cloudflare Worker's does
not, and rejected every mint attempt on every real deployment, in every
configuration, indistinguishable from a network outage. All 18 unit tests for
this module passed throughout, because they run under Node. Fixed at the
constructor (the injected fetch is wrapped in an arrow function before being
stored), with a regression test that reproduces the receiver check a real
Worker enforces.

## Reloading (or navigating) the OUTER viewer tab always starts a fresh connection

The service worker excludes the viewer's own shell (`/` on a genuine top-level
document navigation), its bundle (`/assets/*`), and `/__beam/*` from relay
(`sw-fetch-gate.ts` `shouldBypassRelay`) so that reloading the outer tab (or
navigating its address bar) can always re-fetch and re-run the bootstrap
script, rather than hanging while the SW tries to relay the viewer's own JS
through a peer connection that no longer exists post-unload. Such a reload
always re-runs the PIN gate on the *same* session (the signaling URL + code
are in the query string) — it does not resume the in-page connection state,
since the RTCPeerConnection and multiplexer are destroyed on unload.

**This does not apply to navigation inside the tunneled-app iframe** — the
iframe-shell architecture (see above) means the app itself can navigate
freely, including full page loads, without affecting the outer connection at
all. Only navigating the OUTER browser tab (its address bar, a bookmark, a
hard reload of the top-level document) restarts the tunnel.

**Reserved paths**: if the tunneled target itself serves `/assets/*` and the
OUTER document somehow requests it (not the normal case — the iframe's own
requests are correctly exempted regardless of path, see `shouldBypassRelay`'s
`destination === 'iframe'` check), that prefix would be shadowed by the
viewer's own bundle. In practice this only matters if you manually navigate
the outer tab to a path under `/assets/`.

## WebSocket relay — supported, with caveats

`new WebSocket(...)` calls made by your tunneled app ARE relayed over the same
DataChannel as HTTP traffic. Since a service worker cannot intercept the
WebSocket constructor (only `fetch()`), this works by injecting a small script
into every relayed `text/html` response that replaces `window.WebSocket`
inside the iframe with a lookalike that routes through the tunnel instead of
opening a real socket.

Known caveats:
- **No cookie forwarding on the WS handshake.** The browser's WebSocket API
  does not expose cookies as request headers to page JS, and the host dials
  the local WebSocket from a separate Node process that does not share the
  browser's cookie jar. An app that authenticates a WS connection via a
  session cookie will not authenticate over the relay. Token-in-URL or
  token-in-first-message auth patterns are unaffected.
- **Compressed HTML responses don't get the shim.** Injecting into a
  `Content-Encoding: gzip/br/deflate` body would corrupt it, so compressed
  HTML is relayed byte-for-byte unmodified instead — correct, but without WS
  support on that page. Most local dev servers don't compress HTML by
  default, so this is uncommon in practice.
- **The shim is a `type="module"` script.** It runs before any of the
  tunneled app's own `type="module"` scripts (the common case for modern
  bundled apps — Vite, Next.js, etc.), but an app relying solely on classic
  (non-module) scripts that construct a WebSocket synchronously during
  initial parse could theoretically race ahead of the shim.
- **Blob payloads sent via `ws.send(blob)` can arrive slightly out of order**
  relative to a `send()` called immediately after — reading a Blob is
  inherently asynchronous, unlike the synchronous string/ArrayBuffer/typed-
  array path. Rare in practice; most apps send JSON strings or binary
  ArrayBuffers, not Blobs, on outgoing WS messages.
- **`--allowed-paths` applies to WS connections too** — a WS endpoint at a
  path not in the allow-list is rejected the same way an HTTP request would
  be.

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

## `npx beam-tunnel` fails on Windows — use `npm install -g` instead

Confirmed via real testing (npm 10.9.2, Node 22.14.0, Windows, both
PowerShell and reproduced directly): `npx beam-tunnel` fails immediately
with `'bm' is not recognized as an internal or external command`, before
the local-URL prompt ever appears.

This is not a Beam packaging defect. Root-caused, not guessed:
- The package's `bin` shims (`bm`, `bm.cmd`, `bm.ps1`) are generated
  correctly by npm's installer — inspected directly in npx's own temp
  install directory (`node_modules/.bin/`) and confirmed present.
- Invoking the generated `bm.ps1` shim directly (bypassing npx entirely)
  works perfectly.
- `npm install -g beam-tunnel` followed by `bm` works perfectly — this
  goes through npm's normal, permanent bin-linking path rather than npx's
  temporary-install-and-spawn path.
- Even `npx -p beam-tunnel bm` — explicitly naming both the package and
  the exact bin, removing any ambiguity from name-matching — fails
  identically. This rules out "bin name differs from package name" as the
  cause; the failure is in npx's own process-spawn step on Windows, after
  resolution has already succeeded, not in resolving which bin to run.

**Mitigation**: the documented primary install path (see README) is
`npm install -g beam-tunnel` then `bm` — two commands instead of one, but
confirmed reliable, and arguably better anyway for a tool used more than
once (npx re-downloads every invocation). Re-test `npx beam-tunnel`
against future npm releases; this may be fixed upstream without any
change needed on Beam's side.
