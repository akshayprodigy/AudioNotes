"""
Google Play Billing.

A purchase token is a string, and anyone can send a string. Everything here is about what happens
when the string is a lie, when Google cannot be reached, and when Google changes its mind later.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import play
from app.billing import cancel_play_subscription, link_play_purchase, refresh_play_subscription
from app.main import create_app
from app.play import PlayError, PlaySubscription, parse_subscription
from app.store import DEVICE_LIMIT, Subscription

FUTURE = 2_000_000_000


def purchase(status="active", expires=FUTURE, acknowledged=True, linked=None, product="pro_monthly"):
    return PlaySubscription(status=status, expires_at=expires, product_id=product,
                            acknowledged=acknowledged, linked_purchase_token=linked)


@pytest.fixture
def google(monkeypatch):
    """
    Stand in for Google.

    `answers` maps a purchase token to what Google says about it; anything absent raises, which is
    what a forged token actually does (the API 404s).
    """
    state = {"answers": {}, "acknowledged": [], "fail_acknowledge": False}

    def verify(token):
        if token not in state["answers"]:
            raise PlayError("Play API 404: purchaseTokenNotFound")
        answer = state["answers"][token]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def acknowledge(token, product_id):
        if state["fail_acknowledge"]:
            raise PlayError("Play API 503")
        state["acknowledged"].append((token, product_id))

    monkeypatch.setattr(play, "is_configured", lambda: True)
    monkeypatch.setattr(play, "verify", verify)
    monkeypatch.setattr(play, "acknowledge", acknowledge)
    return state


@pytest.fixture
def client(store, signing_key):
    return TestClient(create_app(store=store, signing_key=signing_key))


# ---- reading Google's answer ----

@pytest.mark.parametrize(
    "google_state,ours",
    [
        ("SUBSCRIPTION_STATE_ACTIVE", "active"),
        ("SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "past_due"),
        ("SUBSCRIPTION_STATE_ON_HOLD", "past_due"),
        ("SUBSCRIPTION_STATE_CANCELED", "cancelled"),
        ("SUBSCRIPTION_STATE_EXPIRED", "cancelled"),
        ("SUBSCRIPTION_STATE_PAUSED", "cancelled"),
        ("SUBSCRIPTION_STATE_PENDING", "none"),
        ("SOMETHING_GOOGLE_ADDED_LATER", "none"),
    ],
)
def test_google_states_map_onto_ours(google_state, ours):
    """An unknown state must read as 'not entitled', so a new Google state cannot grant access."""
    assert parse_subscription({"subscriptionState": google_state}).status == ours


def test_the_latest_expiry_wins_across_line_items():
    """A subscription with an add-on has more than one, and access runs to the last of them."""
    parsed = parse_subscription({
        "subscriptionState": "SUBSCRIPTION_STATE_ACTIVE",
        "lineItems": [
            {"productId": "pro", "expiryTime": "2026-09-30T12:00:00Z"},
            {"productId": "addon", "expiryTime": "2026-10-31T12:00:00Z"},
        ],
    })
    later = int(datetime(2026, 10, 31, 12, tzinfo=timezone.utc).timestamp())
    assert parsed.expires_at == later


def test_nanosecond_timestamps_parse():
    """Google sends nanoseconds; fromisoformat takes at most microseconds."""
    parsed = parse_subscription({
        "subscriptionState": "SUBSCRIPTION_STATE_ACTIVE",
        "lineItems": [{"productId": "p", "expiryTime": "2026-09-30T12:34:56.123456789Z"}],
    })
    assert parsed.expires_at > 0


# ---- linking a purchase ----

def test_a_token_google_does_not_recognise_grants_nothing(store, google):
    result = link_play_purchase(store, "forged-token")
    assert result.account_id is None
    assert result.status == 502


def test_a_forged_token_does_not_create_an_account(store, google):
    """Otherwise the accounts table fills up with rows conjured by anyone who can POST."""
    link_play_purchase(store, "forged-token")
    with store._lock:  # noqa: SLF001
        assert store._db.execute("SELECT COUNT(*) AS n FROM accounts").fetchone()["n"] == 0


def test_google_being_unreachable_is_502_not_a_rejection(store, google):
    """The token may be perfectly good. The app retries; nothing was granted meanwhile."""
    google["answers"]["t"] = PlayError("could not reach Google: timed out")
    assert link_play_purchase(store, "t").status == 502


def test_a_pending_purchase_is_not_yet_entitled(store, google):
    """Some UPI mandates authorise later. Not an error — just not paid yet."""
    google["answers"]["t"] = purchase(status="none")
    result = link_play_purchase(store, "t")
    assert result.status == 402 and result.account_id is None


def test_a_first_purchase_creates_an_entitled_account(store, google):
    google["answers"]["t"] = purchase()
    result = link_play_purchase(store, "t")
    assert result.account_id is not None

    sub = store.subscription(result.account_id)
    assert sub.provider == "play" and sub.status == "active"
    assert sub.current_period_end == FUTURE


def test_a_play_account_has_no_email_or_password(store, google):
    """Google established who this is. Inventing a password to receive what you paid for is friction."""
    google["answers"]["t"] = purchase()
    account_id = link_play_purchase(store, "t").account_id
    with store._lock:  # noqa: SLF001
        row = store._db.execute("SELECT email,password_hash FROM accounts WHERE id=?",
                                (account_id,)).fetchone()
    assert row["email"] is None and row["password_hash"] is None


def test_linking_the_same_token_twice_does_not_make_a_second_account(store, google):
    """This endpoint IS 'restore purchases', so it is called on every reinstall and second device."""
    google["answers"]["t"] = purchase()
    first = link_play_purchase(store, "t").account_id
    second = link_play_purchase(store, "t").account_id
    assert first == second
    with store._lock:  # noqa: SLF001
        assert store._db.execute("SELECT COUNT(*) AS n FROM accounts").fetchone()["n"] == 1


def test_an_upgrade_moves_the_existing_account_across(store, google):
    """
    Google issues a NEW token on upgrade or resubscribe and points it at the old one.

    Miss that link and the customer keeps their devices and history on an account with no
    subscription, while a fresh empty account holds the thing they paid for.
    """
    google["answers"]["old"] = purchase()
    original = link_play_purchase(store, "old").account_id
    store.touch_device(original, "their-phone")

    google["answers"]["new"] = purchase(linked="old")
    upgraded = link_play_purchase(store, "new").account_id

    assert upgraded == original, "the upgrade stranded the original account"
    assert [d.device_id for d in store.devices(original)] == ["their-phone"]
    assert store.subscription(original).provider_id == "new"


# ---- acknowledgement, which Google refunds without ----

def test_an_unacknowledged_purchase_is_acknowledged(store, google):
    """Google auto-refunds anything unacknowledged within three days."""
    google["answers"]["t"] = purchase(acknowledged=False)
    link_play_purchase(store, "t")
    assert google["acknowledged"] == [("t", "pro_monthly")]


def test_an_already_acknowledged_purchase_is_not_acknowledged_again(store, google):
    google["answers"]["t"] = purchase(acknowledged=True)
    link_play_purchase(store, "t")
    assert google["acknowledged"] == []


def test_entitlement_survives_a_failed_acknowledgement(store, google):
    """The customer has paid. Refusing access over a bookkeeping call would be the wrong trade."""
    google["answers"]["t"] = purchase(acknowledged=False)
    google["fail_acknowledge"] = True
    result = link_play_purchase(store, "t")
    assert result.account_id is not None
    assert store.subscription(result.account_id).status == "active"


def test_a_failed_acknowledgement_is_retried_on_refresh(store, google):
    """Still well inside Google's three days, and it costs nothing to try again."""
    google["answers"]["t"] = purchase(acknowledged=False)
    google["fail_acknowledge"] = True
    account_id = link_play_purchase(store, "t").account_id

    google["fail_acknowledge"] = False
    refresh_play_subscription(store, account_id)
    assert google["acknowledged"] == [("t", "pro_monthly")]


