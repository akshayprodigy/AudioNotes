"""
Becoming entitled.

Purchases happen through Google Play Billing, inside the app, and nowhere else. That is not a
simplification imposed on the design — it is the shape of the business: one store, one payment
provider, one way to become a subscriber.

The client cannot be trusted with entitlement. A purchase token is a string and anyone can send a
string, so every one of them is checked against Google and only Google's answer is written down.
There is no path in this module by which a request can make itself paid.

Cancellation is here too, because it is the other half of the same guarantee: deleting an account
must stop the money as well as the record.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import play
from .store import Store, Subscription


def cancel_play_subscription(provider_id: str) -> tuple[bool, str | None]:
    """
    Cancel a subscription at Google, immediately.

    Used when an account is deleted, and it is the step that must not be skipped: deleting our row
    stops us knowing about a subscription, it does not stop Google charging the card. Somebody
    billed monthly for an account they deleted is the worst failure this system can produce, so the
    caller refuses to delete when this returns False.

    Two answers count as success, because in both of them there is no card left to stop:

    * The subscription is already cancelled or expired — it is in the state we wanted, and calling
      that a failure would strand the account forever, unable to be deleted.
    * Google has never heard of the token (404). A forged or long-dead purchase token cannot be
      cancelled and does not need to be.

    Everything else — a timeout, a 5xx, a revoked service account — is a *maybe*, and a maybe must
    refuse the deletion. The asymmetry is deliberate: refusing costs somebody a second attempt,
    while wrongly succeeding costs them money every month.
    """
    if not play.is_configured():
        return False, "Billing is not configured on this server."
    try:
        purchase = play.verify(provider_id)
    except play.PlayError as e:
        if e.status == 404:
            return True, None
        return False, str(e)

    if purchase.status == "cancelled":
        return True, None
    if not purchase.product_id:
        # Live, but Google returned no line items to name the product with. The URL cannot be
        # built, so the honest answer is that we could not cancel it.
        return False, "Google did not say which product this subscription is for."

    try:
        play.cancel(provider_id, purchase.product_id)
    except play.PlayError as e:
        if e.status == 404:
            return True, None
        return False, str(e)
    return True, None


@dataclass(frozen=True)
class LinkResult:
    status: int
    account_id: str | None = None
    error: str | None = None


def link_play_purchase(store: Store, purchase_token: str) -> LinkResult:
    """
    Turn a Play purchase token into an entitled account, creating one if this is a first purchase.

    Order matters throughout:

    **Verify before anything is written.** A token Google has never heard of must not create an
    account, or the table fills with rows conjured by anyone who can POST.

    **Follow linkedPurchaseToken.** When somebody upgrades a plan or resubscribes after lapsing,
    Google issues a NEW token and points it at the old one. Missing that link would strand the
    original account — the customer keeps their devices and their history on an account that no
    longer has a subscription, while a fresh empty account holds the thing they paid for.

    **Acknowledge last.** Google auto-refunds anything unacknowledged within three days, so it must
    happen — but only after entitlement is safely recorded. Acknowledging first and then failing to
    write would leave somebody paying for nothing, with Google satisfied they had been served.
    """
    if not play.is_configured():
        return LinkResult(status=503, error="Play Billing is not configured on this server.")
    if not purchase_token:
        return LinkResult(status=400, error="purchaseToken is required")

    try:
        purchase = play.verify(purchase_token)
    except play.PlayError as e:
        # 502, not 400: as far as we know the token may be perfectly good and Google unreachable.
        # The app retries, and nothing has been granted in the meantime.
        return LinkResult(status=502, error=str(e))

    if purchase.status == "none":
        # PENDING — a payment method still being authorised, which happens with some UPI mandates
        # and cash-based methods. Not an error, just not yet paid.
        return LinkResult(status=402, error="That purchase has not completed yet.")

    account_id = store.account_by_provider_id(purchase_token, provider="play")
    if account_id is None and purchase.linked_purchase_token:
        account_id = store.account_by_provider_id(purchase.linked_purchase_token, provider="play")
    if account_id is None:
        # No email, no password: Google has established who this is, and making somebody invent a
        # password to receive what they have just paid for is friction that buys nothing.
        account_id = store.create_account().id

    store.upsert_subscription(
        Subscription(
            account_id=account_id,
            plan="pro",
            provider="play",
            provider_id=purchase_token,
            status=purchase.status,
            # Deliberately not clamped to never move backwards: Google's answer IS the
            # truth here, it is fetched fresh rather than pushed, and it cannot arrive out of order.
            current_period_end=purchase.expires_at,
        )
    )

    if not purchase.acknowledged:
        try:
            play.acknowledge(purchase_token, purchase.product_id)
        except play.PlayError:
            # Entitlement is already recorded, so the customer has what they paid for. A failed
            # acknowledgement is retried on their next licence refresh, well inside Google's three
            # days — and refusing here would take away access over a bookkeeping call.
            pass

    return LinkResult(status=200, account_id=account_id)


def refresh_play_subscription(store: Store, account_id: str) -> None:
    """
    Re-ask Google what a Play subscription is worth, and record the answer.

    Called on every licence refresh, which is what lets cancellations and expiries propagate with
    no real-time notifications, no Pub/Sub topic and no service to keep running. The app refreshes
    about weekly and a token lasts a fortnight, so the worst case is a cancelled subscriber keeping
    Pro slightly longer — which is the direction to err in.

    Silent on failure. A Google outage must not revoke a paying customer, and their existing token
    keeps working until it expires either way.
    """
    sub = store.subscription(account_id)
    if sub.provider != "play" or not sub.provider_id:
        return
    try:
        purchase = play.verify(sub.provider_id)
    except play.PlayError:
        return

    store.upsert_subscription(
        Subscription(
            account_id=account_id, plan="pro", provider="play",
            provider_id=sub.provider_id, status=purchase.status,
            current_period_end=purchase.expires_at,
        )
    )
    if not purchase.acknowledged:
        try:
            play.acknowledge(sub.provider_id, purchase.product_id)
        except play.PlayError:
            pass
