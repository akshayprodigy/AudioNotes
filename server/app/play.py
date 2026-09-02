"""
Google Play Billing: verifying that somebody actually paid.

The app hands us a purchase token. That token is worth nothing on its own — anyone can send a
string — so it is checked against Google's Android Publisher API, and only Google's answer decides
entitlement. This is the one thing in the system that may mark a
subscription paid.

## Why there is no Google client library here

One endpoint, one OAuth scope. `google-api-python-client` would pull a large transitive tree into a
server that holds a permanent signing key, to save about forty lines of well-understood JWT bearer
flow. The dependency surface of this particular process is worth keeping auditable.

## Acknowledgement is not optional

Google refunds any purchase not acknowledged within three days. Doing it here rather than in the
app is deliberate: the client can be killed, lose its network, or be uninstalled between paying and
acknowledging, and the user gets a silent refund and a broken subscription. The server acknowledges
immediately after it has granted entitlement, which is the only order that cannot strand somebody
who has paid.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/androidpublisher"
API = "https://androidpublisher.googleapis.com/androidpublisher/v3"

#: Refresh the access token this long before it actually expires, so a call never races the clock.
_EARLY_REFRESH_SECONDS = 120


class PlayError(RuntimeError):
    """Google said no, or could not be reached. Never a reason to grant entitlement."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        #: The HTTP status Google answered with, or None when Google was never reached.
        #:
        #: Carried as a number because callers have to tell a settled fact (404 — no such
        #: subscription, there is nothing to cancel) from a transient one (5xx, a timeout — try
        #: again, and refuse to delete the account meanwhile). The alternative is matching on the
        #: text of a message, which works until Google rewords it.
        self.status = status


@dataclass(frozen=True)
class PlaySubscription:
    """Google's answer, reduced to what entitlement actually needs."""

    #: One of our statuses: active | past_due | cancelled | none.
    status: str
    #: Seconds. When the paid period ends.
    expires_at: int
    product_id: str
    acknowledged: bool
    #: Set when this purchase replaces an earlier one (an upgrade, or a resubscribe). The old token
    #: stops working and the account must be moved across, or the customer loses what they paid for.
    linked_purchase_token: str | None


def package_name() -> str:
    return os.environ.get("PLAY_PACKAGE_NAME", "")


def is_configured() -> bool:
    return bool(os.environ.get("PLAY_SERVICE_ACCOUNT_JSON") and package_name())


def _service_account() -> dict:
    raw = os.environ.get("PLAY_SERVICE_ACCOUNT_JSON")
    if not raw:
        raise PlayError("PLAY_SERVICE_ACCOUNT_JSON is not set")
    # Accept either the JSON itself or a path to it, because secret managers differ on which is
    # easier and being wrong about it is a confusing failure at boot.
    if raw.strip().startswith("{"):
        return json.loads(raw)
    with open(raw, encoding="utf-8") as f:
        return json.load(f)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


_token_lock = threading.Lock()
_cached_token: tuple[str, float] | None = None


def _access_token(now: float | None = None) -> str:
    """
    A short-lived OAuth token for the Android Publisher API, via the JWT bearer flow.

    Cached until shortly before it expires. Without the cache every licence refresh would cost two
    round trips to Google instead of one, and Google rate-limits the token endpoint far harder than
    the API itself.
    """
    global _cached_token
    now = time.time() if now is None else now

    with _token_lock:
        if _cached_token and _cached_token[1] - _EARLY_REFRESH_SECONDS > now:
            return _cached_token[0]

        account = _service_account()
        issued = int(now)
        claims = {
            "iss": account["client_email"],
            "scope": SCOPE,
            "aud": TOKEN_URL,
            "iat": issued,
            "exp": issued + 3600,
        }
        header = {"alg": "RS256", "typ": "JWT"}
        signing_input = (
            f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}."
            f"{_b64url(json.dumps(claims, separators=(',', ':')).encode())}"
        )
        key = serialization.load_pem_private_key(
            account["private_key"].encode("utf-8"), password=None
        )
        signature = key.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
        assertion = f"{signing_input}.{_b64url(signature)}"

        body = urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        }).encode()
        try:
            with urllib.request.urlopen(
                urllib.request.Request(
                    TOKEN_URL, data=body,
                    headers={"content-type": "application/x-www-form-urlencoded"},
                ),
                timeout=20,
            ) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as e:
            raise PlayError(f"Google refused the service account: {e.read().decode()[:300]}") from e
        except (urllib.error.URLError, OSError) as e:
            raise PlayError(f"could not reach Google: {e}") from e

        token = payload["access_token"]
        _cached_token = (token, now + float(payload.get("expires_in", 3600)))
        return token


