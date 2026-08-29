"""
Deleting an account.

Play requires this, and it is also simply correct: an account somebody cannot get rid of is not
theirs. The interesting case is not the delete — it is refusing to delete when the card could
still be charged afterwards.
"""

import pytest
from fastapi.testclient import TestClient

from app import pages
from app.main import create_app
from app.store import Subscription


@pytest.fixture
def client(store, signing_key):
    return TestClient(create_app(store=store, signing_key=signing_key))


@pytest.fixture
def cancels(monkeypatch):
    """Record cancellation attempts, and succeed."""
    calls: list[str] = []
    monkeypatch.setattr(pages, "cancel_subscription",
                        lambda pid: (calls.append(pid) or (True, None)))
    return calls


def subscribed(store, status="active"):
    account = store.create_account("a@example.com", "password123")
    store.upsert_subscription(
        Subscription(account_id=account.id, plan="pro", provider_id="sub_x",
                     status=status, current_period_end=2_000_000_000)
    )
    return account


def delete(client, password="password123"):
    return client.post("/account/delete", data={"email": "a@example.com", "password": password})


def test_the_account_page_offers_deletion(client, store):
    store.create_account("a@example.com", "password123")
    r = client.post("/account", data={"email": "a@example.com", "password": "password123"})
    assert "/account/delete" in r.text and "Delete my account" in r.text


def test_the_delete_form_carries_the_signed_in_address(client, store):
    """It is an f-string in a page of f-strings; a literal {email} would ship silently."""
    store.create_account("a@example.com", "password123")
    r = client.post("/account", data={"email": "a@example.com", "password": "password123"})
    assert "{email}" not in r.text
    assert 'name="email" value="a@example.com"' in r.text


def test_deleting_needs_the_password(client, store):
    account = store.create_account("a@example.com", "password123")
    assert delete(client, "wrong").status_code == 401
    assert store.account_by_email("a@example.com") is not None
    assert account is not None


def test_a_free_account_is_deleted_without_touching_the_provider(client, store, cancels):
    store.create_account("a@example.com", "password123")
    assert delete(client).status_code == 200
    assert store.account_by_email("a@example.com") is None
    assert cancels == [], "there was no subscription to cancel"


def test_a_paid_account_is_cancelled_before_it_is_deleted(client, store, cancels):
    subscribed(store)
    assert delete(client).status_code == 200
    assert cancels == ["sub_x"]
    assert store.account_by_email("a@example.com") is None


def test_a_past_due_subscription_is_also_cancelled(client, store, cancels):
    """past_due still has a live mandate at the provider; the retries have not stopped."""
    subscribed(store, status="past_due")
    delete(client)
    assert cancels == ["sub_x"]


def test_nothing_is_deleted_when_the_provider_will_not_cancel(client, store, monkeypatch):
    """Being billed for an account you deleted is the worst thing this system could do."""
    monkeypatch.setattr(pages, "cancel_subscription", lambda pid: (False, "Razorpay is down"))
    subscribed(store)
    r = delete(client)
    assert r.status_code == 502
    assert "Razorpay is down" in r.text
    assert store.account_by_email("a@example.com") is not None, "the account survived, as it must"


def test_deleting_takes_the_devices_and_subscription_with_it(client, store, cancels):
    account = subscribed(store)
    store.touch_device(account.id, "d1")
    store.touch_device(account.id, "d2")
    store.create_password_reset(account.id)
    delete(client)

    # Read past the API: the point is that the foreign keys actually cascaded.
    with store._lock:  # noqa: SLF001
        for table in ("subscriptions", "devices", "password_resets"):
            left = store._db.execute(  # noqa: SLF001
                f"SELECT COUNT(*) AS n FROM {table} WHERE account_id=?", (account.id,)
            ).fetchone()["n"]
            assert left == 0, f"{table} still has rows for a deleted account"


def test_a_deleted_account_cannot_sign_in_again(client, store, cancels):
    subscribed(store)
    delete(client)
    r = client.post("/api/account/signin",
                    json={"email": "a@example.com", "password": "password123", "deviceId": "d1"})
    assert r.status_code == 401


def test_the_email_is_free_to_register_again(client, store, cancels):
    store.create_account("a@example.com", "password123")
    delete(client)
    r = client.post("/api/account/signup",
                    json={"email": "a@example.com", "password": "password123"})
    assert r.status_code == 200
