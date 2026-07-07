# npm Publish Checklist — @beamtunnel/cli

Publish is a human-only action on the deploy machine (LOCAL-ONLY, CLAUDE.md
§3). Prerequisite: RELEASE_CHECKLIST.md Phase 3 (live two-network test) has
passed.

## One-time setup

- [ ] npm account with publish rights
- [ ] The `@beamtunnel` scope exists and you are an owner
      (`npm org` / `npm access ls-packages`), or create it at npmjs.com
- [ ] `npm login` on the deploy machine

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
- [ ] `node_modules/@beamtunnel/cli/dist/presentation/cli.js` is executable

## Publish

```bash
npm publish --access public       # scoped packages default to restricted
```

- [ ] Verify on npmjs.com: README renders, version correct
- [ ] `npx @beamtunnel/cli@latest 3000` on a clean machine reaches the PIN
      screen (this exercises the compiled DEFAULT_* URLs — the real deploy)

## Rollback

`npm unpublish @beamtunnel/cli@<version>` works within 72h for a package with
no dependents; otherwise `npm deprecate`. Never republish a changed tarball
under the same version.

## Notes

- `prepublishOnly` already runs build + test + lint — publishing from an
  unbuilt tree fails loudly rather than shipping stale `dist/`.
- The native dependency (`node-datachannel`) ships prebuilds for
  macOS/Linux/Windows on Node 22; no compile step for end users. If a
  platform lacks a prebuild, `npm install` falls back to a source build
  needing cmake — documented in LIMITATIONS.md.
