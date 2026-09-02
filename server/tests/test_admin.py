"""
The admin console over HTTP.

Three things are being defended here, in order of how bad they would be:

1. A stranger reading the customer list.
2. The console existing at all on a server that was never configured for one.
3. A password hash or refresh key reaching a browser.
"""

import pytest
from fastapi.testclient import TestClient

from app import admin
from app.main import create_app
from app.store import Subscription

ADMIN = "boss@example.com"
PASSWORD = "password123"


@pytest.fixture(autouse=True)
def no_carried_rate_limit():
    """The attempt counter is module state; a test must not inherit another test's failures."""
    admin._ATTEMPTS.clear()
    yield
    admin._ATTEMPTS.clear()


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("ADMIN_SESSION_SECRET", "test-secret")
    monkeypatch.setenv("VERBALE_ADMIN_EMAILS", ADMIN)


@pytest.fixture
def client(store, signing_key):
    # https, because the session cookie is marked Secure and an http client would silently drop it
    # — the tests would then pass for a reason that has nothing to do with the code.
    return TestClient(create_app(store=store, signing_key=signing_key),
                      base_url="https://testserver")


@pytest.fixture
def customers(store):
    """One paying customer and one who never subscribed."""
    paid = store.create_account("payer@example.com", PASSWORD)
    store.upsert_subscription(
        Subscription(account_id=paid.id, plan="pro", provider_id="tok_1",
                     status="active", current_period_end=2_000_000_000)
    )
    store.create_account("browser@example.com", PASSWORD)
    store.create_account(ADMIN, PASSWORD)
    return paid


def signed_in(client, store, customers):
    r = client.post("/admin/signin", data={"email": ADMIN, "password": PASSWORD})
    assert r.status_code in (200, 303), r.text
    return client


# ---- the console does not exist until it is configured ----

@pytest.mark.parametrize("path", ["/admin", "/admin/signin", "/admin/accounts",
                                  "/admin/accounts.csv", "/admin/accounts/anything"])
def test_every_route_is_404_when_unconfigured(client, monkeypatch, path):
    monkeypatch.delenv("ADMIN_SESSION_SECRET", raising=False)
    monkeypatch.delenv("VERBALE_ADMIN_EMAILS", raising=False)
    assert client.get(path).status_code == 404


def test_signing_in_is_404_when_unconfigured(client, monkeypatch):
    monkeypatch.delenv("ADMIN_SESSION_SECRET", raising=False)
    r = client.post("/admin/signin", data={"email": ADMIN, "password": PASSWORD})
    assert r.status_code == 404


def test_a_half_configured_console_stays_shut(client, monkeypatch):
    """A secret with no allowlist is a console anybody with an account could sign in to."""
    monkeypatch.setenv("ADMIN_SESSION_SECRET", "test-secret")
    monkeypatch.delenv("VERBALE_ADMIN_EMAILS", raising=False)
    assert client.get("/admin").status_code == 404


# ---- signing in ----

