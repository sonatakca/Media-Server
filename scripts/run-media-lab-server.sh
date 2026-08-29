#!/usr/bin/env bash
set -euo pipefail

LAB_ROOT="${SEYIRLIK_LAB_ROOT:-/Volumes/Expansion/seyirlik-lab}"
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)

cd "$PROJECT_ROOT"

if [ ! -f .env ]; then
  echo "Missing $PROJECT_ROOT/.env" >&2
  exit 1
fi

LAB_DATABASE_URL=$(
  node --env-file=.env -e \
    'const url = new URL(process.env.DATABASE_URL); url.pathname = "/seyirlik_lab"; process.stdout.write(url.toString())'
)

export DATABASE_URL="$LAB_DATABASE_URL"
export SEYIRLIK_HOST="127.0.0.1"
export SEYIRLIK_PORT="43111"
export SEYIRLIK_MEDIA_ROOT="${LAB_ROOT}/media"
export SEYIRLIK_LIBRARIES='[{"slug":"movies","name":"Movies","kind":"movies","roots":["Movies"]}]'
export SEYIRLIK_GENERATED_STORAGE="${LAB_ROOT}/generated"
export SEYIRLIK_STATIC_ROOT="${PROJECT_ROOT}/dist"
export SEYIRLIK_RENDITION_ROOT="${LAB_ROOT}/outputs/native-cmaf"
export SEYIRLIK_RENDITION_STATE_ROOT="${LAB_ROOT}/reports/native-cmaf"

exec node --env-file=.env --import tsx src/server/mediaServer.ts
