#!/usr/bin/env bash
#
# Copy the licence database off the server.
#
#   AUDIONOTES_HOST=root@69.62.82.85 ./deploy/backup.sh [destination-dir]
#
# Everything the server knows is in one SQLite file: accounts, subscriptions, devices. Losing it
# means every paying customer has to sign up again, so this should run on a schedule, not by hand.
#
# Uses sqlite3's .backup rather than `cp`, because copying a file mid-write while WAL is on yields
# a database that looks fine and is not.
set -euo pipefail

HOST="${AUDIONOTES_HOST:?set AUDIONOTES_HOST, e.g. root@69.62.82.85}"
REMOTE_DIR="${AUDIONOTES_REMOTE_DIR:-/opt/audionotes}"
DEST="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$DEST"
ssh "$HOST" "cd '$REMOTE_DIR' && docker compose exec -T api python -c \"
import sqlite3
src = sqlite3.connect('/data/licences.db')
dst = sqlite3.connect('/tmp/backup.db')
src.backup(dst)
dst.close(); src.close()
\" && docker compose exec -T api cat /tmp/backup.db" > "$DEST/licences-$STAMP.db"

# A truncated download is worse than no download: it looks like a backup.
if ! sqlite3 "$DEST/licences-$STAMP.db" 'PRAGMA integrity_check;' 2>/dev/null | grep -q '^ok$'; then
  echo "!! the downloaded file did not pass integrity_check — not a usable backup" >&2
  exit 1
fi

echo "$DEST/licences-$STAMP.db"
