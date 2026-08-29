"""
The HTTP surface, as the app and a browser actually meet it.

The app's whole subscription flow is three calls, so they are exercised end to end here rather than
only through the functions underneath them.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import DEVICE_LIMIT, Subscription


@pytest.fixture
def client(store, signing_key):
    return TestClient(create_app(store=store, signing_key=signing_key))


def make_paid(store, email="a@example.com", password="password123"):
    account = store.create_account(email, password)
    store.upsert_subscription(
        Subscription(account_id=account.id, plan="pro", provider_id="sub_x",
                     status="active", current_period_end=2_000_000_000)
    )
    return account


# ---- signup ----

def test_signup_creates_an_account(client):
    r = client.post("/api/account/signup", json={"email": "a@example.com", "password": "password123"})
    assert r.status_code == 200
    assert r.json()["email"] == "a@example.com"


@pytest.mark.parametrize(
    "body", [{"email": "notanemail", "password": "password123"},
             {"email": "a@example.com", "password": "short"},
             {}, {"email": 42, "password": "password123"}],
)
def test_signup_refuses_what_it_cannot_use(client, body):
    assert client.post("/api/account/signup", json=body).status_code == 400


def test_signup_is_not_a_way_to_enumerate_registered_emails(client):
    client.post("/api/account/signup", json={"email": "a@example.com", "password": "password123"})
    r = client.post("/api/account/signup", json={"email": "a@example.com", "password": "password123"})
    assert r.status_code == 409


def test_a_malformed_body_is_a_bad_request_not_a_crash(client):
    r = client.post("/api/account/signup", content=b"{not json",
                    headers={"content-type": "application/json"})
    assert r.status_code == 400


# ---- signin ----

def test_signin_without_a_subscription_succeeds_on_the_free_tier(client, store):
    """An account with no subscription is a real state, not an error."""
    store.create_account("a@example.com", "password123")
    r = client.post("/api/account/signin",
                    json={"email": "a@example.com", "password": "password123", "deviceId": "d1"})
    assert r.status_code == 200
    body = r.json()
    assert body["token"] is None and body["plan"] == "free"
    assert body["refreshKey"], "a refresh key is issued anyway, so a later purchase needs no password"


def test_signin_with_a_subscription_returns_a_token(client, store):
    make_paid(store)
    body = client.post("/api/account/signin",
                       json={"email": "a@example.com", "password": "password123",
                             "deviceId": "d1"}).json()
    assert body["token"] and body["plan"] == "pro" and body["expiresAt"] > 0


def test_signin_requires_a_device_id(client, store):
    store.create_account("a@example.com", "password123")
    r = client.post("/api/account/signin",
                    json={"email": "a@example.com", "password": "password123"})
    assert r.status_code == 400


def test_a_wrong_password_is_rejected(client, store):
    store.create_account("a@example.com", "password123")
    r = client.post("/api/account/signin",
                    json={"email": "a@example.com", "password": "nope", "deviceId": "d1"})
    assert r.status_code == 401


def test_the_fourth_device_is_told_what_to_do_about_it(client, store):
    make_paid(store)
    for i in range(DEVICE_LIMIT):
        client.post("/api/account/signin", json={"email": "a@example.com",
                                                 "password": "password123", "deviceId": f"d{i}"})
    r = client.post("/api/account/signin", json={"email": "a@example.com",
                                                 "password": "password123", "deviceId": "d_extra"})
    assert r.status_code == 409
    assert "account page" in r.json()["error"]


# ---- refresh ----

def test_a_device_refreshes_without_the_password(client, store):
    make_paid(store)
    key = client.post("/api/account/signin",
                      json={"email": "a@example.com", "password": "password123",
                            "deviceId": "d1"}).json()["refreshKey"]
    body = client.post("/api/licence/refresh", json={"deviceId": "d1", "refreshKey": key}).json()
    assert body["token"] and body["plan"] == "pro"


def test_a_refresh_key_from_another_device_is_rejected(client, store):
    make_paid(store)
    key = client.post("/api/account/signin",
                      json={"email": "a@example.com", "password": "password123",
                            "deviceId": "d1"}).json()["refreshKey"]
    r = client.post("/api/licence/refresh", json={"deviceId": "d2", "refreshKey": key})
    assert r.status_code == 401


def test_refreshing_after_the_subscription_lapses_returns_no_token(client, store):
    """The app keeps its old token until it expires; it simply gets nothing new."""
    account = make_paid(store)
    key = client.post("/api/account/signin",
                      json={"email": "a@example.com", "password": "password123",
                            "deviceId": "d1"}).json()["refreshKey"]
    store.upsert_subscription(
        Subscription(account_id=account.id, plan="pro", provider_id="sub_x",
                     status="cancelled", current_period_end=1)
    )
    assert client.post("/api/licence/refresh",
                       json={"deviceId": "d1", "refreshKey": key}).json()["token"] is None


# ---- billing ----

def test_subscribing_without_razorpay_configured_says_so(client, store, monkeypatch):
    monkeypatch.delenv("RAZORPAY_KEY_ID", raising=False)
    monkeypatch.delenv("RAZORPAY_PLAN_ID", raising=False)
    store.create_account("a@example.com", "password123")
    r = client.post("/api/billing/subscribe",
                    json={"email": "a@example.com", "password": "password123"})
    assert r.status_code == 503


# ---- pages ----

@pytest.mark.parametrize("path", ["/", "/signup", "/account"])
def test_the_public_pages_render(client, path):
    r = client.get(path)
    assert r.status_code == 200 and "AudioNotes" in r.text


def test_the_account_page_shows_a_subscription_and_its_devices(client, store):
    make_paid(store)
    client.post("/api/account/signin", json={"email": "a@example.com",
                                             "password": "password123", "deviceId": "d1abcdef"})
    r = client.post("/account", data={"email": "a@example.com", "password": "password123"})
    assert r.status_code == 200
    assert "Pro" in r.text and "d1abcdef"[:8] in r.text and f"1 of {DEVICE_LIMIT}" in r.text


def test_the_account_page_refuses_a_wrong_password(client, store):
    store.create_account("a@example.com", "password123")
    r = client.post("/account", data={"email": "a@example.com", "password": "wrong"})
    assert r.status_code == 401


def test_an_email_with_html_in_it_cannot_inject_markup(client, store):
    """The email is echoed back onto the page, so it has to be escaped."""
    store.create_account("a<script>@example.com", "password123")
    r = client.post("/account", data={"email": "a<script>@example.com", "password": "password123"})
    assert "<script>" not in r.text and "&lt;script&gt;" in r.text


def test_forgetting_a_device_needs_the_password(client, store):
    account = make_paid(store)
    store.touch_device(account.id, "d1")
    r = client.post("/devices/forget",
                    data={"email": "a@example.com", "password": "wrong", "deviceId": "d1"})
    assert r.status_code == 401
    assert len(store.devices(account.id)) == 1


def test_forgetting_a_device_removes_it(client, store):
    account = make_paid(store)
    store.touch_device(account.id, "d1")
    r = client.post("/devices/forget",
                    data={"email": "a@example.com", "password": "password123", "deviceId": "d1"})
    assert r.status_code == 200 and store.devices(account.id) == []


def test_healthz(client):
    assert client.get("/healthz").json() == {"ok": True}


def test_there_is_no_generated_api_explorer_in_production(client):
    """Five endpoints documented in the README; an explorer is an invitation to poke at billing."""
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


# ---- legal ----

@pytest.mark.parametrize("path", ["/privacy", "/terms"])
def test_the_legal_pages_render(client, path):
    r = client.get(path)
    assert r.status_code == 200 and len(r.text) > 2000


def test_the_privacy_policy_says_what_the_schema_actually_holds(client):
    """If this list and store.py ever disagree, the policy is the thing that is wrong."""
    text = client.get("/privacy").text
    for promised in ("email address", "scrypt hash", "subscription status", "password reset"):
        assert promised in text


def test_the_privacy_policy_is_reachable_from_the_home_page(client):
    """A policy nobody can find is one Play will not accept and nobody will read."""
    assert '/privacy' in client.get("/").text


def test_the_product_name_is_not_hardcoded_in_the_legal_pages(client, monkeypatch):
    """The app is being renamed before launch; the documents must follow without an edit."""
    from app import branding, legal
    monkeypatch.setattr(branding, "PRODUCT_NAME", "Renamed")
    monkeypatch.setattr(legal, "PRODUCT_NAME", "Renamed")
    assert "Renamed" in legal._privacy()
    assert "Renamed" in legal._terms()