# ---- Google changing its mind later ----

def test_a_cancellation_is_noticed_on_refresh(store, google):
    """There is no webhook. This is what makes real-time notifications unnecessary."""
    google["answers"]["t"] = purchase()
    account_id = link_play_purchase(store, "t").account_id

    google["answers"]["t"] = purchase(status="cancelled", expires=1)
    refresh_play_subscription(store, account_id)

    sub = store.subscription(account_id)
    assert sub.status == "cancelled" and sub.current_period_end == 1


def test_a_google_outage_does_not_revoke_a_paying_customer(store, google):
    google["answers"]["t"] = purchase()
    account_id = link_play_purchase(store, "t").account_id

    google["answers"]["t"] = PlayError("could not reach Google")
    refresh_play_subscription(store, account_id)
    assert store.subscription(account_id).status == "active"


def test_a_subscription_that_is_not_a_play_one_is_not_sent_to_google(store, google):
    """
    Play is the only provider now, so this guard has nothing left to exclude — and that is exactly
    why it is worth a test. A row reaching Google with an id Google cannot parse is a lookup that
    fails on every refresh; the guard is what keeps a non-Play row inert instead.
    """
    account = store.create_account("a@example.com", "password123")
    store.upsert_subscription(Subscription(account_id=account.id, plan="pro", provider="other",
                                           provider_id="sub_x", status="active",
                                           current_period_end=FUTURE))
    refresh_play_subscription(store, account.id)  # would raise if it asked Google about "sub_x"
    assert store.subscription(account.id).status == "active"


# ---- the endpoint ----

def test_the_endpoint_returns_a_licence(client, store, google):
    google["answers"]["t"] = purchase()
    body = client.post("/api/billing/play/link",
                       json={"purchaseToken": "t", "deviceId": "d1"}).json()
    assert body["token"] and body["plan"] == "pro" and body["refreshKey"]


def test_the_endpoint_needs_both_fields(client, google):
    assert client.post("/api/billing/play/link", json={"deviceId": "d1"}).status_code == 400
    assert client.post("/api/billing/play/link", json={"purchaseToken": "t"}).status_code == 400


