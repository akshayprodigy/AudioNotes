#!/usr/bin/env bash
#
# Fill the model mirror this host serves at /models/v1/.
#
#   VERBALE_HOST=root@69.62.82.85 ./deploy/mirror-models.sh
#
# The weights are fetched BY THE SERVER, straight from GitHub and Hugging Face — they are never
# uploaded from a laptop. 1.4 GB over a home connection is an hour of someone's evening and a
# second copy of bytes the server can pull itself in a couple of minutes; the only things that
# cross the wire from here are two small text files.
#
# Idempotent, and safe to run against a live mirror. scripts/mirror-models.py skips any file
# already present with the right sha256, so a re-run after a failure resumes the work rather than
# repeating it, and a re-run after nothing changed is a no-op that costs a few seconds of hashing.
#
# Files land in /srv/verbale-models, NOT in /opt/verbale. That is deliberate: deploy.sh rsyncs the
# licence server to /opt/verbale with --delete, so a mirror kept there would be silently erased by
# the next unrelated deploy — and the next first run would quietly fall back to upstream with
# nobody the wiser.
set -euo pipefail

HOST="${VERBALE_HOST:?set VERBALE_HOST, e.g. root@69.62.82.85}"
SERVE_DIR="${VERBALE_MODELS_DIR:-/srv/verbale-models}"
STAGE_DIR="${VERBALE_MIRROR_TOOL_DIR:-/opt/verbale-mirror-tool}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CATALOG="$(cd "$REPO" && find android/app/src/main/java -name ModelCatalog.kt)"
[ -n "$CATALOG" ] || { echo "!! could not find ModelCatalog.kt" >&2; exit 1; }

echo "==> mirroring to $HOST:$SERVE_DIR"
echo "    catalog: $CATALOG"

# The fetch script reads the URLs and hashes out of ModelCatalog.kt and refuses to keep a file that
# does not match. Sending the catalog rather than a copied-out list of hashes is the point: a
# mirror that disagreed with the app about what a file should be would serve exactly the wrong
# thing, verify it happily, and break first run for everyone who trusted the mirror first.
ssh "$HOST" "mkdir -p '$STAGE_DIR/scripts' '$STAGE_DIR/$(dirname "$CATALOG")' '$SERVE_DIR'"
scp -q "$REPO/scripts/mirror-models.py" "$HOST:$STAGE_DIR/scripts/"
scp -q "$REPO/$CATALOG"                 "$HOST:$STAGE_DIR/$CATALOG"

echo "==> fetching (this runs on the server, from upstream)"
ssh "$HOST" "python3 '$STAGE_DIR/scripts/mirror-models.py' fetch --dir '$SERVE_DIR'"

# nginx runs as www-data and needs to traverse and read. 755/644 and nothing group-writable: these
# are files the whole internet downloads and executes as model weights on people's phones.
echo "==> permissions"
ssh "$HOST" "chmod 755 '$SERVE_DIR' '$SERVE_DIR/models' '$SERVE_DIR/models/v1' &&
             chmod 644 '$SERVE_DIR/models/v1/'* &&
             ls -la '$SERVE_DIR/models/v1/'"

echo
echo "==> done. Serve it by running setup-nginx.sh on the server, then check with:"
echo "      ./scripts/mirror-models.py verify --base https://verbale.innocorelabs.com"
