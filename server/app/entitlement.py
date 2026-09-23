"""
Deciding what to mint, and for how long.

The app verifies a token offline and keeps working until it expires, so the expiry is not a detail --
it is the exact length of time a cancelled subscriber keeps the paid features, and the exact length
of time a legitimate subscriber survives without a network. Both directions are paid for here.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric import ec

from .licence import DEFAULT_TTL_SECONDS, mint_token
from .store import Store, Subscription

#: How long past the paid-through date a token may still be minted.
#:
#: Card renewals fail for boring reasons -- an expired card, a bank's fraud heuristic, a daily limit.
#: Google's own handling covers most of it: while it retries, the subscription is IN_GRACE_PERIOD
#: and the expiry it reports is still in the future, so this window is never even reached. It bites
#: only after those retries fail and the subscription goes ON_HOLD with an expiry already past.
#:
#: Three days there is deliberate. Cutting someone off at the exact second their period ends would
#: punish them for their bank's behaviour, in an app they are mid-meeting with; Google's hold can
#: run for thirty days, and matching that would turn a failed payment into a free month.
PAYMENT_GRACE_SECONDS = 3 * 24 * 60 * 60


@dataclass(frozen=True)
class Issued:
    token: str
    plan: str
    expires_at: int


def is_entitled(sub: Subscription, now: int) -> bool:
    """Whether a subscription is currently worth minting against."""
    if sub.status == "active":
        return True
    # past_due is still entitled, but only inside the grace window -- that is what past_due means.
    if sub.status == "past_due":
        return now < sub.current_period_end + PAYMENT_GRACE_SECONDS
    # A cancelled subscription runs to the end of the period already paid for. Taking it away at the
    # moment of cancelling would be charging for time and then not giving it.
    if sub.status == "cancelled":
        return now < sub.current_period_end
    return False


def issue(
    store: Store,
    signing_key: ec.EllipticCurvePrivateKey,
    account_id: str,
    device_id: str,
    now: int | None = None,
) -> Issued | None:
    """
    Mint a licence for one device, or return None if the account is not entitled.

    The token never outlives the paid period plus its grace, so a subscription that lapses cannot be
    extended by asking for a fresh token the day before it ends.
    """
    now = int(time.time()) if now is None else now
    sub = store.subscription(account_id)
    if not is_entitled(sub, now):
        return None
    if not store.touch_device(account_id, device_id):
        return None

    # The grace is for a payment that may still go through. A cancellation has none coming --
    # is_entitled already refuses it grace -- so its token ends with the period, and a Play trial
    # cancelled on day two ends with the trial.
    grace = PAYMENT_GRACE_SECONDS if sub.status in ("active", "past_due") else 0
    ceiling = sub.current_period_end + grace
    ttl = min(DEFAULT_TTL_SECONDS, max(0, ceiling - now))
    if ttl <= 0:
        return None

    return Issued(
        token=mint_token(
            signing_key,
            account=account_id,
            plan=sub.plan,
            device_id=device_id,
            issued_at=now,
            ttl_seconds=ttl,
        ),
        plan=sub.plan,
        expires_at=now + ttl,
    )
