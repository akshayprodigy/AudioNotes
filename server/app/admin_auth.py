"""
Who may look at the customer list.

Two separate questions, deliberately kept apart:

* **Authentication** — are you who you say you are? Answered by `store.authenticate`, the same
  scrypt verification the account pages use. There is no second password store here, because a
  second place to keep credentials is a second place to get them wrong.
* **Authorisation** — are you allowed in here? Answered by an environment variable, not a database
  column. Anything that can write the database can grant itself a column; nothing that can write
  the database can edit the process environment.

The console is **off** unless both variables are set. An unset secret does not fall back to a
generated one and does not fall back to a default: it disables every route. A misconfigured deploy
must fail closed, and a signing secret with a default value is how a customer list ends up readable
by anyone who has read the source.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time

#: How long a signed-in operator stays signed in. Short enough that a forgotten open laptop stops
#: mattering by the next morning, long enough to get through a day's work without re-typing.
SESSION_SECONDS = 8 * 60 * 60


def _secret() -> str:
    return os.environ.get("ADMIN_SESSION_SECRET", "").strip()


def admin_emails() -> set[str]:
    raw = os.environ.get("VERBALE_ADMIN_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def enabled() -> bool:
    """Both halves, or nothing. See the module docstring."""
    return bool(_secret()) and bool(admin_emails())


def is_admin(email: str | None) -> bool:
    return bool(email) and email.strip().lower() in admin_emails()


def _sign(payload: str) -> str:
    return hmac.new(_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_cookie(email: str, now: int | None = None) -> str:
    """
    A signed statement that this email was authenticated, and when it stops counting.

    The expiry is inside the signed payload rather than left to the cookie's own Max-Age, because
    a cookie's lifetime is a request to the browser and the browser is the thing under the
    attacker's control.
    """
    expires = int(time.time() if now is None else now) + SESSION_SECONDS
    payload = f"{email.strip().lower()}|{expires}"
    return f"{payload}|{_sign(payload)}"


def read_cookie(value: str | None, now: int | None = None) -> str | None:
    """
    The email this cookie proves, or None.

    None for every failure — tampered, expired, signed with a different secret, malformed, or
    naming somebody who is no longer an admin. Callers get one answer to check, so there is no way
    to accidentally treat "expired" as "fine".
    """
    if not enabled() or not value:
        return None
    parts = value.split("|")
    if len(parts) != 3:
        return None
    email, expires_raw, signature = parts

    # Constant time, because a byte-by-byte comparison leaks how much of a forged signature was
    # right, and that is enough to construct the rest.
    if not hmac.compare_digest(_sign(f"{email}|{expires_raw}"), signature):
        return None
    try:
        expires = int(expires_raw)
    except ValueError:
        return None
    if int(time.time() if now is None else now) >= expires:
        return None

    # Re-checked on every request rather than trusted from the cookie: removing somebody from
    # VERBALE_ADMIN_EMAILS has to lock them out now, not in eight hours.
    if not is_admin(email):
        return None
    return email
