"""
The password reset flow.

Two rules shape all of it: the pages must never reveal whether an address has an account, and a
link that has been used or has aged out is worth nothing.
"""

import re

import pytest
from fastapi.testclient import TestClient

from app import mailer
from app.main import create_app
from app.store import PASSWORD_RESET_TTL_SECONDS, Subscription


@pytest.fixture
def sent(monkeypatch):
    """Capture what would have been emailed, instead of sending it."""
    box: list[tuple[str, str, str]] = []
    monkeypatch.setattr(mailer, "send", lambda to, subject, body: box.append((to, subject, body)) or True)
    return box


@pytest.fixture
def client(store, signing_key):
    return TestClient(create_app(store=store, signing_key=signing_key))


def link_from(body: str) -> str:
    match = re.search(r"/reset\?token=([A-Za-z0-9_-]+)", body)
    assert match, f"no reset link in the mail:\n{body}"
    return match.group(1)


def request_reset(client, sent, email="a@example.com") -> str:
    client.post("/forgot", data={"email": email})
    return link_from(sent[-1][2])


# ---- not telling anyone who has an account ----

def test_an_unknown_address_gets_the_same_answer_as_a_known_one(client, store, sent):
    store.create_account("a@example.com", "password123")
    known = client.post("/forgot", data={"email": "a@example.com"})
    unknown = client.post("/forgot", data={"email": "nobody@example.com"})
    assert known.status_code == unknown.status_code == 200
    assert known.text == unknown.text


def test_no_mail_is_sent_for_an_address_with_no_account(client, sent):
    client.post("/forgot", data={"email": "nobody@example.com"})
    assert sent == []


def test_a_known_address_is_emailed_a_link(client, store, sent):
    store.create_account("a@example.com", "password123")
    client.post("/forgot", data={"email": "a@example.com"})
    to, subject, body = sent[0]
    assert to == "a@example.com"
    assert "reset" in subject.lower()
    assert link_from(body)


# ---- the link ----

def test_the_form_opens_for_a_live_token(client, store, sent):
    store.create_account("a@example.com", "password123")
    token = request_reset(client, sent)
    r = client.get(f"/reset?token={token}")
    assert r.status_code == 200 and "New password" in r.text


def test_opening_the_link_does_not_spend_it(client, store, sent):
    """Mail clients prefetch links. A token burned before the person sees the form is useless."""
    store.create_account("a@example.com", "password123")
    token = request_reset(client, sent)
    client.get(f"/reset?token={token}")
    client.get(f"/reset?token={token}")
    assert client.post("/reset", data={"token": token, "password": "newpassword1"}).status_code == 200


def test_a_made_up_token_is_refused(client):
    assert client.get("/reset?token=nonsense").status_code == 400
    assert client.post("/reset", data={"token": "nonsense", "password": "newpassword1"}).status_code == 400


def test_no_token_at_all_is_refused(client):
    assert client.get("/reset").status_code == 400


def test_an_expired_token_is_refused(client, store, sent):
    account = store.create_account("a@example.com", "password123")
    token = store.create_password_reset(account.id, now=1000)
    assert store.peek_password_reset(token, now=1000 + PASSWORD_RESET_TTL_SECONDS + 1) is None
    assert store.consume_password_reset(token, now=1000 + PASSWORD_RESET_TTL_SECONDS + 1) is None


def test_a_token_works_only_once(client, store, sent):
    store.create_account("a@example.com", "password123")
    token = request_reset(client, sent)
    assert client.post("/reset", data={"token": token, "password": "newpassword1"}).status_code == 200
    assert client.post("/reset", data={"token": token, "password": "another1234"}).status_code == 400


def test_asking_again_retires_the_previous_link(client, store, sent):
    """Two live links means a request somebody did not make stays usable after one they did."""
    store.create_account("a@example.com", "password123")
    first = request_reset(client, sent)
    second = request_reset(client, sent)
    assert first != second
    assert client.post("/reset", data={"token": first, "password": "newpassword1"}).status_code == 400
    assert client.post("/reset", data={"token": second, "password": "newpassword1"}).status_code == 200


# ---- what changing the password actually does ----

def test_the_new_password_works_and_the_old_one_does_not(client, store, sent):
    store.create_account("a@example.com", "password123")
    token = request_reset(client, sent)
    client.post("/reset", data={"token": token, "password": "newpassword1"})
    assert store.authenticate("a@example.com", "newpassword1") is not None
    assert store.authenticate("a@example.com", "password123") is None


def test_a_short_password_is_refused_without_spending_the_token(client, store, sent):
    store.create_account("a@example.com", "password123")
    token = request_reset(client, sent)
    assert client.post("/reset", data={"token": token, "password": "short"}).status_code == 400
    assert client.post("/reset", data={"token": token, "password": "newpassword1"}).status_code == 200


def test_resetting_signs_every_device_out(client, store, sent):
    """A reset is the moment to evict whoever got in, and the password alone does not do that."""
    account = store.create_account("a@example.com", "password123")
    store.upsert_subscription(
        Subscription(account_id=account.id, plan="pro", provider_id="sub_x",
                     status="active", current_period_end=2_000_000_000)
    )
    key = client.post("/api/account/signin",
                      json={"email": "a@example.com", "password": "password123",
                            "deviceId": "d1"}).json()["refreshKey"]
    assert client.post("/api/licence/refresh", json={"deviceId": "d1", "refreshKey": key}).status_code == 200

    token = request_reset(client, sent)
    client.post("/reset", data={"token": token, "password": "newpassword1"})

    assert client.post("/api/licence/refresh",
                       json={"deviceId": "d1", "refreshKey": key}).status_code == 401


def test_the_devices_themselves_survive_the_reset(client, store, sent):
    """Otherwise a reset would silently free the slots, or worse, cost the owner their own."""
    account = store.create_account("a@example.com", "password123")
    store.touch_device(account.id, "d1")
    store.touch_device(account.id, "d2")
    token = request_reset(client, sent)
    client.post("/reset", data={"token": token, "password": "newpassword1"})
    assert len(store.devices(account.id)) == 2


# ---- the mailer itself ----

def test_an_unconfigured_mailer_reports_failure_rather_than_pretending(monkeypatch):
    """A silent success would mean nobody ever gets a link and nothing anywhere says so."""
    for var in ("SMTP_HOST", "SMTP_FROM"):
        monkeypatch.delenv(var, raising=False)
    assert mailer.is_configured() is False
    assert mailer.send("a@example.com", "subject", "body") is False


def test_link_origin_prefers_configuration_over_the_host_header(monkeypatch):
    """A link built from an attacker-supplied Host points the recipient at somebody else's server."""
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://audionotes.example.com")
    assert mailer.public_base_url("http://evil.test/") == "https://audionotes.example.com"
    monkeypatch.delenv("PUBLIC_BASE_URL")
    assert mailer.public_base_url("http://fallback.test/") == "http://fallback.test"
