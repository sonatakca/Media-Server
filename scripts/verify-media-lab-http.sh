#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$PROJECT_ROOT"

if [ ! -f .env ]; then
  echo "Missing $PROJECT_ROOT/.env" >&2
  exit 1
fi

export SEYIRLIK_LAB_DATABASE_URL=$(
  node --env-file=.env -e \
    'const url = new URL(process.env.DATABASE_URL); url.pathname = "/seyirlik_lab"; process.stdout.write(url.toString())'
)

exec node --env-file=.env --import tsx scripts/verify-adaptive-http.ts
