# Release Checklist — v1

Order matters: infrastructure first, then the CLI defaults, then npm. Every
box is checkable mechanically. Run on the deploy machine; the dev laptop's
role ends at a local commit.

## Phase 0 — leaving the dev laptop

- [ ] `npx vitest run` — full suite green (root)
- [ ] `cd signaling && npx vitest run` — green
- [ ] `cd viewer && npx vitest run` — green
- [ ] `npx tsc --noEmit` green in root, `signaling/`, `viewer/`
- [ ] `npx eslint .` clean (root)
- [ ] `bash scripts/preflight.sh` — everything except the placeholder-URL
      check passes (that one fails by design until Phase 2)
- [ ] Zip the repo **excluding** `node_modules`, `dist`, `coverage`,
      `.wrangler`, `.git` (or `git archive HEAD`) and move it

## Phase 1 — infrastructure (docs/deploy/CLOUDFLARE_SETUP.md)

- [ ] `npm ci` in `signaling/`, deploy worker, record `SIGNALING_URL`
- [ ] `curl -X POST $SIGNALING_URL/new` returns a code
- [ ] `curl $SIGNALING_URL/ice-config` returns the ICE JSON
- [ ] `npm ci && npm run build` in `viewer/`, create Pages project, deploy
- [ ] `curl -sI $VIEWER_URL/__beam/sw.js` shows `Service-Worker-Allowed: /`
- [ ] Root page serves `beam-root`

## Phase 2 — point the CLI at the real endpoints

- [ ] Edit `src/presentation/cli.ts`: set `DEFAULT_SIGNALING_URL` (wss form)
      and `DEFAULT_VIEWER_URL` to the recorded URLs
- [ ] `npx vitest run` still green (tests don't pin the URL values)
- [ ] `bash scripts/preflight.sh` — now fully green, including placeholders

## Phase 3 — first live end-to-end (two networks) — GATE

- [ ] CLOUDFLARE_SETUP.md §5 executed: host on one network, viewer on
      another (phone on cellular is ideal)
- [ ] Page loads, PIN accepted, "Connected — ready to relay"
- [ ] A request round-trips (server log on the host machine shows the hit)
- [ ] `--debug` timeline shows `selected` candidate pair (direct or srflx)

**Do not publish if this gate fails.** End-to-end networking is only
"verified" when this has actually passed on separate networks — the local
harness cannot prove NAT traversal.

## Phase 4 — npm publish (docs/deploy/NPM_PUBLISH.md)

- [ ] Version set (`0.1.0` for first publish), `CHANGELOG` entry if kept
- [ ] `npm pack --dry-run` — files list is exactly `dist/`, `README.md`,
      `SECURITY.md`, `LIMITATIONS.md`, `LICENSE`, `package.json`
- [ ] `npm publish --access public` (scoped package `@beamtunnel/cli`)
- [ ] Post-publish smoke: `npx @beamtunnel/cli@latest 3000` on a machine that
      has never seen this repo

## Phase 5 — after publish

- [ ] Tag the release commit locally (`git tag v0.1.0`)
- [ ] Record the live URLs + account subdomain somewhere durable
- [ ] Re-run the Phase 3 test with the published package, not the local build
