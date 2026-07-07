#!/usr/bin/env bash
# Deploy the Beam viewer to Cloudflare Pages. HUMAN-ONLY, DEPLOY MACHINE ONLY.
# Refuses to run without explicit confirmation (Architecture Guidelines §3 LOCAL-ONLY).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${BEAM_PAGES_PROJECT:-beam-viewer}"

if [ "${BEAM_DEPLOY_CONFIRM:-}" != "yes" ]; then
  cat >&2 <<'MSG'
REFUSING TO DEPLOY.

This command pushes the viewer bundle to Cloudflare Pages (network egress).
Run it yourself, on the deploy machine, with:

  BEAM_DEPLOY_CONFIRM=yes bash scripts/deploy-viewer.sh
  # optional: BEAM_PAGES_PROJECT=<name> to override the project name

Docs: docs/deploy/CLOUDFLARE_SETUP.md §2
MSG
  exit 1
fi

cd "$ROOT/viewer"
npm ci
npx tsc --noEmit
npx vitest run
npm run build

# Load-bearing artifact checks BEFORE pushing anything
test -f dist/__beam/sw.js || { echo "FATAL: dist/__beam/sw.js missing" >&2; exit 1; }
grep -q 'Service-Worker-Allowed' dist/_headers || { echo "FATAL: dist/_headers missing Service-Worker-Allowed" >&2; exit 1; }

npx wrangler pages deploy dist --project-name "$PROJECT" --branch main

echo
echo "Deployed. Verify (docs/deploy/CLOUDFLARE_SETUP.md §2):"
echo "  curl -sI <viewer-url>/__beam/sw.js | grep -i service-worker-allowed"
