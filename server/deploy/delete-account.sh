#!/usr/bin/env bash
#
# Honour a deletion request: cancel the subscription at Google, then erase the account.
#
#   VERBALE_HOST=root@69.62.82.85 ./deploy/delete-account.sh them@example.com
#   VERBALE_HOST=root@69.62.82.85 ./deploy/delete-account.sh acct_ab12cd34ef      # by id
#
# There is no web page for this. The site is a landing page, an account is created by a Play
# purchase and has no password, so a self-service form could only ever be a way for a stranger to
# delete somebody else's subscription by typing their address. Requests arrive by email at
# /delete-account and are honoured here.
#
# The order matters and is not this script's to get right: it calls
# billing.delete_account_with_subscription, which cancels FIRST and refuses to delete if the
# cancellation cannot be confirmed. Deleting our row stops us knowing about a subscription; it does
# not stop Google charging the card.
set -euo pipefail

HOST="${VERBALE_HOST:?set VERBALE_HOST, e.g. root@69.62.82.85}"
REMOTE_DIR="${VERBALE_REMOTE_DIR:-/opt/verbale}"
WHO="${1:?usage: delete-account.sh <email|account_id>}"

echo "==> about to permanently delete: $WHO"
read -r -p "    type DELETE to continue: " CONFIRM
[ "$CONFIRM" = "DELETE" ] || { echo "nothing done"; exit 1; }

ssh "$HOST" "cd '$REMOTE_DIR' && docker compose exec -T -e WHO='$WHO' api python -c \"
import os
from app.billing import delete_account_with_subscription
from app.store import Store

who = os.environ['WHO']
s = Store('/data/licences.db')
account = s.account_by_email(who)
account_id = account.id if account else who

row = s.admin_account(account_id)
if row is None:
    raise SystemExit('no such account: ' + who)
print('found', row.email or '(no email)', row.account_id, row.status, row.plan)

ok, error = delete_account_with_subscription(s, account_id)
if not ok:
    raise SystemExit('REFUSED, nothing deleted: ' + str(error))
print('deleted', row.account_id)
\""