def _get(path: str) -> dict:
    request = urllib.request.Request(
        f"{API}{path}", headers={"authorization": f"Bearer {_access_token()}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        # 404 means Google has never heard of this token. That is a forged or stale string, not a
        # transient failure, and it must not be retried into an entitlement.
        raise PlayError(f"Play API {e.code}: {detail}", status=e.code) from e
    except (urllib.error.URLError, OSError) as e:
        raise PlayError(f"could not reach Google: {e}") from e


def _post(path: str, body: dict) -> None:
    request = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode(),
        headers={"authorization": f"Bearer {_access_token()}", "content-type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=20).read()
    except urllib.error.HTTPError as e:
        raise PlayError(f"Play API {e.code}: {e.read().decode()[:300]}", status=e.code) from e
    except (urllib.error.URLError, OSError) as e:
        raise PlayError(f"could not reach Google: {e}") from e


#: Google's subscription states, mapped onto ours.
#:
#: IN_GRACE_PERIOD is Google retrying a failed payment, and the customer keeps working throughout.
#: ON_HOLD is after those retries have failed; it maps
#: to past_due too, but its expiry has already passed, so entitlement ends on the date rather than
#: on the label. PAUSED is a subscription the user deliberately suspended: not cancelled, but not
#: entitled either, which `cancelled` with a past expiry expresses exactly.
_STATES = {
    "SUBSCRIPTION_STATE_ACTIVE": "active",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD": "past_due",
    "SUBSCRIPTION_STATE_ON_HOLD": "past_due",
    "SUBSCRIPTION_STATE_CANCELED": "cancelled",
    "SUBSCRIPTION_STATE_EXPIRED": "cancelled",
    "SUBSCRIPTION_STATE_PAUSED": "cancelled",
    "SUBSCRIPTION_STATE_PENDING": "none",
    "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED": "none",
    "SUBSCRIPTION_STATE_UNSPECIFIED": "none",
}


def _rfc3339_to_epoch(value: str) -> int:
    """
    Google returns RFC 3339 with nanoseconds and a trailing Z.

    `fromisoformat` handles neither on older Pythons: it wants at most microseconds, and it wants
    +00:00 rather than Z. Truncating rather than rounding is right — an expiry a few hundred
    nanoseconds early has never mattered to anyone.
    """
    if not value:
        return 0
    text = value.rstrip("Z")
    if "." in text:
        head, _, frac = text.partition(".")
        text = f"{head}.{frac[:6]}"
    return int(datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp())


def parse_subscription(payload: dict) -> PlaySubscription:
    """Reduce Google's subscriptionPurchaseV2 to what entitlement needs. Pure, so it is testable."""
    state = str(payload.get("subscriptionState") or "SUBSCRIPTION_STATE_UNSPECIFIED")
    line_items = payload.get("lineItems") or []
    # The latest expiry across line items: a subscription with an add-on has more than one, and the
    # customer keeps access until the last of them ends.
    expiry = max((_rfc3339_to_epoch(str(i.get("expiryTime") or "")) for i in line_items), default=0)
    product = str(line_items[0].get("productId") or "") if line_items else ""
    return PlaySubscription(
        status=_STATES.get(state, "none"),
        expires_at=expiry,
        product_id=product,
        acknowledged=str(payload.get("acknowledgementState") or "")
        == "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
        linked_purchase_token=payload.get("linkedPurchaseToken") or None,
    )


def verify(purchase_token: str) -> PlaySubscription:
    """Ask Google what this purchase token is worth. Raises rather than guessing."""
    if not is_configured():
        raise PlayError(
            "Play Billing is not configured on this server "
            "(PLAY_SERVICE_ACCOUNT_JSON, PLAY_PACKAGE_NAME)."
        )
    quoted = urllib.parse.quote(purchase_token, safe="")
    return parse_subscription(
        _get(f"/applications/{package_name()}/purchases/subscriptionsv2/tokens/{quoted}")
    )


def acknowledge(purchase_token: str, product_id: str) -> None:
    """
    Tell Google the purchase was honoured.

    Google auto-refunds anything unacknowledged after three days. Called after entitlement has been
    granted, never before: acknowledging first and then failing to grant would leave somebody paying
    for nothing, with Google satisfied that they had been served.
    """
    quoted = urllib.parse.quote(purchase_token, safe="")
    _post(
        f"/applications/{package_name()}/purchases/subscriptions/"
        f"{urllib.parse.quote(product_id, safe='')}/tokens/{quoted}:acknowledge",
        {},
    )


def cancel(purchase_token: str, product_id: str) -> None:
    """
    Cancel a subscription at Google, effective at the end of the period already paid for.

    Called when an account is deleted. Deleting our row stops us knowing about a subscription; it
    does not stop Google charging the card, and somebody billed for an account they deleted is the
    worst thing this system can do to a person.

    Google does not refund the remainder and neither should we pretend to: the subscription stops
    renewing and runs to its existing expiry. That is what `cancel` means on Play, and it is why
    the caller may delete the account immediately afterwards without stranding anybody's money.
    """
    quoted = urllib.parse.quote(purchase_token, safe="")
    _post(
        f"/applications/{package_name()}/purchases/subscriptions/"
        f"{urllib.parse.quote(product_id, safe='')}/tokens/{quoted}:cancel",
        {},
    )
