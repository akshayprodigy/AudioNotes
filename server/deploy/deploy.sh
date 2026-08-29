#!/usr/bin/env bash
#
# Ship the licence server to its host and bring it up.
#
#   VERBALE_HOST=root@69.62.82.85 ./deploy/deploy.sh
#
# Idempotent, and safe to run against a live server: it never touches .env or the database volume,
# so secrets and accounts survive every deploy. The first run on a new host needs an .env there —
# see "First run on a new host" in the README.
set -euo pipefail

HOST="${VERBALE_HOST:?set VERBALE_HOST, e.g. root@69.62.82.85}"
REMOTE_DIR="${VERBALE_REMOTE_DIR:-/opt/verbale}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> deploying $LOCAL_DIR -> $HOST:$REMOTE_DIR"

ssh "$HOST" "mkdir -p '$REMOTE_DIR'"

# --delete keeps the remote tree honest, but .env and any stray database file are excluded from
# BOTH the transfer and the delete: they live on the server and nowhere else.
rsync -az --delete \
  --exclude '.venv/' \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  --exclude 'node_modules/' \
  --exclude '.env' \
  --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' \
  --exclude '*.pem' \
  "$LOCAL_DIR/" "$HOST:$REMOTE_DIR/"

ssh "$HOST" "test -f '$REMOTE_DIR/.env'" || {
  echo "!! $REMOTE_DIR/.env does not exist on $HOST." >&2
  echo "   Copy .env.example there and fill in LICENCE_PRIVATE_KEY_PEM before deploying." >&2
  exit 1
}

echo "==> building and starting"
ssh "$HOST" "cd '$REMOTE_DIR' && docker compose up -d --build --remove-orphans && docker compose ps"

echo "==> waiting for health"
ssh "$HOST" "cd '$REMOTE_DIR' && for i in \$(seq 1 30); do
  if docker compose exec -T api python -c \"import urllib.request;urllib.request.urlopen('http://127.0.0.1:8787/healthz',timeout=3)\" >/dev/null 2>&1; then
    echo 'healthy'; exit 0
  fi
  sleep 2
done
echo 'did not become healthy'; docker compose logs --tail=50 api; exit 1"

echo "==> done"