def test_signed_out_is_sent_to_the_sign_in_page(client, configured):
    r = client.get("/admin", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/admin/signin"


def test_the_sign_in_page_renders(client, configured):
    assert client.get("/admin/signin").status_code == 200


def test_a_wrong_password_is_refused(client, configured, store, customers):
    r = client.post("/admin/signin", data={"email": ADMIN, "password": "wrong"})
    assert r.status_code == 401


def test_a_real_account_that_is_not_an_admin_is_refused(client, configured, store, customers):
    """Correct credentials are not authorisation. This is the whole point of the allowlist."""
    r = client.post("/admin/signin",
                    data={"email": "payer@example.com", "password": PASSWORD})
    assert r.status_code == 401


def test_a_non_admin_is_refused_in_the_same_words_as_a_wrong_password(
    client, configured, store, customers
):
    """Otherwise the form tells a stranger which addresses are operators."""
    wrong = client.post("/admin/signin", data={"email": ADMIN, "password": "wrong"})
    outsider = client.post("/admin/signin",
                           data={"email": "payer@example.com", "password": PASSWORD})
    assert wrong.status_code == outsider.status_code
    assert wrong.text == outsider.text


def test_an_admin_gets_in(client, configured, store, customers):
    r = client.post("/admin/signin", data={"email": ADMIN, "password": PASSWORD},
                    follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/admin"


def test_the_session_cookie_is_locked_down(client, configured, store, customers):
    r = client.post("/admin/signin", data={"email": ADMIN, "password": PASSWORD},
                    follow_redirects=False)
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "secure" in cookie
    assert "samesite=strict" in cookie
    assert "path=/admin" in cookie


def test_repeated_failures_are_rate_limited(client, configured, store, customers):
    for _ in range(admin._MAX_ATTEMPTS):
        client.post("/admin/signin", data={"email": ADMIN, "password": "wrong"})
    r = client.post("/admin/signin", data={"email": ADMIN, "password": "wrong"})
    assert r.status_code == 429


def test_signing_out_clears_the_session(client, configured, store, customers):
    signed_in(client, store, customers)
    assert client.get("/admin").status_code == 200
    client.post("/admin/signout")
    assert client.get("/admin", follow_redirects=False).status_code == 303


# ---- what an admin sees ----

def test_the_overview_counts_the_customers(client, configured, store, customers):
    signed_in(client, store, customers)
    body = client.get("/admin").text
    assert "accounts" in body and "active" in body


def test_the_accounts_page_lists_a_subscriber(client, configured, store, customers):
    signed_in(client, store, customers)
    body = client.get("/admin/accounts").text
    assert "payer@example.com" in body
    assert "browser@example.com" in body, "an account with no subscription is still a row"


def test_filtering_by_status_narrows_the_list(client, configured, store, customers):
    signed_in(client, store, customers)
    body = client.get("/admin/accounts?status=active").text
    assert "payer@example.com" in body
    assert "browser@example.com" not in body


def test_searching_narrows_the_list(client, configured, store, customers):
    signed_in(client, store, customers)
    body = client.get("/admin/accounts?q=payer").text
    assert "payer@example.com" in body and "browser@example.com" not in body


def test_an_account_page_renders(client, configured, store, customers):
    signed_in(client, store, customers)
    r = client.get(f"/admin/accounts/{customers.id}")
    assert r.status_code == 200 and "payer@example.com" in r.text


def test_an_unknown_account_is_a_404_not_a_crash(client, configured, store, customers):
    signed_in(client, store, customers)
    assert client.get("/admin/accounts/nope").status_code == 404


def test_the_csv_downloads(client, configured, store, customers):
    signed_in(client, store, customers)
    r = client.get("/admin/accounts.csv")
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    assert "payer@example.com" in r.text


def test_the_csv_needs_a_session_too(client, configured, store, customers):
    """The easiest route to forget. A CSV of every customer is the worst one to leave open."""
    r = client.get("/admin/accounts.csv", follow_redirects=False)
    assert r.status_code == 303


# ---- what must never come out ----

def test_no_password_hash_reaches_the_browser(client, configured, store, customers):
    signed_in(client, store, customers)
    row = store._db.execute(
        "SELECT password_hash FROM accounts WHERE email=?", ("payer@example.com",)).fetchone()
    secret = row["password_hash"]
    assert secret, "the fixture must actually have a hash, or this test proves nothing"
    for path in ("/admin", "/admin/accounts", "/admin/accounts.csv",
                 f"/admin/accounts/{customers.id}"):
        assert secret not in client.get(path).text, path


def test_no_refresh_key_reaches_the_browser(client, configured, store, customers):
    signed_in(client, store, customers)
    store.touch_device(customers.id, "their-phone")
    store.issue_refresh_key(customers.id, "their-phone")
    row = store._db.execute(
        "SELECT refresh_hash FROM devices WHERE account_id=?", (customers.id,)).fetchone()
    assert row["refresh_hash"]
    assert row["refresh_hash"] not in client.get(f"/admin/accounts/{customers.id}").text


def test_an_email_with_markup_in_it_cannot_inject(client, configured, store, customers):
    store.create_account("<script>alert(1)</script>@x.com", PASSWORD)
    signed_in(client, store, customers)
    body = client.get("/admin/accounts").text
    assert "<script>alert(1)</script>" not in body


def test_the_console_cannot_grant_entitlement(client, configured, store, customers):
    """
    There is no route that writes. Browsing every page must leave the subscription exactly as it
    was — if a 'make this account Pro' button is ever added, this is the test that should stop it.
    """
    before = store.subscription(customers.id)
    signed_in(client, store, customers)
    for path in ("/admin", "/admin/accounts", f"/admin/accounts/{customers.id}"):
        client.get(path)
    assert store.subscription(customers.id) == before

    free = store.account_by_email("browser@example.com")
    assert store.subscription(free.id).status == "none"
