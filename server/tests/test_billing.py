"""
The webhook, which is the only thing in this system that may say somebody has paid.

Everything here is about not trusting the network: a forged body, a replayed retry, events that
arrive out of order, an entity for a subscription we have never heard of.
"""

import hashlib
import hmac
import json

import pytest

from app.billing import apply_webhook, map_status, webhook_signature_matches
from app.store import Subscription

SECRET = "whsec_test"


@pytest.fixture(autouse=True)
def webhook_secret(monkeypatch):
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", SECRET)


def signed(body: dict) -> tuple[bytes, str]:
    raw = json.dumps(body).encode()
    return raw, hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()


def event(status: str, current_end: int, sub_id: str = "sub_x") -> dict:
    return {
        "event": "subscription.charged",
        "payload": {"subscription": {"entity": {"id": sub_id, "status": status,
                                                "current_end": current_end}}},
    }


def subscribed(store, provider_id="sub_x"):
    account = store.create_account("a@example.com", "password123")
    store.upsert_subscription(
        Subscription(account_id=account.id, plan="pro", provider_id=provider_id,
                     status="none", current_period_end=0)
    )
    return account


def test_a_correct_signature_matches():
    raw, sig = signed({"a": 1})
    assert webhook_signature_matches(raw, sig, SECRET)


def test_a_body_altered_after_signing_does_not_match():
    raw, sig = signed({"a": 1})
    assert not webhook_signature_matches(raw + b" ", sig, SECRET)


def test_a_signature_of_the_wrong_length_does_not_crash():
    raw, _ = signed({"a": 1})
    assert not webhook_signature_matches(raw, "short", SECRET)
    assert not webhook_signature_matches(raw, "", SECRET)


def test_an_unsigned_webhook_is_refused(store):
    raw = json.dumps(event("active", 100)).encode()
    assert apply_webhook(store, raw, "deadbeef", "evt_1")[0] == 400


def test_a_forged_body_cannot_grant_a_subscription(store):
    account = subscribed(store)
    raw = json.dumps(event("active", 999_999)).encode()
    apply_webhook(store, raw, "not-the-signature", "evt_1")
    assert store.subscription(account.id).status == "none"


def test_a_paid_event_marks_the_subscription_active(store):
    account = subscribed(store)
    raw, sig = signed(event("active", 1_800_000_000))
    assert apply_webhook(store, raw, sig, "evt_1") == (200, "ok")
    sub = store.subscription(account.id)
    assert sub.status == "active"
    assert sub.current_period_end == 1_800_000_000


def test_a_retried_event_does_not_apply_twice(store):
    subscribed(store)
    raw, sig = signed(event("active", 1_800_000_000))
    assert apply_webhook(store, raw, sig, "evt_1") == (200, "ok")
    assert apply_webhook(store, raw, sig, "evt_1") == (200, "duplicate")


def test_the_paid_through_date_never_moves_backwards(store):
    """Events arrive out of order, and the version that moves it back takes away paid-for time."""
    account = subscribed(store)
    later, later_sig = signed(event("active", 2_000_000_000))
    earlier, earlier_sig = signed(event("active", 1_000_000_000))
    apply_webhook(store, later, later_sig, "evt_late")
    apply_webhook(store, earlier, earlier_sig, "evt_early")
    assert store.subscription(account.id).current_period_end == 2_000_000_000


def test_an_event_for_an_unknown_subscription_is_acknowledged_not_retried(store):
    """Retrying will not make an unknown subscription known; a forever-retry hides real failures."""
    raw, sig = signed(event("active", 100, sub_id="sub_nobody"))
    assert apply_webhook(store, raw, sig, "evt_1") == (200, "unknown subscription")


def test_an_event_with_no_subscription_entity_is_ignored(store):
    raw, sig = signed({"event": "payment.captured", "payload": {"payment": {"entity": {}}}})
    assert apply_webhook(store, raw, sig, "evt_1") == (200, "ignored")


def test_a_signed_body_that_is_not_json_is_a_bad_request(store):
    raw = b"{not json"
    sig = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    assert apply_webhook(store, raw, sig, "evt_1") == (400, "bad json")


def test_an_unconfigured_webhook_says_so_rather_than_accepting_anything(store, monkeypatch):
    monkeypatch.delenv("RAZORPAY_WEBHOOK_SECRET")
    raw, sig = signed(event("active", 100))
    assert apply_webhook(store, raw, sig, "evt_1")[0] == 503


def test_end_at_is_read_when_current_end_is_absent(store):
    account = subscribed(store)
    body = event("active", 0)
    entity = body["payload"]["subscription"]["entity"]
    del entity["current_end"]
    entity["end_at"] = 1_900_000_000
    raw, sig = signed(body)
    apply_webhook(store, raw, sig, "evt_1")
    assert store.subscription(account.id).current_period_end == 1_900_000_000


@pytest.mark.parametrize(
    "razorpay_status,ours",
    [
        ("active", "active"), ("authenticated", "active"),
        ("pending", "past_due"), ("halted", "past_due"),
        ("cancelled", "cancelled"), ("completed", "cancelled"), ("expired", "cancelled"),
        ("created", "none"), ("anything_new", "none"),
    ],
)
def test_razorpay_statuses_map_onto_ours(razorpay_status, ours):
    assert map_status(razorpay_status) == ours


def test_a_halted_subscription_becomes_past_due_not_cancelled(store):
    """Retries have been exhausted, but the grace window is still the customer's to use."""
    account = subscribed(store)
    raw, sig = signed(event("halted", 1_800_000_000))
    apply_webhook(store, raw, sig, "evt_1")
    assert store.subscription(account.id).status == "past_due"
