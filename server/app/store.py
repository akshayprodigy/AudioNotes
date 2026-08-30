"""
Everything the licence server knows, which is deliberately almost nothing.

Accounts, subscriptions and which devices a licence has been issued to. No meetings, no transcripts,
no titles, no counts -- the app's claim is that recordings never leave the phone, and the way to keep
a claim like that true is to build a server that has nowhere to put them. If a schema change here
ever needs a column describing a user's content, something has gone wrong upstream of the schema.

SQLite because this is a low-write workload -- a row per account, a few per subscription webhook --
and a single file that can be backed up with ``cp`` beats an operational dependency at this size.
``Store`` is the only module that touches SQL, so swapping in Postgres later touches this file and
nothing else.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass

#: How many devices one subscription may cover.
#:
#: "One subscription, all your devices" is the promise, and without a number it becomes one
#: subscription and all your friends. Three is enough for a phone, a spare and a desktop, and small
#: enough that sharing a login is inconvenient rather than free.
DEVICE_LIMIT = 3

#: How long a password reset link works for.
#:
#: Short, because the link is a bearer credential sitting in an inbox — which is exactly where a
#: stolen laptop or a shared family screen finds it. Long enough that someone who opens their mail
#: on the train can still use it.
PASSWORD_RESET_TTL_SECONDS = 60 * 60

#: scrypt cost. These are Node's ``scryptSync`` defaults, kept identical so a database written by
#: the previous server still authenticates against this one.
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P, _SCRYPT_DKLEN = 16384, 8, 1, 64
_SCRYPT_MAXMEM = 128 * _SCRYPT_N * _SCRYPT_R * _SCRYPT_P * 2


@dataclass(frozen=True)
class Account:
    id: str
    email: str
    created_at: int


@dataclass(frozen=True)
class Subscription:
    account_id: str
    plan: str
    #: The provider's own id — Razorpay's subscription id, or Play's purchase token. It is how an
    #: incoming webhook or a re-verification finds the account it belongs to.
    provider_id: str | None
    #: One of active | past_due | cancelled | none.
    status: str
    #: Seconds. The paid-through date; tokens are never minted beyond it.
    current_period_end: int
    #: 'razorpay' or 'play'. Defaulted so every existing caller keeps working, but it decides how
    #: the subscription is re-checked and how it is cancelled — the two are not interchangeable.
    provider: str = "razorpay"


@dataclass(frozen=True)
class Device:
    account_id: str
    device_id: str
    first_seen: int
    last_seen: int


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS accounts(
         id TEXT PRIMARY KEY,
         -- Both nullable, because a Play Billing purchase creates an account with neither. The
         -- purchase token is that account's credential; Google already knows who the person is,
         -- and making them invent a password to buy something they have just paid for is friction
         -- for nothing. They can add an email later to use the subscription on a desktop.
         -- SQLite lets a UNIQUE column hold many NULLs, which is exactly the behaviour wanted.
         email TEXT UNIQUE,
         password_hash TEXT,
         created_at INTEGER NOT NULL
       )""",
    """CREATE TABLE IF NOT EXISTS subscriptions(
         account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
         plan TEXT NOT NULL,
         -- 'razorpay' or 'play'. Which one decides how the subscription is re-checked and how it
         -- is cancelled, and the two are not interchangeable: cancelling a Play subscription
         -- through Razorpay's API would silently do nothing.
         provider TEXT NOT NULL DEFAULT 'razorpay',
         provider_id TEXT,
         status TEXT NOT NULL,
         current_period_end INTEGER NOT NULL
       )""",
    "CREATE INDEX IF NOT EXISTS subscriptions_provider ON subscriptions(provider_id)",
    """CREATE TABLE IF NOT EXISTS devices(
         account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         device_id TEXT NOT NULL,
         -- Hashed, like a password: a leaked database must not yield working credentials.
         refresh_hash TEXT,
         first_seen INTEGER NOT NULL,
         last_seen INTEGER NOT NULL,
         PRIMARY KEY (account_id, device_id)
       )""",
    # Idempotency for webhooks. Razorpay retries on any non-2xx, and a retried
    # `subscription.charged` must not extend a period twice.
    """CREATE TABLE IF NOT EXISTS webhook_events(
         id TEXT PRIMARY KEY,
         received_at INTEGER NOT NULL
       )""",
    """CREATE TABLE IF NOT EXISTS password_resets(
         -- The token is stored hashed, so this table cannot be read out of a database dump and
         -- used. SHA-256 rather than scrypt: the token is 32 random bytes, so there is nothing to
         -- brute force and a lookup should not cost 100ms.
         token_hash TEXT PRIMARY KEY,
         account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         used_at INTEGER
       )""",
]


