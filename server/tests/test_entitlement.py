"""
How long a token lasts, which is the whole product decision expressed as arithmetic.

The expiry is simultaneously how long a cancelled subscriber keeps paid features and how long a
paying subscriber survives with no network. Both directions are asserted here.
"""

import base64

from app.entitlement import PAYMENT_GRACE_SECONDS, Issued, is_entitled, issue
from app.licence import DEFAULT_TTL_SECONDS
from app.store import DEVICE_LIMIT, Subscription

DAY = 24 * 60 * 60
NOW = 1_800_000_000


def sub(status: str, period_end: int) -> Subscription:
    return Subscription(
        account_id="acct_1", plan="pro", provider_id="sub_x", status=status,
        current_period_end=period_end,
    )


def test_active_is_entitled():
    assert is_entitled(sub("active", NOW + DAY), NOW)


def test_none_is_never_entitled():
    assert not is_entitled(sub("none", NOW + 999 * DAY), NOW)


def test_past_due_survives_the_grace_window_and_not_a_second_longer():
    s = sub("past_due", NOW)
    assert is_entitled(s, NOW + PAYMENT_GRACE_SECONDS - 1)
    assert not is_entitled(s, NOW + PAYMENT_GRACE_SECONDS)


def test_cancelled_runs_to_the_end_of_the_period_already_paid_for():
    s = sub("cancelled", NOW + DAY)
    assert is_entitled(s, NOW)
    assert not is_entitled(s, NOW + DAY)


def test_cancelled_gets_no_grace_on_top():
    """The grace is for a payment that may still succeed. A cancellation is not one."""
    assert not is_entitled(sub("cancelled", NOW), NOW + 1)


def _exp(issued: Issued) -> int:
    body = issued.token.partition(".")[0]
    payload = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)).decode("ascii")
    return int(dict(p.split("=", 1) for p in payload.split(";"))["exp"])


def _entitled_account(store, period_end=NOW + 365 * DAY, status="active"):
    account = store.create_account("a@example.com", "password123")
    store.upsert_subscription(
        Subscription(account_id=account.id, plan="pro", provider_id="sub_x", status=status,
                     current_period_end=period_end)
    )
    return account


def test_an_unentitled_account_gets_nothing(store, signing_key):
    account = store.create_account("a@example.com", "password123")
    assert issue(store, signing_key, account.id, "dev_1", NOW) is None


def test_a_token_never_outlives_the_paid_period_plus_grace(store, signing_key):
    """Otherwise a fortnight's token bought the day before expiry extends the subscription for free."""
    account = _entitled_account(store, period_end=NOW + DAY)
    issued = issue(store, signing_key, account.id, "dev_1", NOW)
    assert issued is not None
    assert issued.expires_at == NOW + DAY + PAYMENT_GRACE_SECONDS
    assert _exp(issued) == issued.expires_at


def test_a_long_subscription_still_only_mints_a_fortnight(store, signing_key):
    issued = issue(store, signing_key, _entitled_account(store).id, "dev_1", NOW)
    assert issued is not None
    assert issued.expires_at == NOW + DEFAULT_TTL_SECONDS


def test_the_expiry_in_the_token_matches_the_one_reported_to_the_app(store, signing_key):
    issued = issue(store, signing_key, _entitled_account(store).id, "dev_1", NOW)
    assert _exp(issued) == issued.expires_at


def test_a_device_over_the_limit_gets_no_token(store, signing_key):
    account = _entitled_account(store)
    for i in range(DEVICE_LIMIT):
        assert issue(store, signing_key, account.id, f"dev_{i}", NOW) is not None
    assert issue(store, signing_key, account.id, "one_too_many", NOW) is None


def test_a_known_device_keeps_working_at_the_limit(store, signing_key):
    """Reinstalling the app must never be the thing that locks someone out of their subscription."""
    account = _entitled_account(store)
    for i in range(DEVICE_LIMIT):
        issue(store, signing_key, account.id, f"dev_{i}", NOW)
    assert issue(store, signing_key, account.id, "dev_0", NOW) is not None
