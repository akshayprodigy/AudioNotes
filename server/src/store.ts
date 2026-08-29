import Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Everything the licence server knows, which is deliberately almost nothing.
 *
 * Accounts, subscriptions and which devices a licence has been issued to. No meetings, no
 * transcripts, no titles, no counts — the app's claim is that recordings never leave the phone,
 * and the way to keep a claim like that true is to build a server that has nowhere to put them.
 * If a schema change here ever needs a column describing a user's content, something has gone
 * wrong upstream of the schema.
 *
 * SQLite because this is a low-write workload — a row per account, a few per subscription
 * webhook — and a single file that can be backed up with `cp` beats an operational dependency at
 * this size. `Store` is an interface-shaped class so swapping in Postgres later touches this file
 * and nothing else.
 */

export interface Account {
  id: string;
  email: string;
  createdAt: number;
}

export interface Subscription {
  accountId: string;
  plan: string;
  /** Razorpay's subscription id, so a webhook can find the account it belongs to. */
  providerId: string | null;
  status: 'active' | 'past_due' | 'cancelled' | 'none';
  /** Seconds. The paid-through date; tokens are never minted beyond it. */
  currentPeriodEnd: number;
}

export interface Device {
  accountId: string;
  deviceId: string;
  firstSeen: number;
  lastSeen: number;
}

/**
 * How many devices one subscription may cover.
 *
 * "One subscription, all your devices" is the promise, and without a number it becomes one
 * subscription and all your friends. Three is enough for a phone, a spare and a desktop, and
 * small enough that sharing a login is inconvenient rather than free.
 */
