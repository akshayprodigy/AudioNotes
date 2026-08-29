"""
Razorpay subscriptions.

Bought on the web rather than through Play Billing, because the app ships to more than the Play
Store, because a desktop build cannot use Play Billing at all, and because one entitlement service is
simpler than one-and-a-half. The trade is that we own the subscription lifecycle: renewals, failed
payments, cancellations. That is what the webhook below is.

The app never opens any of this. It signs in; the buying happens on the web, in a browser, where
store policy has nothing to say about it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from dataclasses import dataclass

from .store import Store, Subscription


def plan_id() -> str:
    return os.environ.get("RAZORPAY_PLAN_ID", "")


def _client():
    key_id = os.environ.get("RAZORPAY_KEY_ID")
    key_secret = os.environ.get("RAZORPAY_KEY_SECRET")
    if not key_id or not key_secret:
        return None
    import razorpay  # imported lazily so the server runs without billing configured

    return razorpay.Client(auth=(key_id, key_secret))


def webhook_signature_matches(body: bytes, signature: str, secret: str) -> bool:
    """HMAC-SHA256 of the RAW body, compared in constant time."""
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def map_status(status: str) -> str:
    """
    Map a Razorpay subscription status onto ours.

    Razorpay has more states than the entitlement question needs. ``halted`` means retries have been
    exhausted, which is a harder stop than ``pending``; both are past_due to us, and the difference
    that matters -- how long the grace lasts -- is decided by the period end, not the label.
    """
    if status in ("active", "authenticated"):
        return "active"
    if status in ("pending", "halted"):
        return "past_due"
    if status in ("cancelled", "completed", "expired"):
        return "cancelled"
    return "none"


@dataclass(frozen=True)
class SubscribeResult:
    status: int
    subscription_id: str | None = None
    checkout_url: str | None = None
    error: str | None = None


def start_subscription(store: Store, email: str, password: str) -> SubscribeResult:
    """
    Start a subscription and return Razorpay's hosted checkout URL to redirect to.

    The hosted page rather than an embedded checkout: it handles UPI AutoPay, cards, netbanking and
    their respective failure paths, all of which we would otherwise be reimplementing and getting
    subtly wrong on somebody's bank.

    A plain function, called directly by both the JSON endpoint and the HTML form, because a server
    that reaches its own API over HTTP breaks the moment it sits behind a reverse proxy answering on
    a different hostname than it believes it has.
    """
    rzp = _client()
    plan = plan_id()
    if rzp is None or not plan:
        return SubscribeResult(
            status=503,
            error="Billing is not configured on this server (RAZORPAY_KEY_ID, "
            "RAZORPAY_KEY_SECRET, RAZORPAY_PLAN_ID).",
        )
    account = store.authenticate(email, password)
    if account is None:
        return SubscribeResult(status=401, error="Email or password is incorrect")

    try:
        subscription = rzp.subscription.create(
            {
                "plan_id": plan,
                # 120 monthly cycles -- Razorpay requires a finite count, and ten years is long
                # enough that nobody reaches it before we have changed something else.
                "total_count": 120,
                "customer_notify": 1,
                "notes": {"accountId": account.id, "email": account.email},
            }
        )
    except Exception as e:  # noqa: BLE001 -- the SDK raises several unrelated types
        return SubscribeResult(status=502, error=str(e) or "Could not start the subscription")

    # Recorded as pending BEFORE the user pays, so the webhook that follows can find the account
    # from the subscription id. A payment whose account we cannot identify is a support ticket and
    # a refund.
    store.upsert_subscription(
        Subscription(
            account_id=account.id,
            plan="pro",
            provider_id=subscription["id"],
            status="none",
            current_period_end=0,
        )
    )
    return SubscribeResult(
        status=200,
        subscription_id=subscription["id"],
        checkout_url=subscription.get("short_url"),
    )


def apply_webhook(store: Store, raw: bytes, signature: str, event_id: str) -> tuple[int, str]:
    """
    Razorpay's webhook. The only thing that may mark a subscription paid.

    Never trust a redirect back from a checkout page to mean payment succeeded -- a browser can be
    pointed anywhere by anyone. The webhook is signed, and it is what moves money into entitlement.

    Returns the HTTP status and body to send back.
    """
    secret = os.environ.get("RAZORPAY_WEBHOOK_SECRET")
    if not secret:
        return 503, "webhook not configured"
    if not webhook_signature_matches(raw, signature, secret):
        return 400, "bad signature"

    try:
        event = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return 400, "bad json"

    # Razorpay retries on any non-2xx, so the same charge can arrive twice. Claiming the event id
    # first means a retry is acknowledged without extending the period a second time.
    if event_id and not store.claim_event(event_id):
        return 200, "duplicate"

    entity = (event.get("payload") or {}).get("subscription", {}).get("entity")
    if not entity:
        return 200, "ignored"

    provider_id = str(entity.get("id") or "")
    account_id = store.account_by_provider_id(provider_id) if provider_id else None
    if not account_id:
        # 200, not an error: retrying will not make an unknown subscription known, and a webhook
        # Razorpay keeps retrying forever is noise that hides real failures.
        return 200, "unknown subscription"

    status = map_status(str(entity.get("status") or ""))
    try:
        period_end = int(entity.get("current_end") or entity.get("end_at") or 0)
    except (TypeError, ValueError):
        period_end = 0
    existing = store.subscription(account_id)

    store.upsert_subscription(
        Subscription(
            account_id=account_id,
            plan="pro",
            provider_id=provider_id,
            status=status,
            # Never move the paid-through date backwards. Events can arrive out of order, and the
            # version that does move it back takes away time somebody has already paid for.
            current_period_end=max(existing.current_period_end, period_end),
        )
    )
    return 200, "ok"


def cancel_subscription(provider_id: str) -> tuple[bool, str | None]:
    """
    Cancel a subscription at Razorpay, immediately.

    Used when an account is deleted. This is the step that must not be skipped: deleting our row
    stops us knowing about a subscription, it does not stop Razorpay charging the card. Somebody
    billed monthly for an account they deleted is the worst failure this system can produce, so
    the caller refuses to delete when this returns False.

    A subscription already cancelled or completed reports success — it is in the state we wanted,
    and treating "already done" as a failure would strand the account forever.
    """
    rzp = _client()
    if rzp is None:
        return False, "Billing is not configured on this server."
    try:
        rzp.subscription.cancel(provider_id, {"cancel_at_cycle_end": 0})
        return True, None
    except Exception as e:  # noqa: BLE001 -- the SDK raises several unrelated types
        message = str(e)
        if any(word in message.lower() for word in ("cancelled", "completed", "not found")):
            return True, None
        return False, message or "Could not cancel the subscription"
