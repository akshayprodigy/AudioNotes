"""The store, including the parts a leaked database file would expose."""

import sqlite3

from app.store import DEVICE_LIMIT, Store, hash_password, verify_password


def test_a_password_round_trips():
    stored = hash_password("correct horse battery staple")
    assert verify_password("correct horse battery staple", stored)
    assert not verify_password("Correct horse battery staple", stored)


def test_two_hashes_of_one_password_differ():
    """Salted, so a leaked database does not reveal which users share a password."""
    assert hash_password("same") != hash_password("same")


def test_a_malformed_hash_is_not_a_crash():
    assert not verify_password("x", "")
    assert not verify_password("x", "nocolon")
    assert not verify_password("x", "zz:zz")


def test_the_password_is_not_stored_in_the_clear(store, tmp_path):
    store.create_account("a@example.com", "hunter2hunter2")
    raw = open(store._path, "rb").read()  # noqa: SLF001 -- the point is to read it as an attacker
    assert b"hunter2hunter2" not in raw


def test_email_is_normalised_on_the_way_in_and_out(store):
    store.create_account("  Mixed@Example.COM ", "password123")
    assert store.authenticate("mixed@example.com", "password123") is not None
    assert store.authenticate("MIXED@EXAMPLE.com", "password123") is not None


def test_wrong_password_and_no_account_are_indistinguishable(store):
    store.create_account("a@example.com", "password123")
    assert store.authenticate("a@example.com", "wrong") is None
    assert store.authenticate("nobody@example.com", "password123") is None


def test_an_account_cannot_be_registered_twice(store):
    store.create_account("a@example.com", "password123")
    try:
        store.create_account("A@Example.com", "password123")
    except sqlite3.IntegrityError:
        return
    raise AssertionError("the unique index on email did not hold")


def test_a_new_account_reads_as_free_with_no_subscription_row(store):
    account = store.create_account("a@example.com", "password123")
    sub = store.subscription(account.id)
    assert (sub.plan, sub.status, sub.current_period_end) == ("free", "none", 0)


def test_devices_stop_at_the_limit_but_known_ones_always_re_register(store):
    account = store.create_account("a@example.com", "password123")
    for i in range(DEVICE_LIMIT):
        assert store.touch_device(account.id, f"dev_{i}")
    assert not store.touch_device(account.id, "dev_extra")
    assert store.touch_device(account.id, "dev_0")
    assert len(store.devices(account.id)) == DEVICE_LIMIT


def test_forgetting_a_device_frees_the_slot(store):
    account = store.create_account("a@example.com", "password123")
    for i in range(DEVICE_LIMIT):
        store.touch_device(account.id, f"dev_{i}")
    store.forget_device(account.id, "dev_1")
    assert store.touch_device(account.id, "dev_new")


def test_a_refresh_key_is_scoped_to_one_device(store):
    """A key lifted off one phone must not mint tokens for another."""
    account = store.create_account("a@example.com", "password123")
    store.touch_device(account.id, "dev_1")
    store.touch_device(account.id, "dev_2")
    key = store.issue_refresh_key(account.id, "dev_1")
    assert store.account_for_refresh_key("dev_1", key) == account.id
    assert store.account_for_refresh_key("dev_2", key) is None


def test_a_refresh_key_is_not_stored_in_the_clear(store):
    account = store.create_account("a@example.com", "password123")
    store.touch_device(account.id, "dev_1")
    key = store.issue_refresh_key(account.id, "dev_1")
    raw = open(store._path, "rb").read()  # noqa: SLF001
    assert key.encode() not in raw


def test_reissuing_a_refresh_key_retires_the_old_one(store):
    account = store.create_account("a@example.com", "password123")
    store.touch_device(account.id, "dev_1")
    first = store.issue_refresh_key(account.id, "dev_1")
    store.issue_refresh_key(account.id, "dev_1")
    assert store.account_for_refresh_key("dev_1", first) is None


def test_the_store_survives_being_reopened(tmp_path):
    path = str(tmp_path / "reopen.db")
    first = Store(path)
    account = first.create_account("a@example.com", "password123")
    first.close()

    second = Store(path)
    assert second.authenticate("a@example.com", "password123").id == account.id
    second.close()
