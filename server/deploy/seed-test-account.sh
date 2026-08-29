#!/usr/bin/env bash
#
# Give one account a paid subscription, without Razorpay.
#
#   VERBALE_HOST=root@69.62.82.85 ./deploy/seed-test-account.sh you@example.com 'a good password'
#
# For testing Pro on a device before billing is live. Normally the ONLY thing that may mark a
# subscription paid is the Razorpay webhook; this is the deliberate exception, kept as a script
# somebody has to run on purpose rather than as an endpoint that could be reached.
#
# Delete these accounts before launch: `docker compose exec api python -c "..."`, or just remove
# the subscription row. They are indistinguishable from a real subscriber to everything upstream.
set -euo pipefail

HOST="${VERBALE_HOST:?set VERBALE_HOST, e.g. root@69.62.82.85}"
REMOTE_DIR="${VERBALE_REMOTE_DIR:-/opt/verbale}"
EMAIL="${1:?usage: seed-test-account.sh <email> <password> [days]}"
PASSWORD="${2:?usage: seed-test-account.sh <email> <password> [days]}"
DAYS="${3:-30}"

ssh "$HOST" "cd '$REMOTE_DIR' && docker compose exec -T \
  -e SEED_EMAIL='$EMAIL' -e SEED_PASSWORD='$PASSWORD' -e SEED_DAYS='$DAYS' \
  api python -c \"
import os, time
from app.store import Store, Subscription
email, password, days = os.environ['SEED_EMAIL'], os.environ['SEED_PASSWORD'], int(os.environ['SEED_DAYS'])
s = Store('/data/licences.db')
account = s.account_by_email(email) or s.create_account(email, password)
s.upsert_subscription(Subscription(account_id=account.id, plan='pro', provider_id='seeded_'+account.id,
                                   status='active', current_period_end=int(time.time()) + days*86400))
print('seeded', account.email, account.id, 'pro for', days, 'days')
\""
