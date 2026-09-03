"""
Deleting an account.

Play requires it, and it is simply correct: an account somebody cannot get rid of is not theirs.
The interesting case is not the delete — it is refusing to delete when the card could still be
charged afterwards.

There is no web page for this any more. The site is a landing page, subscriptions are bought in
the app through Google Play, and a deletion request arrives by email and is honoured with
`deploy/delete-account.sh`. So the guarantee is tested where it now lives: one function, rather
than an ordering each caller has to remember.
"""

import pytest

from app import billing
from app.billing import delete_account_with_subscription
from app.store import Subscription


@pytest.fixture
def cancels(monkeypatch):
    """Record cancellation attempts, and succeed."""
    calls: list[str] = []
    monkeypatch.setattr(billing, "cancel_play_subscription",
                        lambda pid: (calls.append(pid) or (True, None)))
    return calls


@pytest.fixture
def refuses(monkeypatch):
    """Google will not confirm the cancellation."""
    monkeypatch.setattr(billing, "cancel_play_subscription",
                        lambda pid: (False, "Google is down"))


def subscribed(store, status="active", provider_id="tok_x"):
    account = store.create_account("a@example.com", "password123")
    store.upsert_subscription(
        Subscription(account_id=account.id, plan="pro", provider_id=provider_id,
                     status=status, current_period_end=2_000_000_000)
    )
    return account


# ---- the guarantee ----

def test_nothing_is_deleted_when_the_subscription_will_not_cancel(store, refuses):
    """Being billed for an account you deleted is the worst thing this system could do."""
    account = subscribed(store)
    ok, error = delete_account_with_subscription(store, account.id)
    assert ok is False and "Google is down" in error
    assert store.account_by_email("a@example.com") is not None, "the account survived, as it must"
    assert store.subscription(account.id).status == "active", "and so did its subscription"


def test_a_paid_account_is_cancelled_before_it_is_deleted(store, cancels):
    account = subscribed(store)
    assert delete_account_with_subscription(store, account.id) == (True, None)
    assert cancels == ["tok_x"]
    assert store.account_by_email("a@example.com") is None


def test_a_past_due_subscription_is_also_cancelled(store, cancels):
    """past_due still renews. It is exactly the state where forgetting to cancel costs money."""
    account = subscribed(store, status="past_due")
    assert delete_account_with_subscription(store, account.id) == (True, None)
    assert cancels == ["tok_x"]


def test_a_cancelled_subscription_is_not_cancelled_again(store, cancels):
    account = subscribed(store, status="cancelled")
    assert delete_account_with_subscription(store, account.id) == (True, None)
    assert cancels == [], "there is nothing left to stop"


def test_a_free_account_is_deleted_without_asking_google_anything(store, cancels):
    account = store.create_account("free@example.com", "password123")
    assert delete_account_with_subscription(store, account.id) == (True, None)
    assert cancels == []
    assert store.account_by_email("free@example.com") is None


# ---- what deletion takes with it ----

def test_deleting_takes_the_devices_and_subscription_with_it(store, cancels):
    """The foreign keys cascade. Without PRAGMA foreign_keys=ON they would silently orphan."""
    account = subscribed(store)
    store.touch_device(account.id, "phone")
    store.touch_device(account.id, "tablet")

    delete_account_with_subscription(store, account.id)

    assert store.devices(account.id) == []
    assert store._db.execute(
        "SELECT COUNT(*) AS n FROM subscriptions WHERE account_id=?", (account.id,)
    ).fetchone()["n"] == 0


def test_the_email_is_free_to_register_again(store, cancels):
    account = subscribed(store)
    delete_account_with_subscription(store, account.id)
    again = store.create_account("a@example.com", "password123")
    assert again.id != account.id


def test_deleting_an_unknown_account_is_not_an_error(store, cancels):
    """It has no subscription, so there is nothing to cancel and nothing to remove."""
    assert delete_account_with_subscription(store, "no-such-id") == (True, None)
