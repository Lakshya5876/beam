#!/usr/bin/env bash
# Beam pre-deploy preflight — LOCAL ONLY. Verifies the repo is mechanically
# deployable: gates green, artifacts build, load-bearing files present, and
# the compiled CLI defaults are no longer placeholders. No network egress.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

echo "== Gates =="
npx vitest run >/dev/null 2>&1                && ok "host test suite"        || bad "host test suite (npx vitest run)"
npx tsc --noEmit >/dev/null 2>&1              && ok "host types"             || bad "host types (npx tsc --noEmit)"
npx eslint . >/dev/null 2>&1                  && ok "lint"                   || bad "lint (npx eslint .)"
( cd signaling && npx vitest run >/dev/null 2>&1 )                     && ok "signaling tests"  || bad "signaling tests"
( cd signaling && npx tsc --noEmit -p tsconfig.json >/dev/null 2>&1 )  && ok "signaling types"  || bad "signaling types"
( cd viewer && npx vitest run >/dev/null 2>&1 )                        && ok "viewer tests"     || bad "viewer tests"
( cd viewer && npx tsc --noEmit >/dev/null 2>&1 )                      && ok "viewer types"     || bad "viewer types"

echo "== Build artifacts =="
npm run build >/dev/null 2>&1                 && ok "CLI build (dist/)"      || bad "CLI build"
[ -f dist/presentation/cli.js ] && head -1 dist/presentation/cli.js | grep -q '^#!' \
                                              && ok "cli.js shebang"         || bad "dist/presentation/cli.js missing or no shebang"
( cd viewer && npm run build >/dev/null 2>&1 ) && ok "viewer build"          || bad "viewer build"
[ -f viewer/dist/__beam/sw.js ]               && ok "SW at dist/__beam/sw.js" || bad "viewer/dist/__beam/sw.js missing"
[ -f viewer/dist/_headers ] && grep -q 'Service-Worker-Allowed' viewer/dist/_headers \
                                              && ok "_headers ships SW-Allowed" || bad "viewer/dist/_headers missing Service-Worker-Allowed"
grep -q 'beam-root' viewer/dist/index.html 2>/dev/null \
                                              && ok "index.html app shell"   || bad "viewer/dist/index.html missing beam-root"

echo "== Wrangler configs parse (local validation, no deploy) =="
node -e "JSON.parse(require('fs').readFileSync('signaling/wrangler.jsonc','utf8').replace(/^\s*\/\/.*$/gm,''))" >/dev/null 2>&1 \
                                              && ok "signaling/wrangler.jsonc parses" || bad "signaling/wrangler.jsonc invalid"
node -e "JSON.parse(require('fs').readFileSync('viewer/wrangler.jsonc','utf8').replace(/^\s*\/\/.*$/gm,''))" >/dev/null 2>&1 \
                                              && ok "viewer/wrangler.jsonc parses"    || bad "viewer/wrangler.jsonc invalid"

echo "== Compiled CLI defaults (fail until pointed at the real deploy) =="
if grep -q "signal\.beam\.workers\.dev" src/presentation/cli.ts; then
  bad "DEFAULT_SIGNALING_URL is still the placeholder (RELEASE_CHECKLIST Phase 2)"
else
  ok "DEFAULT_SIGNALING_URL replaced"
fi

echo "== Packaging =="
# npm pack prints the manifest to stderr as "npm notice" lines
PACK_LIST="$(npm pack --dry-run 2>&1)"
printf '%s' "$PACK_LIST" | grep -q 'dist/presentation/cli.js' \
                                              && ok "npm pack includes cli.js" || bad "npm pack missing dist/presentation/cli.js"
printf '%s' "$PACK_LIST" | grep -qE ' (src|tests)/' \
                                              && bad "npm pack leaks src/ or tests/" || ok "npm pack leaks nothing"

echo
echo "preflight: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
