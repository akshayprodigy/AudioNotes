"""
The read side of the admin console.

The question these answer is "who has subscribed?", so the tests are mostly about the accounts that
are easy to leave out of the answer: the ones that never subscribed, the ones a Play purchase
created with no email, and the ones whose subscription has since lapsed.
"""

import time

import pytest

from app.store import Subscription

NOW = 1_800_000_000


def account(store, email, created_at=NOW, status=None, period_end=NOW + 86400):
    acct = store.create_account(email, "password123")
    store._db.execute("UPDATE accounts SET created_at=? WHERE id=?", (created_at, acct.id))
    store._db.commit()
    if status:
        store.upsert_subscription(
            Subscription(account_id=acct.id, plan="pro", provider_id=f"tok_{email}",
                         status=status, current_period_end=period_end)
        )
    return acct


# ---- the overview ----

def test_an_empty_database_counts_zero(store):
    counts = store.admin_overview(now=NOW)
    assert counts["accounts"] == 0 and counts["active"] == 0
    assert counts["never_subscribed"] == 0


def test_each_status_is_counted_separately(store):
    account(store, "a@x.com", status="active")
    account(store, "b@x.com", status="active")
    account(store, "c@x.com", status="past_due")
    account(store, "d@x.com", status="cancelled")
    account(store, "e@x.com")

    counts = store.admin_overview(now=NOW)
    assert counts["accounts"] == 5
    assert counts["active"] == 2
    assert counts["past_due"] == 1
    assert counts["cancelled"] == 1
    assert counts["never_subscribed"] == 1


def test_signups_are_counted_by_age(store):
    account(store, "recent@x.com", created_at=NOW - 2 * 86400)
    account(store, "midway@x.com", created_at=NOW - 20 * 86400)
    account(store, "ancient@x.com", created_at=NOW - 200 * 86400)

    counts = store.admin_overview(now=NOW)
    assert counts["new_7d"] == 1
    assert counts["new_30d"] == 2
    assert counts["accounts"] == 3


# ---- the table ----

def test_an_account_with_no_subscription_still_appears(store):
    """The LEFT JOIN. Without it the console answers a narrower question than the one asked."""
    account(store, "free@x.com")
    rows = store.admin_accounts()
    assert len(rows) == 1
    assert rows[0].email == "free@x.com"
    assert rows[0].status == "none" and rows[0].plan == "free"


def test_a_subscribed_account_carries_its_subscription(store):
    account(store, "paid@x.com", status="active", period_end=NOW + 999)
    row = store.admin_accounts()[0]
    assert row.status == "active" and row.plan == "pro"
    assert row.provider == "play" and row.current_period_end == NOW + 999


def test_rows_come_back_newest_first(store):
    account(store, "old@x.com", created_at=NOW - 1000)
    account(store, "new@x.com", created_at=NOW)
    assert [r.email for r in store.admin_accounts()] == ["new@x.com", "old@x.com"]


def test_filtering_by_status_includes_accounts_with_no_subscription_row(store):
    """`COALESCE(status,'none')` — filtering for 'none' must find them, not miss them."""
    account(store, "free@x.com")
    account(store, "paid@x.com", status="active")
    assert [r.email for r in store.admin_accounts(status="none")] == ["free@x.com"]
    assert [r.email for r in store.admin_accounts(status="active")] == ["paid@x.com"]


def test_search_matches_a_substring_of_the_email(store):
    account(store, "alice@example.com")
    account(store, "bob@other.com")
    assert [r.email for r in store.admin_accounts(search="example")] == ["alice@example.com"]
    assert [r.email for r in store.admin_accounts(search="bob")] == ["bob@other.com"]
    assert store.admin_accounts(search="nobody") == []


def test_devices_are_counted_and_the_latest_sighting_reported(store):
    acct = account(store, "a@x.com", status="active")
    store.touch_device(acct.id, "phone")
    store.touch_device(acct.id, "tablet")
    row = store.admin_accounts()[0]
    assert row.device_count == 2
    assert row.last_seen >= int(time.time()) - 5


def test_an_account_with_no_devices_reports_zero_not_null(store):
    account(store, "a@x.com")
    row = store.admin_accounts()[0]
    assert row.device_count == 0 and row.last_seen == 0


def test_the_page_size_is_bounded_however_it_is_asked(store):
    for i in range(12):
        account(store, f"a{i}@x.com", created_at=NOW - i)
    assert len(store.admin_accounts(limit=5)) == 5
    assert len(store.admin_accounts(limit=10_000)) == 12, "clamped, not refused"
    assert len(store.admin_accounts(limit=0)) == 1, "never zero rows by accident"


def test_offset_pages_without_repeating_a_row(store):
    for i in range(6):
        account(store, f"a{i}@x.com", created_at=NOW - i)
    first = [r.email for r in store.admin_accounts(limit=3, offset=0)]
    second = [r.email for r in store.admin_accounts(limit=3, offset=3)]
    assert len(set(first) & set(second)) == 0
    assert len(set(first) | set(second)) == 6


def test_the_count_matches_the_filters(store):
    account(store, "a@x.com", status="active")
    account(store, "b@x.com", status="active")
    account(store, "c@x.com")
    assert store.admin_account_count() == 3
    assert store.admin_account_count(status="active") == 2
    assert store.admin_account_count(search="c@") == 1


# ---- one account ----

def test_a_single_account_reads_back(store):
    acct = account(store, "a@x.com", status="active")
    row = store.admin_account(acct.id)
    assert row is not None and row.email == "a@x.com" and row.status == "active"


def test_an_unknown_account_is_none_not_an_error(store):
    assert store.admin_account("no-such-id") is None


def test_a_play_account_with_no_email_still_appears(store):
    """A Play purchase creates an account with neither email nor password. It is still a customer."""
    acct = store.create_account()
    store.upsert_subscription(
        Subscription(account_id=acct.id, plan="pro", provider_id="tok", status="active",
                     current_period_end=NOW)
    )
    rows = store.admin_accounts()
    assert len(rows) == 1 and rows[0].email is None and rows[0].status == "active"


# ---- what must never come out ----

def test_the_row_type_carries_no_secret(store):
    """
    The console renders whatever this type holds, so what it holds is the whole of the exposure.

    A field added here that happens to be named password_hash would be published to a browser by
    every template at once; this is the test that would fail first.
    """
    account(store, "a@x.com", status="active")
    row = store.admin_accounts()[0]
    fields = set(vars(row))
    assert not fields & {"password_hash", "refresh_hash", "token_hash", "password"}


def test_no_secret_leaks_through_the_row_values(store):
    """Belt and braces: not just absent by name, but absent by value."""
    acct = store.create_account("a@x.com", "a-very-recognisable-password")
    store.touch_device(acct.id, "phone")
    store.issue_refresh_key(acct.id, "phone")
    hash_row = store._db.execute(
        "SELECT password_hash FROM accounts WHERE id=?", (acct.id,)).fetchone()
    refresh_row = store._db.execute(
        "SELECT refresh_hash FROM devices WHERE account_id=?", (acct.id,)).fetchone()

    rendered = repr(store.admin_accounts()[0])
    assert hash_row["password_hash"] not in rendered
    assert refresh_row["refresh_hash"] not in rendered
    assert "a-very-recognisable-password" not in rendered
