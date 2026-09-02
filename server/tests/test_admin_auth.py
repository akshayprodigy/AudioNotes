"""
The cookie that stands between a stranger and the customer list.

Every test here is a forgery attempt. The one that matters most is the last one: a cookie is only
as good as the fact that an operator removed from the allowlist stops being an operator.
"""

import pytest

from app import admin_auth

SECRET = "test-secret-not-a-real-one"


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("ADMIN_SESSION_SECRET", SECRET)
    monkeypatch.setenv("VERBALE_ADMIN_EMAILS", "boss@example.com, second@example.com")


# ---- the switch ----

def test_the_console_is_off_with_no_secret(monkeypatch):
    monkeypatch.delenv("ADMIN_SESSION_SECRET", raising=False)
    monkeypatch.setenv("VERBALE_ADMIN_EMAILS", "boss@example.com")
    assert admin_auth.enabled() is False


def test_the_console_is_off_with_no_admins(monkeypatch):
    monkeypatch.setenv("ADMIN_SESSION_SECRET", SECRET)
    monkeypatch.setenv("VERBALE_ADMIN_EMAILS", "")
    assert admin_auth.enabled() is False


def test_a_whitespace_only_secret_does_not_count(monkeypatch):
    """`ADMIN_SESSION_SECRET=` in a .env file arrives as an empty string, not an absent key."""
    monkeypatch.setenv("ADMIN_SESSION_SECRET", "   ")
    monkeypatch.setenv("VERBALE_ADMIN_EMAILS", "boss@example.com")
    assert admin_auth.enabled() is False


def test_both_present_turns_it_on(configured):
    assert admin_auth.enabled() is True


# ---- the allowlist ----

def test_an_allowlisted_email_is_an_admin(configured):
    assert admin_auth.is_admin("boss@example.com")
    assert admin_auth.is_admin("  BOSS@Example.com  "), "case and padding must not matter"


def test_anybody_else_is_not(configured):
    assert not admin_auth.is_admin("stranger@example.com")
    assert not admin_auth.is_admin(None)
    assert not admin_auth.is_admin("")


# ---- the cookie ----

def test_a_cookie_this_module_made_reads_back(configured):
    assert admin_auth.read_cookie(admin_auth.make_cookie("boss@example.com")) == "boss@example.com"


def test_a_tampered_email_is_refused(configured):
    _, expires, sig = admin_auth.make_cookie("boss@example.com").split("|")
    assert admin_auth.read_cookie(f"stranger@example.com|{expires}|{sig}") is None


def test_a_tampered_expiry_is_refused(configured):
    """The expiry is inside the signature precisely so this cannot be extended by hand."""
    email, expires, sig = admin_auth.make_cookie("boss@example.com").split("|")
    assert admin_auth.read_cookie(f"{email}|{int(expires) + 999_999}|{sig}") is None


def test_an_expired_cookie_is_refused(configured):
    old = admin_auth.make_cookie("boss@example.com", now=1_000_000)
    assert admin_auth.read_cookie(old, now=1_000_000 + admin_auth.SESSION_SECONDS + 1) is None


def test_a_cookie_valid_one_second_before_expiry_still_works(configured):
    old = admin_auth.make_cookie("boss@example.com", now=1_000_000)
    assert admin_auth.read_cookie(old, now=1_000_000 + admin_auth.SESSION_SECONDS - 1) is not None


def test_a_cookie_signed_with_another_secret_is_refused(configured, monkeypatch):
    forged = admin_auth.make_cookie("boss@example.com")
    monkeypatch.setenv("ADMIN_SESSION_SECRET", "a-different-secret")
    assert admin_auth.read_cookie(forged) is None


@pytest.mark.parametrize("value", ["", "nonsense", "a|b", "a|b|c|d", "boss@example.com|notanint|x"])
def test_a_malformed_cookie_is_refused_rather_than_crashing(configured, value):
    assert admin_auth.read_cookie(value) is None


def test_a_cookie_is_refused_once_the_console_is_switched_off(configured, monkeypatch):
    cookie = admin_auth.make_cookie("boss@example.com")
    monkeypatch.delenv("ADMIN_SESSION_SECRET")
    assert admin_auth.read_cookie(cookie) is None


def test_revoking_an_admin_invalidates_their_live_session(configured, monkeypatch):
    """
    The whole reason the allowlist is re-read per request.

    Removing somebody from VERBALE_ADMIN_EMAILS has to lock them out at once. If the cookie alone
    were trusted, a revoked operator would keep the customer list for the rest of the day.
    """
    cookie = admin_auth.make_cookie("boss@example.com")
    assert admin_auth.read_cookie(cookie) == "boss@example.com"
    monkeypatch.setenv("VERBALE_ADMIN_EMAILS", "second@example.com")
    assert admin_auth.read_cookie(cookie) is None
