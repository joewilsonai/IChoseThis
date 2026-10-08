#!/usr/bin/env bash
# Build the one-file Railway Function and ship it.
#
# The room runs on Railway's Bun function image, which starts with
# `./run.sh <base64 of the source file>`; the source lives in the service's start
# command and nowhere else on Railway. This script runs the tests, builds
# dist/railway-function.ts, writes it into that start command, deploys, and waits
# for the deployment to report SUCCESS. Needs a logged-in Railway CLI (5.28+ for
# `railway api`) with access to the project.
#
# Usage: scripts/deploy-function.sh [--dry-run]
#   --dry-run  test and build, print the size, change nothing on Railway.
# Override the targets with RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID and
# RAILWAY_SERVICE_ID; the defaults are the live room (project elle-em-relay,
# environment production, service chat-relay).
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${RAILWAY_PROJECT_ID:-91d22263-80fe-407e-be70-2f490f88aafd}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT_ID:-937115c1-900b-4e80-ac66-fc20f7ceeccf}"
SERVICE="${RAILWAY_SERVICE_ID:-3815a221-3885-4262-a29b-2eb30597fa34}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

echo "tests"
npm test >/tmp/ichosethis-test.log 2>&1 || { tail -40 /tmp/ichosethis-test.log; echo "tests failed; nothing deployed"; exit 1; }
grep -E '^ℹ (tests|pass|fail)' /tmp/ichosethis-test.log
echo "build"
npm run build

VARS="$(mktemp)"
trap 'rm -f "$VARS"' EXIT
node -e '
const fs = require("node:fs");
const [out, serviceId, environmentId] = process.argv.slice(1);
const source = fs.readFileSync("dist/railway-function.ts");
fs.writeFileSync(out, JSON.stringify({serviceId, environmentId, input: {startCommand: "./run.sh " + source.toString("base64")}}));
console.log("start command: " + (source.toString("base64").length + 9) + " characters");
' "$VARS" "$SERVICE" "$ENVIRONMENT"

if [ "$DRY_RUN" = 1 ]; then echo "dry run: Railway untouched"; exit 0; fi

echo "writing the start command"
railway api 'mutation Update($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}' --variables "@$VARS" --compact

echo "deploying"
DEPLOYMENT="$(railway api 'mutation Deploy($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
}' --raw-var "serviceId=$SERVICE" --raw-var "environmentId=$ENVIRONMENT" --compact | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.data?.serviceInstanceDeployV2||j.serviceInstanceDeployV2||"")})')"
[ -n "$DEPLOYMENT" ] || { echo "no deployment id came back"; exit 1; }
echo "deployment $DEPLOYMENT"

for _ in $(seq 1 60); do
  STATUS="$(railway deployment list -p "$PROJECT" -e "$ENVIRONMENT" -s "$SERVICE" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const d=(Array.isArray(j)?j:j.deployments||[]).find(x=>x.id===process.argv[1]);process.stdout.write(d?d.status:"UNKNOWN")})' "$DEPLOYMENT")"
  echo "  $STATUS"
  case "$STATUS" in
    SUCCESS) break ;;
    FAILED|CRASHED|REMOVED|SKIPPED) echo "deployment ended in $STATUS"; exit 1 ;;
  esac
  sleep 5
done
[ "$STATUS" = SUCCESS ] || { echo "gave up waiting; check the deployment on Railway"; exit 1; }
echo "live: $(curl -fsS -m 15 https://ichosethis.up.railway.app/health)"
