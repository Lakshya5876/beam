# npm Publish Checklist — beam-tunnel

Publish is a human-only action on the deploy machine (LOCAL-ONLY, Architecture Guidelines
§3). Prerequisite: RELEASE_CHECKLIST.md Phase 3 (live two-network test) has
passed.

## One-time setup

- [ ] npm account with publish rights
- [ ] `npm login` on the deploy machine
      (`beam-tunnel` is unscoped — no npm organization to create or own first)

## Pre-publish verification

```bash
npm ci
npm run build                      # tsc --project tsconfig.build.json → dist/
npm test                           # full vitest suite
npm run lint
npm pack --dry-run                 # inspect EXACTLY what ships
```

Check the `npm pack` output:

- [ ] `dist/presentation/cli.js` present and starts with `#!/usr/bin/env node`
- [ ] `dist/composition.js` present (the `exports` entry)
- [ ] No `tests/`, no `src/`, no `.env*`, no `docs/`, no zip files
- [ ] Total size sane (< 1 MB unpacked)

Binary smoke test from the packed tarball:

```bash
npm pack                                    # produces beamtunnel-cli-0.1.0.tgz
cd "$(mktemp -d)" && npm init -y >/dev/null
npm install /path/to/beamtunnel-cli-0.1.0.tgz
npx bm --help 2>&1 | head -3                # usage line prints, exit code 2 on no-TTY prompt is fine
```

- [ ] `bm` resolves and prints usage
- [ ] `node_modules/beam-tunnel/dist/presentation/cli.js` is executable

## Publish

```bash
npm publish       # beam-tunnel is unscoped — public by default, no --access flag needed
```

- [ ] Verify on npmjs.com: README renders, version correct
- [ ] On a clean Windows machine: `npm install -g beam-tunnel@latest` then
      `bm 3000` reaches the PIN screen (this exercises the compiled
      DEFAULT_* URLs — the real deploy). Do NOT use `npx beam-tunnel` for
      this check — it fails on Windows for reasons unrelated to the
      package itself (see LIMITATIONS.md); a failure there is not evidence
      the release is broken.

## Rollback

`npm unpublish beam-tunnel@<version>` works within 72h for a package with
no dependents; otherwise `npm deprecate`. Never republish a changed tarball
under the same version.

## Notes

- `prepublishOnly` already runs build + test + lint — publishing from an
  unbuilt tree fails loudly rather than shipping stale `dist/`.
- The native dependency (`node-datachannel`) ships prebuilds for
  macOS/Linux/Windows on Node 22; no compile step for end users. If a
  platform lacks a prebuild, `npm install` falls back to a source build
  needing cmake — documented in LIMITATIONS.md.
