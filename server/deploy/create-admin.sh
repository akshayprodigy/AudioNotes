#!/usr/bin/env bash
#
# Create — or reset the password of — the account that signs in to /admin.
#
#   VERBALE_HOST=root@69.62.82.85 ./deploy/create-admin.sh you@example.com 'a long password'
#
# This exists because nothing on the website creates accounts any more. The site is a landing
# page; subscriptions are bought in the app through Google Play, and an account is created by the
# purchase. So the one account that has a password — the operator's — has to be made here, on
# purpose, over ssh, by somebody who already has the server.
#
# That is the point rather than an inconvenience: an HTTP route that creates a privileged account
# is reachable, and this is not.
#
# Two more things are needed before /admin will let anyone in, both in the server's .env:
#
#   ADMIN_SESSION_SECRET=$(openssl rand -hex 32)
#   VERBALE_ADMIN_EMAILS=you@example.com
#
# Creating the account grants nothing on its own — authorisation is the allowlist, and it is read
# from the environment on every request so that removing an address ends that session at once.
set -euo pipefail

HOST="${VERBALE_HOST:?set VERBALE_HOST, e.g. root@69.62.82.85}"
REMOTE_DIR="${VERBALE_REMOTE_DIR:-/opt/verbale}"
EMAIL="${1:?usage: create-admin.sh <email> <password>}"
PASSWORD="${2:?usage: create-admin.sh <email> <password>}"

if [ "${#PASSWORD}" -lt 12 ]; then
  echo "Use a password of at least 12 characters. This one opens the customer list." >&2
  exit 1
fi

ssh "$HOST" "cd '$REMOTE_DIR' && docker compose exec -T \
  -e ADMIN_EMAIL='$EMAIL' -e ADMIN_PASSWORD='$PASSWORD' \
  api python -c \"
import os
from app.store import Store
email, password = os.environ['ADMIN_EMAIL'], os.environ['ADMIN_PASSWORD']
s = Store('/data/licences.db')
account = s.account_by_email(email)
if account is None:
    account = s.create_account(email, password)
    print('created', account.email, account.id)
else:
    s.set_password(account.id, password)
    print('password reset for', account.email, account.id)

allowed = {e.strip().lower() for e in os.environ.get('VERBALE_ADMIN_EMAILS','').split(',') if e.strip()}
if not os.environ.get('ADMIN_SESSION_SECRET','').strip():
    print('WARNING: ADMIN_SESSION_SECRET is not set — /admin answers 404 to everyone')
elif email.strip().lower() not in allowed:
    print('WARNING:', email, 'is not in VERBALE_ADMIN_EMAILS — this account cannot sign in')
else:
    print('this account may sign in at /admin')
\""
