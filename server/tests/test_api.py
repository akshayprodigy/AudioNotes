"""
The HTTP surface, as the app and a browser actually meet it.

The app's whole subscription flow is three calls, so they are exercised end to end here rather than
only through the functions underneath them.
"""

import pytest
from fastapi.testclient import TestClient

from app.branding import PRODUCT_NAME
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


# ---- malformed input ----

def test_a_malformed_body_is_a_bad_request_not_a_crash(client):
    r = client.post("/api/account/signin", content=b"{not json",
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


# ---- pages ----

@pytest.mark.parametrize("path", ["/", "/delete-account"])
def test_the_public_pages_render(client, path):
    r = client.get(path)
    assert r.status_code == 200 and PRODUCT_NAME in r.text


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
    for promised in ("email address", "scrypt hash", "subscription status"):
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


def test_every_page_carries_a_description(client):
    """A page with no meta description gets whatever Google scrapes off it, which for a form is
    the form."""
    for path in ("/", "/privacy", "/terms", "/delete-account"):
        assert 'name="description"' in client.get(path).text, path


def test_the_legal_pages_do_not_reuse_the_home_page_description(client):
    """Duplicate descriptions across a site are ignored, and then all of them lose."""
    home = client.get("/").text
    privacy = client.get("/privacy").text

    def described(html: str) -> str:
        import re
        return re.search(r'name="description" content="([^"]*)"', html).group(1)

    assert described(home) != described(privacy)


def test_link_previews_have_a_card(client):
    """Pasted into WhatsApp or Slack, this URL should not render as a bare link."""
    html = client.get("/").text
    for tag in ("og:title", "og:description", "og:image", "twitter:card"):
        assert tag in html, tag
    assert "1200" in html and "630" in html


def test_the_social_image_is_actually_served(client):
    r = client.get("/static/og.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert len(r.content) > 10_000


def test_the_og_image_url_is_absolute_when_configured(client, monkeypatch):
    """Most crawlers ignore a relative og:image, so the card silently loses its picture."""
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://verbale.example.com")
    assert 'content="https://verbale.example.com/static/og.png"' in client.get("/").text


def test_robots_keeps_crawlers_off_the_admin_console_and_the_api(client):
    """There is nothing to sign in to on the site; the console is the only thing worth hiding."""
    body = client.get("/robots.txt").text
    assert "Disallow: /admin" in body and "Disallow: /api/" in body
    assert "Allow: /privacy" in body and "Allow: /delete-account" in body


# ---- the shape of the website ----
#
# The site is a landing page, the legal pages, a deletion-request page, and the admin console.
# Nothing on it creates an account or signs a customer in: purchasing is Google Play Billing inside
# the app, and an account is created by the purchase with no password to sign in with.

@pytest.mark.parametrize("path", ["/signup", "/account", "/forgot", "/reset", "/subscribe"])
def test_the_self_service_account_pages_are_gone(client, path):
    assert client.get(path).status_code == 404
    assert client.post(path, data={}).status_code == 404


def test_there_is_no_way_to_create_an_account_over_http(client):
    """An open account-creation endpoint would contradict every word of the page above it."""
    r = client.post("/api/account/signup",
                    json={"email": "a@example.com", "password": "password123"})
    assert r.status_code == 404


def test_the_landing_page_offers_no_sign_in(client):
    """
    A link to a page that 404s is worse than no link, and a "Sign in" button on a site with no
    sign-in is a support question waiting to happen.
    """
    body = client.get("/").text
    for dead in ('href="/signup"', 'href="/account"', 'href="/forgot"', 'href="/reset"'):
        assert dead not in body, dead
    assert "Sign in" not in body


def test_every_page_the_site_links_to_actually_exists(client):
    """Catches a dead link in the footer, which is where dead links go to live."""
    import re
    for path in ("/", "/privacy", "/terms", "/delete-account"):
        for href in set(re.findall(r'href="(/[^"#]*)"', client.get(path).text)):
            if href.startswith("/static") or href.startswith("/admin"):
                continue
            assert client.get(href).status_code == 200, f"{path} links to {href}"


def test_the_deletion_page_is_reachable_without_signing_in(client):
    """Play requires a deletion route that works from outside the app."""
    r = client.get("/delete-account")
    assert r.status_code == 200 and "delete" in r.text.lower()