def test_the_device_limit_applies_to_play_purchases_too(client, store, google):
    google["answers"]["t"] = purchase()
    for i in range(DEVICE_LIMIT):
        client.post("/api/billing/play/link", json={"purchaseToken": "t", "deviceId": f"d{i}"})
    r = client.post("/api/billing/play/link", json={"purchaseToken": "t", "deviceId": "one-more"})
    assert r.status_code == 409


def test_an_unconfigured_server_says_so_rather_than_granting(store, monkeypatch):
    monkeypatch.setattr(play, "is_configured", lambda: False)
    assert link_play_purchase(store, "t").status == 503


# ---- cancelling, which is what makes account deletion safe ----

def test_cancel_posts_to_googles_cancel_endpoint(monkeypatch):
    """
    The URL is built by hand from three variables, so it is worth asserting once.

    A wrong path here does not fail loudly: Google answers 404, the caller reads that as "already
    cancelled", and an account is deleted while the card keeps being charged.
    """
    calls: list[tuple[str, dict]] = []
    monkeypatch.setenv("PLAY_PACKAGE_NAME", "com.innocorelabs.verbale")
    monkeypatch.setattr(play, "_post", lambda path, body: calls.append((path, body)))

    play.cancel("token-123", "pro_monthly")

    assert calls == [(
        "/applications/com.innocorelabs.verbale/purchases/subscriptions/"
        "pro_monthly/tokens/token-123:cancel",
        {},
    )]


def test_cancel_quotes_a_token_containing_a_slash(monkeypatch):
    """Purchase tokens are opaque base64-ish strings; an unquoted / would change the path."""
    calls: list[tuple[str, dict]] = []
    monkeypatch.setenv("PLAY_PACKAGE_NAME", "pkg")
    monkeypatch.setattr(play, "_post", lambda path, body: calls.append((path, body)))

    play.cancel("aa/bb+cc", "pro_monthly")

    assert calls[0][0].endswith("/tokens/aa%2Fbb%2Bcc:cancel")


# ---- cancel_play_subscription: the guarantee account deletion rests on ----
#
# The asymmetry under test throughout: "already gone" must read as success, or an account can
# never be deleted; "we don't know" must read as failure, or somebody keeps being charged for an
# account that no longer exists.

@pytest.fixture
def cancellable(monkeypatch):
    """Google, for the cancel path: verify answers, and cancels are recorded."""
    state = {"answer": purchase(), "verify_error": None, "cancel_error": None, "cancelled": []}

    def verify(token):
        if state["verify_error"]:
            raise state["verify_error"]
        return state["answer"]

    def cancel(token, product_id):
        if state["cancel_error"]:
            raise state["cancel_error"]
        state["cancelled"].append((token, product_id))

    monkeypatch.setattr(play, "is_configured", lambda: True)
    monkeypatch.setattr(play, "verify", verify)
    monkeypatch.setattr(play, "cancel", cancel)
    return state


def test_a_live_subscription_is_cancelled_at_google(cancellable):
    assert cancel_play_subscription("t") == (True, None)
    assert cancellable["cancelled"] == [("t", "pro_monthly")]


def test_an_already_cancelled_subscription_is_a_success_and_is_not_cancelled_twice(cancellable):
    """Otherwise the account could never be deleted — there is no card left to stop."""
    cancellable["answer"] = purchase(status="cancelled")
    assert cancel_play_subscription("t") == (True, None)
    assert cancellable["cancelled"] == []


def test_a_token_google_has_never_heard_of_is_a_success(cancellable):
    cancellable["verify_error"] = PlayError("Play API 404: nope", status=404)
    assert cancel_play_subscription("t") == (True, None)


def test_google_being_unreachable_refuses_the_deletion(cancellable):
    """A maybe is a no. Refusing costs a retry; wrongly succeeding costs money every month."""
    cancellable["verify_error"] = PlayError("could not reach Google: timeout")
    ok, error = cancel_play_subscription("t")
    assert ok is False and "could not reach Google" in error


def test_a_server_error_from_google_refuses_the_deletion(cancellable):
    cancellable["verify_error"] = PlayError("Play API 503: try later", status=503)
    assert cancel_play_subscription("t")[0] is False


def test_a_failing_cancel_call_refuses_the_deletion(cancellable):
    cancellable["cancel_error"] = PlayError("Play API 500: boom", status=500)
    assert cancel_play_subscription("t")[0] is False


def test_a_cancel_that_404s_is_a_success(cancellable):
    """Between the verify and the cancel it stopped existing. That is the state we wanted."""
    cancellable["cancel_error"] = PlayError("Play API 404: gone", status=404)
    assert cancel_play_subscription("t") == (True, None)


def test_a_live_subscription_with_no_product_id_refuses_the_deletion(cancellable):
    """The cancel URL cannot be built, so the honest answer is that we could not cancel it."""
    cancellable["answer"] = purchase(product="")
    ok, error = cancel_play_subscription("t")
    assert ok is False and "which product" in error
    assert cancellable["cancelled"] == []


def test_an_unconfigured_server_refuses_rather_than_pretending(store, monkeypatch):
    monkeypatch.setattr(play, "is_configured", lambda: False)
    assert cancel_play_subscription("t")[0] is False
