"""
Upgrading a database that already exists.

`CREATE TABLE IF NOT EXISTS` is not a migration: against a table that already exists with the wrong
shape it silently does nothing, and the mismatch stays invisible until a query hits the missing
column — in production, on the payment path. These tests build the old schema by hand and check
that opening it with the current code both upgrades it and keeps everything that was in it.
"""

import sqlite3

import pytest

from app.store import SCHEMA_VERSION, Store, hash_password

V0 = [
    """CREATE TABLE accounts(
         id TEXT PRIMARY KEY,
         email TEXT UNIQUE NOT NULL,
         password_hash TEXT NOT NULL,
         created_at INTEGER NOT NULL)""",
    """CREATE TABLE subscriptions(
         account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
         plan TEXT NOT NULL,
         provider_id TEXT,
         status TEXT NOT NULL,
         current_period_end INTEGER NOT NULL)""",
    """CREATE TABLE devices(
         account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         device_id TEXT NOT NULL,
         refresh_hash TEXT,
         first_seen INTEGER NOT NULL,
         last_seen INTEGER NOT NULL,
         PRIMARY KEY (account_id, device_id))""",
    """CREATE TABLE webhook_events(id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)""",
]


@pytest.fixture
def old_db(tmp_path):
    """A database as the previous release left it: one paying customer with a device."""
    path = str(tmp_path / "v0.db")
    db = sqlite3.connect(path)
    for stmt in V0:
        db.execute(stmt)
    db.execute("INSERT INTO accounts VALUES(?,?,?,?)",
               ("acct_old", "old@example.com", hash_password("password123"), 1000))
    db.execute("INSERT INTO subscriptions VALUES(?,?,?,?,?)",
               ("acct_old", "pro", "sub_razorpay", "active", 2_000_000_000))
    db.execute("INSERT INTO devices VALUES(?,?,?,?,?)",
               ("acct_old", "their-phone", hash_password("refresh-key"), 1000, 1000))
    db.commit()
    db.close()
    return path


def test_the_old_database_is_at_version_zero(old_db):
    db = sqlite3.connect(old_db)
    assert db.execute("PRAGMA user_version").fetchone()[0] == 0
    db.close()


def test_opening_it_migrates_it(old_db):
    store = Store(old_db)
    assert store._db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION  # noqa: SLF001
    store.close()


def test_the_paying_customer_survives(old_db):
    """The whole point. A migration that loses a subscriber is worse than no migration."""
    store = Store(old_db)
    account = store.authenticate("old@example.com", "password123")
    assert account is not None and account.id == "acct_old"

    sub = store.subscription("acct_old")
    assert sub.status == "active"
    assert sub.current_period_end == 2_000_000_000
    assert sub.provider_id == "sub_razorpay"
    store.close()


def test_an_existing_subscription_is_assumed_to_be_razorpay(old_db):
    """It is the only provider that existed when those rows were written."""
    store = Store(old_db)
    assert store.subscription("acct_old").provider == "razorpay"
    assert store.account_by_provider_id("sub_razorpay", provider="razorpay") == "acct_old"
    store.close()


def test_the_device_and_its_refresh_key_survive(old_db):
    store = Store(old_db)
    assert store.account_for_refresh_key("their-phone", "refresh-key") == "acct_old"
    store.close()


def test_credentials_become_optional_after_migrating(old_db):
    """The rebuilt accounts table is what lets a Play purchase create an account with neither."""
    store = Store(old_db)
    play_account = store.create_account()
    assert play_account.id != "acct_old"
    store.close()


def test_a_migrated_account_with_no_password_cannot_be_signed_into(old_db):
    """A null password_hash must be a refusal, not an empty-string comparison that lets anyone in."""
    store = Store(old_db)
    account = store.create_account()
    with store._lock:  # noqa: SLF001
        store._db.execute("UPDATE accounts SET email=? WHERE id=?",  # noqa: SLF001
                          ("passwordless@example.com", account.id))
        store._db.commit()  # noqa: SLF001
    assert store.authenticate("passwordless@example.com", "") is None
    assert store.authenticate("passwordless@example.com", "anything") is None
    store.close()


def test_migrating_twice_is_a_no_op(old_db):
    """Every deploy reopens the database; the second one must not rebuild the table again."""
    Store(old_db).close()
    store = Store(old_db)
    assert store.authenticate("old@example.com", "password123") is not None
    assert store._db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION  # noqa: SLF001
    store.close()


def test_foreign_keys_are_back_on_after_the_rebuild(old_db):
    """The rebuild turns them off. Left off, deleting an account would silently orphan its rows."""
    store = Store(old_db)
    assert store._db.execute("PRAGMA foreign_keys").fetchone()[0] == 1  # noqa: SLF001
    store.delete_account("acct_old")
    with store._lock:  # noqa: SLF001
        for table in ("subscriptions", "devices"):
            left = store._db.execute(  # noqa: SLF001
                f"SELECT COUNT(*) AS n FROM {table} WHERE account_id='acct_old'").fetchone()["n"]
            assert left == 0, f"{table} was orphaned — the cascade did not run"
    store.close()


def test_a_fresh_database_is_already_at_the_current_version(tmp_path):
    store = Store(str(tmp_path / "fresh.db"))
    assert store._db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION  # noqa: SLF001
    store.close()