def _token_hash(token: str) -> str:
    """Reset tokens are high-entropy already; a fast digest is the right tool and an indexable one."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hash_password(password: str, salt: bytes | None = None) -> str:
    # scrypt rather than a bare hash: it is in the standard library, it is memory-hard, and the
    # alternative here is a dependency for something the platform already does correctly.
    salt = secrets.token_bytes(16) if salt is None else salt
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
        maxmem=_SCRYPT_MAXMEM,
    )
    return f"{salt.hex()}:{derived.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt_hex, _, expected_hex = stored.partition(":")
    if not salt_hex or not expected_hex:
        return False
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(expected_hex)
    except ValueError:
        return False
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=len(expected),
        maxmem=_SCRYPT_MAXMEM,
    )
    # Constant time, so a wrong password cannot be narrowed down by how long the answer took.
    return hmac.compare_digest(derived, expected)


#: Bumped whenever MIGRATIONS grows. Stored in SQLite's own `user_version`.
SCHEMA_VERSION = 1


def _migrate(db: sqlite3.Connection) -> None:
    """
    Bring an existing database up to SCHEMA_VERSION.

    `CREATE TABLE IF NOT EXISTS` is not a migration: it silently does nothing to a table that
    already exists with the wrong shape, so a deployed database would keep its old columns while
    the code assumed new ones. That failure is invisible until a query hits the missing column, in
    production, on the payment path.

    Versions are tracked in SQLite's `user_version`, which costs no table and no query.
    """
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version >= SCHEMA_VERSION:
        return

    if version < 1:
        columns = {r[1] for r in db.execute("PRAGMA table_info(subscriptions)")}
        if columns and "provider" not in columns:
            db.execute(
                "ALTER TABLE subscriptions ADD COLUMN provider TEXT NOT NULL DEFAULT 'razorpay'"
            )

        # Making a column nullable needs a table rebuild; SQLite has no ALTER COLUMN. Done inside
        # the transaction below so a crash half way leaves the old table intact rather than a
        # database with no accounts in it.
        info = list(db.execute("PRAGMA table_info(accounts)"))
        not_null = {r[1] for r in info if r[3]}
        if info and ("email" in not_null or "password_hash" in not_null):
            # Off for the rebuild. With foreign keys ON, `DROP TABLE accounts` performs an
            # implicit DELETE FROM, which fires ON DELETE CASCADE and takes every subscription and
            # device with it — a migration that silently deletes every paying customer.
            db.execute("PRAGMA foreign_keys = OFF")
            db.execute("""CREATE TABLE accounts_migrated(
                            id TEXT PRIMARY KEY,
                            email TEXT UNIQUE,
                            password_hash TEXT,
                            created_at INTEGER NOT NULL)""")
            db.execute("INSERT INTO accounts_migrated(id,email,password_hash,created_at) "
                       "SELECT id,email,password_hash,created_at FROM accounts")
            db.execute("DROP TABLE accounts")
            db.execute("ALTER TABLE accounts_migrated RENAME TO accounts")
            # NOT turned back on here. `PRAGMA foreign_keys` is a no-op inside a transaction, and
            # the INSERT above opened one — so the statement would be silently ignored and the
            # connection would carry on with foreign keys off. Store.__init__ re-asserts it after
            # the commit, which is the only place it can take effect.

    db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


class Store:
    """
    One connection guarded by one lock.

    Uvicorn runs the sync request handlers on a thread pool, so the connection is shared across
    threads and needs ``check_same_thread=False``. A single lock around every statement is the
    boring choice, and at a few requests a minute it costs nothing while removing an entire class of
    interleaving bug.
    """

    def __init__(self, path: str | None = None) -> None:
        self._path = path or os.environ.get("DATABASE_PATH", "licences.db")
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self._path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode = WAL")
            for stmt in SCHEMA:
                self._db.execute(stmt)
            _migrate(self._db)
            self._db.commit()
            # After the commit, and last. PRAGMA foreign_keys is ignored inside a transaction, and
            # a migration that rebuilds a table has to turn it off to do so — so this is the only
            # point at which enabling it reliably takes effect. Get it wrong and deleting an
            # account orphans its subscription and devices instead of cascading, silently.
            self._db.execute("PRAGMA foreign_keys = ON")

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ---- accounts ----

    def create_account(self, email: str | None = None, password: str | None = None) -> Account:
        """
        Create an account, with or without credentials.

        Both are optional because a Play Billing purchase creates an account with neither: Google
        has already established who the person is, and demanding they invent a password to receive
        something they just paid for is friction that buys nothing. Such an account is reached by
        its purchase token until the owner chooses to add an email.
        """
        normalised = email.strip().lower() if email else None
        account_id = f"acct_{secrets.token_hex(9)}"
        created_at = int(time.time())
        with self._lock:
            self._db.execute(
                "INSERT INTO accounts(id,email,password_hash,created_at) VALUES(?,?,?,?)",
                (account_id, normalised, hash_password(password) if password else None, created_at),
            )
            self._db.commit()
        return Account(id=account_id, email=normalised or "", created_at=created_at)

    def authenticate(self, email: str, password: str) -> Account | None:
        """Null for both "no such account" and "wrong password" -- the caller must not tell them apart."""
        with self._lock:
            row = self._db.execute(
                "SELECT id,email,password_hash,created_at FROM accounts WHERE email=?",
                (email.strip().lower(),),
            ).fetchone()
        if row is None:
            return None
        # An account created by a Play purchase has no password. Passing None to verify_password
        # would be a type error at best and, worse, an empty-string comparison that lets anybody in.
        if not row["password_hash"]:
            return None
        if not verify_password(password, row["password_hash"]):
            return None
        return Account(id=row["id"], email=row["email"], created_at=row["created_at"])

    def account_by_email(self, email: str) -> Account | None:
        with self._lock:
            row = self._db.execute(
                "SELECT id,email,created_at FROM accounts WHERE email=?",
                (email.strip().lower(),),
            ).fetchone()
        if row is None:
            return None
        return Account(id=row["id"], email=row["email"], created_at=row["created_at"])

    def set_password(self, account_id: str, password: str) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE accounts SET password_hash=? WHERE id=?",
                (hash_password(password), account_id),
            )
            self._db.commit()

    # ---- subscriptions ----

    def subscription(self, account_id: str) -> Subscription:
        with self._lock:
            row = self._db.execute(
                "SELECT account_id,plan,provider,provider_id,status,current_period_end "
                "FROM subscriptions WHERE account_id=?",
                (account_id,),
            ).fetchone()
        if row is None:
            return Subscription(
                account_id=account_id,
                plan="free",
                provider_id=None,
                status="none",
                current_period_end=0,
            )
        return Subscription(
            account_id=row["account_id"],
            plan=row["plan"],
            provider=row["provider"],
            provider_id=row["provider_id"],
            status=row["status"],
            current_period_end=row["current_period_end"],
        )

    def upsert_subscription(self, sub: Subscription) -> None:
        with self._lock:
            self._db.execute(
                """INSERT INTO subscriptions(account_id,plan,provider,provider_id,status,current_period_end)
                   VALUES(?,?,?,?,?,?)
                   ON CONFLICT(account_id) DO UPDATE SET
                     plan=excluded.plan,
                     provider=excluded.provider,
                     provider_id=excluded.provider_id,
                     status=excluded.status,
                     current_period_end=excluded.current_period_end""",
                (
                    sub.account_id,
                    sub.plan,
                    sub.provider,
                    sub.provider_id,
                    sub.status,
                    sub.current_period_end,
                ),
            )
            self._db.commit()

    def account_by_provider_id(self, provider_id: str, provider: str = "razorpay") -> str | None:
        """
        The account a provider's subscription id belongs to.

        Scoped by provider: the two id spaces are unrelated, and a Razorpay webhook must never be
        able to address a Play subscription by guessing a string that happens to collide.
        """
        with self._lock:
            row = self._db.execute(
                "SELECT account_id FROM subscriptions WHERE provider_id=? AND provider=?",
                (provider_id, provider),
            ).fetchone()
        return row["account_id"] if row else None

    # ---- devices ----

    def devices(self, account_id: str) -> list[Device]:
        with self._lock:
            rows = self._db.execute(
                "SELECT account_id,device_id,first_seen,last_seen FROM devices "
                "WHERE account_id=? ORDER BY first_seen",
                (account_id,),
            ).fetchall()
        return [
            Device(
                account_id=r["account_id"],
                device_id=r["device_id"],
                first_seen=r["first_seen"],
                last_seen=r["last_seen"],
            )
            for r in rows
        ]

    def touch_device(self, account_id: str, device_id: str) -> bool:
        """
        Register a device, or refresh one already known.

        Returns False when the account is at its limit and this is a new device. A device already on
        the list always succeeds, so reinstalling the app or refreshing a token can never be the
        thing that locks someone out of their own subscription.
        """
        now = int(time.time())
        with self._lock:
            existing = self._db.execute(
                "SELECT device_id FROM devices WHERE account_id=? AND device_id=?",
                (account_id, device_id),
            ).fetchone()
            if existing:
                self._db.execute(
                    "UPDATE devices SET last_seen=? WHERE account_id=? AND device_id=?",
                    (now, account_id, device_id),
                )
                self._db.commit()
                return True
            count = self._db.execute(
                "SELECT COUNT(*) AS n FROM devices WHERE account_id=?", (account_id,)
            ).fetchone()["n"]
            if count >= DEVICE_LIMIT:
                return False
            self._db.execute(
                "INSERT INTO devices(account_id,device_id,first_seen,last_seen) VALUES(?,?,?,?)",
                (account_id, device_id, now, now),
            )
            self._db.commit()
            return True

    def issue_refresh_key(self, account_id: str, device_id: str) -> str:
        """
        Issue a refresh credential for one device and return it once, in the clear.

        The app signs in with an email and password exactly once and keeps this instead. A refresh
        every couple of weeks should not require the account password to be stored on the device, or
        re-typed by someone who has long since forgotten it.
        """
        key = secrets.token_urlsafe(24)
        with self._lock:
            self._db.execute(
                "UPDATE devices SET refresh_hash=? WHERE account_id=? AND device_id=?",
                (hash_password(key), account_id, device_id),
            )
            self._db.commit()
        return key

    def account_for_refresh_key(self, device_id: str, key: str) -> str | None:
        """The account this refresh key belongs to, or None. Device-scoped: a key works on one device."""
        with self._lock:
            rows = self._db.execute(
                "SELECT account_id,refresh_hash FROM devices WHERE device_id=?", (device_id,)
            ).fetchall()
        for row in rows:
            if row["refresh_hash"] and verify_password(key, row["refresh_hash"]):
                return row["account_id"]
        return None

    def forget_device(self, account_id: str, device_id: str) -> None:
        with self._lock:
            self._db.execute(
                "DELETE FROM devices WHERE account_id=? AND device_id=?", (account_id, device_id)
            )
            self._db.commit()

    def delete_account(self, account_id: str) -> None:
        """
        Remove an account and everything hanging off it.

        Subscriptions, devices and reset tokens all cascade from the foreign keys, which is why
        `PRAGMA foreign_keys = ON` at connect time is load-bearing rather than tidy: without it
        SQLite would leave the children behind and this would quietly become a partial delete.

        There is nothing else to remove. No meeting, transcript or title was ever here.
        """
        with self._lock:
            self._db.execute("DELETE FROM accounts WHERE id=?", (account_id,))
            self._db.commit()

    # ---- password resets ----

    def create_password_reset(self, account_id: str, now: int | None = None) -> str:
        """
        Issue a single-use reset token and return it once, in the clear.

        Any outstanding tokens for the account are dropped first. Two live reset links means a
        request someone did not make stays usable after they have made one they did.
        """
        now = int(time.time()) if now is None else now
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._db.execute("DELETE FROM password_resets WHERE account_id=?", (account_id,))
            self._db.execute(
                "INSERT INTO password_resets(token_hash,account_id,created_at,expires_at) "
                "VALUES(?,?,?,?)",
                (_token_hash(token), account_id, now, now + PASSWORD_RESET_TTL_SECONDS),
            )
            self._db.commit()
        return token

    def peek_password_reset(self, token: str, now: int | None = None) -> str | None:
        """The account a token is good for, without spending it. For rendering the form."""
        now = int(time.time()) if now is None else now
        with self._lock:
            row = self._db.execute(
                "SELECT account_id,expires_at,used_at FROM password_resets WHERE token_hash=?",
                (_token_hash(token),),
            ).fetchone()
        if row is None or row["used_at"] is not None or row["expires_at"] <= now:
            return None
        return row["account_id"]

    def consume_password_reset(self, token: str, now: int | None = None) -> str | None:
        """
        Spend a token, returning the account it belonged to.

        The UPDATE carries the used_at IS NULL condition rather than checking first and writing
        after, so two submissions of the same link race in SQLite and exactly one wins.
        """
        now = int(time.time()) if now is None else now
        with self._lock:
            cursor = self._db.execute(
                "UPDATE password_resets SET used_at=? "
                "WHERE token_hash=? AND used_at IS NULL AND expires_at > ?",
                (now, _token_hash(token), now),
            )
            if cursor.rowcount != 1:
                self._db.commit()
                return None
            row = self._db.execute(
                "SELECT account_id FROM password_resets WHERE token_hash=?",
                (_token_hash(token),),
            ).fetchone()
            self._db.commit()
        return row["account_id"] if row else None

    def clear_refresh_keys(self, account_id: str) -> None:
        """
        Retire every device's renewal credential, without removing the devices.

        Called on a password reset. A reset is the moment you want anyone who got in evicted, and
        the password alone does not do that: a device that already signed in holds a refresh key
        that never expires and is not derived from the password. The rows stay, so the owner is
        not pushed over the device limit by their own reset — they simply sign in again.
        """
        with self._lock:
            self._db.execute(
                "UPDATE devices SET refresh_hash=NULL WHERE account_id=?", (account_id,)
            )
            self._db.commit()

    # ---- webhook idempotency ----

    def claim_event(self, event_id: str) -> bool:
        """True the first time an event id is seen, False every time after."""
        with self._lock:
            try:
                self._db.execute(
                    "INSERT INTO webhook_events(id,received_at) VALUES(?,?)",
                    (event_id, int(time.time())),
                )
                self._db.commit()
                return True
            except sqlite3.IntegrityError:
                return False