export const DEVICE_LIMIT = 3;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts(
     id TEXT PRIMARY KEY,
     email TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS subscriptions(
     account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     plan TEXT NOT NULL,
     provider_id TEXT,
     status TEXT NOT NULL,
     current_period_end INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS subscriptions_provider ON subscriptions(provider_id)`,
  `CREATE TABLE IF NOT EXISTS devices(
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     device_id TEXT NOT NULL,
     -- Hashed, like a password: a leaked database must not yield working credentials.
     refresh_hash TEXT,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     PRIMARY KEY (account_id, device_id)
   )`,
  // Idempotency for webhooks. Razorpay retries on any non-2xx, and a retried
  // `subscription.charged` must not extend a period twice.
  `CREATE TABLE IF NOT EXISTS webhook_events(
     id TEXT PRIMARY KEY,
     received_at INTEGER NOT NULL
   )`,
];

function hashPassword(password: string, salt = randomBytes(16)): string {
  // scrypt rather than a bare hash: it is in the standard library, it is memory-hard, and the
  // alternative here is a dependency for something the platform already does correctly.
  const derived = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, expectedHex] = stored.split(':');
  if (!saltHex || !expectedHex) return false;
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(expectedHex, 'hex');
  // Constant time, so a wrong password cannot be narrowed down by how long the answer took.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export class Store {
  private db: Database.Database;

  constructor(path = process.env.DATABASE_PATH ?? 'licences.db') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    for (const stmt of SCHEMA) this.db.exec(stmt);
  }

  close() {
    this.db.close();
  }

  // ---- accounts ----

  createAccount(email: string, password: string): Account {
    const normalised = email.trim().toLowerCase();
    const id = `acct_${randomBytes(9).toString('hex')}`;
    const createdAt = Math.floor(Date.now() / 1000);
    this.db
      .prepare('INSERT INTO accounts(id,email,password_hash,created_at) VALUES(?,?,?,?)')
      .run(id, normalised, hashPassword(password), createdAt);
    return { id, email: normalised, createdAt };
  }

  /** Null for both "no such account" and "wrong password" — the caller must not tell them apart. */
  authenticate(email: string, password: string): Account | null {
    const row = this.db
      .prepare('SELECT id,email,password_hash,created_at FROM accounts WHERE email=?')
      .get(email.trim().toLowerCase()) as
      | { id: string; email: string; password_hash: string; created_at: number }
      | undefined;
    if (!row) return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    return { id: row.id, email: row.email, createdAt: row.created_at };
  }

  accountByEmail(email: string): Account | null {
    const row = this.db
      .prepare('SELECT id,email,created_at FROM accounts WHERE email=?')
      .get(email.trim().toLowerCase()) as
      | { id: string; email: string; created_at: number }
      | undefined;
    return row ? { id: row.id, email: row.email, createdAt: row.created_at } : null;
  }

  // ---- subscriptions ----

  subscription(accountId: string): Subscription {
    const row = this.db
      .prepare(
        'SELECT account_id,plan,provider_id,status,current_period_end FROM subscriptions WHERE account_id=?',
      )
      .get(accountId) as
      | {
          account_id: string;
          plan: string;
          provider_id: string | null;
          status: string;
          current_period_end: number;
        }
      | undefined;
    if (!row) {
      return { accountId, plan: 'free', providerId: null, status: 'none', currentPeriodEnd: 0 };
    }
    return {
      accountId: row.account_id,
      plan: row.plan,
      providerId: row.provider_id,
      status: row.status as Subscription['status'],
      currentPeriodEnd: row.current_period_end,
    };
  }

  upsertSubscription(sub: Subscription): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions(account_id,plan,provider_id,status,current_period_end)
         VALUES(?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET
           plan=excluded.plan,
           provider_id=excluded.provider_id,
           status=excluded.status,
           current_period_end=excluded.current_period_end`,
      )
      .run(sub.accountId, sub.plan, sub.providerId, sub.status, sub.currentPeriodEnd);
  }

  accountByProviderId(providerId: string): string | null {
    const row = this.db
      .prepare('SELECT account_id FROM subscriptions WHERE provider_id=?')
      .get(providerId) as { account_id: string } | undefined;
    return row?.account_id ?? null;
  }

  // ---- devices ----

  devices(accountId: string): Device[] {
    const rows = this.db
      .prepare(
        'SELECT account_id,device_id,first_seen,last_seen FROM devices WHERE account_id=? ORDER BY first_seen',
      )
      .all(accountId) as {
      account_id: string;
      device_id: string;
      first_seen: number;
      last_seen: number;
    }[];
    return rows.map(r => ({
      accountId: r.account_id,
      deviceId: r.device_id,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    }));
  }

  /**
   * Register a device, or refresh one already known.
   *
   * Returns false when the account is at its limit and this is a new device. A device already on
   * the list always succeeds, so reinstalling the app or refreshing a token can never be the
   * thing that locks someone out of their own subscription.
   */
  touchDevice(accountId: string, deviceId: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db
      .prepare('SELECT device_id FROM devices WHERE account_id=? AND device_id=?')
      .get(accountId, deviceId);
    if (existing) {
      this.db
        .prepare('UPDATE devices SET last_seen=? WHERE account_id=? AND device_id=?')
        .run(now, accountId, deviceId);
      return true;
    }
    if (this.devices(accountId).length >= DEVICE_LIMIT) return false;
    this.db
      .prepare('INSERT INTO devices(account_id,device_id,first_seen,last_seen) VALUES(?,?,?,?)')
      .run(accountId, deviceId, now, now);
    return true;
  }

  /**
   * Issue a refresh credential for one device and return it once, in the clear.
   *
   * The app signs in with an email and password exactly once and keeps this instead. A refresh
   * every couple of weeks should not require the account password to be stored on the device, or
   * re-typed by someone who has long since forgotten it.
   */
  issueRefreshKey(accountId: string, deviceId: string): string {
    const key = randomBytes(24).toString('base64url');
    this.db
      .prepare('UPDATE devices SET refresh_hash=? WHERE account_id=? AND device_id=?')
      .run(hashPassword(key), accountId, deviceId);
    return key;
  }

  /** The account this refresh key belongs to, or null. Device-scoped: a key works on one device. */
  accountForRefreshKey(deviceId: string, key: string): string | null {
    const rows = this.db
      .prepare('SELECT account_id,refresh_hash FROM devices WHERE device_id=?')
      .all(deviceId) as { account_id: string; refresh_hash: string | null }[];
    for (const row of rows) {
      if (row.refresh_hash && verifyPassword(key, row.refresh_hash)) return row.account_id;
    }
    return null;
  }

  forgetDevice(accountId: string, deviceId: string): void {
    this.db
      .prepare('DELETE FROM devices WHERE account_id=? AND device_id=?')
      .run(accountId, deviceId);
  }

  // ---- webhook idempotency ----

  /** True the first time an event id is seen, false every time after. */
  claimEvent(eventId: string): boolean {
    try {
      this.db
        .prepare('INSERT INTO webhook_events(id,received_at) VALUES(?,?)')
        .run(eventId, Math.floor(Date.now() / 1000));
      return true;
    } catch {
      return false;
    }
  }
}
