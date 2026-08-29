#!/usr/bin/env bash
#
# Put the licence server on a hostname, with TLS. Run ON the server, once.
#
#   AUDIONOTES_HOSTNAME=audionotes.innocorelabs.com ./setup-nginx.sh
#
# Obtains a Let's Encrypt certificate, installs the nginx site and reloads. Everything it does is
# idempotent, so re-running after a config change is the intended way to apply one.
#
# This must run after DNS points at this machine — Let's Encrypt proves control of the name by
# fetching a file over HTTP, so a name that does not resolve here cannot be certified. The check
# below fails early rather than burning one of the five-per-week rate-limited attempts.
set -euo pipefail

HOSTNAME_="${AUDIONOTES_HOSTNAME:?set AUDIONOTES_HOSTNAME, e.g. audionotes.innocorelabs.com}"
EMAIL="${AUDIONOTES_ADMIN_EMAIL:-admin@innocorelabs.com}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v nginx >/dev/null || { echo "!! nginx is not installed" >&2; exit 1; }
command -v certbot >/dev/null || { echo "!! certbot is not installed" >&2; exit 1; }

echo "==> checking DNS"
resolved="$(getent ahostsv4 "$HOSTNAME_" | awk '{print $1; exit}' || true)"
mine="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
if [ -z "$resolved" ]; then
  echo "!! $HOSTNAME_ does not resolve. Add an A record pointing at ${mine:-this server} first." >&2
  exit 1
fi
if [ -n "$mine" ] && [ "$resolved" != "$mine" ]; then
  echo "!! $HOSTNAME_ resolves to $resolved but this server is $mine." >&2
  echo "   Fix the A record, or wait for the old one to expire from cache." >&2
  exit 1
fi
echo "    $HOSTNAME_ -> $resolved"

echo "==> checking the app is up on localhost"
curl -fsS --max-time 5 "http://127.0.0.1:${HOST_PORT:-9100}/healthz" >/dev/null || {
  echo "!! nothing healthy on 127.0.0.1:${HOST_PORT:-9100}. Deploy the container first." >&2
  exit 1
}

if [ ! -d "/etc/letsencrypt/live/$HOSTNAME_" ]; then
  echo "==> obtaining a certificate"
  # certonly, so certbot writes no nginx config of its own — the site file below is the single
  # description of how this host is served, and two tools editing it is how it drifts.
  certbot certonly --nginx --non-interactive --agree-tos \
    --email "$EMAIL" -d "$HOSTNAME_"
else
  echo "==> certificate already present; renewal is certbot's own timer"
fi

echo "==> installing the nginx site"
sed "s/AUDIONOTES_HOSTNAME/$HOSTNAME_/g" "$HERE/nginx/audionotes.conf" \
  > "/etc/nginx/sites-available/$HOSTNAME_"
ln -sfn "/etc/nginx/sites-available/$HOSTNAME_" "/etc/nginx/sites-enabled/$HOSTNAME_"

echo "==> testing the whole nginx config"
# -t covers every site on this machine, not just ours. A broken file here would take down the
# other projects on reload, so nothing is reloaded until nginx itself says the set is valid.
nginx -t
systemctl reload nginx

echo "==> verifying over TLS"
curl -fsS --max-time 10 "https://$HOSTNAME_/healthz"
echo
echo "==> done: https://$HOSTNAME_"
