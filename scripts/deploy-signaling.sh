#!/usr/bin/env bash
# Deploy the Beam signaling worker. HUMAN-ONLY, DEPLOY MACHINE ONLY.
# This script transmits code to Cloudflare — it refuses to run unless
# explicitly confirmed, so it can never fire accidentally on the governed
# dev laptop (Architecture Guidelines §3 LOCAL-ONLY).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${BEAM_DEPLOY_CONFIRM:-}" != "yes" ]; then
  cat >&2 <<'MSG'
REFUSING TO DEPLOY.

This command pushes the signaling worker to Cloudflare (network egress).
Run it yourself, on the deploy machine, with:

  BEAM_DEPLOY_CONFIRM=yes bash scripts/deploy-signaling.sh

Docs: docs/deploy/CLOUDFLARE_SETUP.md §1
MSG
  exit 1
fi

cd "$ROOT/signaling"
npm ci
npx tsc --noEmit -p tsconfig.json
npx vitest run
npx wrangler deploy --config wrangler.jsonc

echo
echo "Deployed. Record the URL above as SIGNALING_URL and verify:"
echo "  curl -s -X POST <url>/new           # {\"code\":...}"
echo "  curl -s <url>/ice-config            # {\"iceServers\":[...]}"
