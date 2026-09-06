# The Privacy Proof Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's unverifiable "nothing is uploaded" promise with a count of every byte that actually leaves the phone.

**Architecture:** One ledger table in the existing encrypted database, written at the four call sites that already own the app's only network access, read by one screen that shows a monthly summary and the full log behind it. A CI script fails the build if a fifth call site ever appears, which is the part that keeps the screen true after release.

**Tech Stack:** TypeScript / React Native 0.86, Kotlin (Android), SQLCipher, Python 3 (the CI check).

**Spec:** `docs/superpowers/specs/2026-09-06-privacy-proof-design.md`

---

## Build and test commands

`cmake` and `adb` are not on PATH on this machine.

```bash
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
export PATH=$ANDROID_HOME/platform-tools:$PATH

npm test && npx tsc --noEmit                             # TypeScript
cd android && ./gradlew :app:testDebugUnitTest           # Kotlin unit tests
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a \
  -PAUDIONOTES_DEBUG_UPLOAD_SIGNING                      # app builds
python3 scripts/check-network-egress.py                  # the new invariant

# On-device — NEVER `./gradlew connectedDebugAndroidTest`; it uninstalls the app and wipes the
# models and the recordings database.
npm run test:device
```

**Lint baseline:** the repo has ~467 pre-existing eslint errors. Compare against `main` for the
files you touched rather than expecting zero.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/privacy/ledger.ts` | Record an egress event; read the log. The only writer API. | Create |
| `src/privacy/summary.ts` | Pure: ledger rows → the numbers the screen shows | Create |
| `src/privacy/__tests__/summary.test.ts` | That arithmetic, including the month boundary | Create |
| `src/privacy/__tests__/ledger.test.ts` | Recording, and that a failed write is surfaced | Create |
| `src/screens/PrivacyScreen.tsx` | Summary + expandable log | Create |
| `src/billing/subscription.ts` | Record the licence call | Modify |
| `src/telemetry/crash.ts` | Record a crash upload from `beforeSend` | Modify |
| `android/.../pipeline/ModelManagerModule.kt` | Record each model file downloaded | Modify |
| `android/.../data/AudioDb.kt` | The `network_events` table + `recordNetworkEvent` | Modify |
| `android/app/src/test/.../NetworkLedgerTest.kt` | That the table is declared | Create |
| `src/db/schema.ts` | Readable schema copy | Modify |
| `src/navigation/RootNavigator.tsx` | Register the screen | Modify |
| `src/screens/SettingsScreen.tsx` | Link to it from the PRIVACY section | Modify |
| `scripts/check-network-egress.py` | Fail the build on a fifth call site | Create |
| `scripts/__tests__/test_check_network_egress.py` | That the check actually catches one | Create |
| `docs/NEXT.md` | Record what shipped | Modify |

---

## Task 1: The ledger table

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt`
- Modify: `src/db/schema.ts`
- Test: `android/app/src/test/java/com/innocorelabs/verbale/data/NetworkLedgerTest.kt`

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/innocorelabs/verbale/data/NetworkLedgerTest.kt`:

```kotlin
package com.innocorelabs.verbale.data

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ledger behind the privacy screen, checked without a device.
 *
 * The screen's whole claim is that it counts every byte that leaves. A table that only exists on
 * fresh installs would make it count every byte on a NEW phone and silently nothing on an
 * upgraded one — which is the quiet-undercount failure the spec calls out by name.
 */
class NetworkLedgerTest {

  @Test
  fun the_ledger_table_is_declared_in_the_schema() {
    val sql = AudioDb.schemaForTest().joinToString("\n")
    assertTrue("network_events must be created", sql.contains("CREATE TABLE IF NOT EXISTS network_events"))
  }

  @Test
  fun the_ledger_records_what_the_screen_has_to_show() {
    val sql = AudioDb.schemaForTest().first { it.contains("network_events") }
    for (column in listOf("at", "kind", "host", "sent", "received", "detail")) {
      assertTrue("network_events needs $column", sql.contains(column))
    }
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*NetworkLedgerTest*' 2>&1 | grep -E 'e: |FAILED'
```

Expected: a compilation error — `schemaForTest` is unresolved.

- [ ] **Step 3: Add the table and the accessor**

In `AudioDb.kt`, inside the `SCHEMA` array (after the `settings` table line), add:

```kotlin
      // Every byte this app sends, and where it went. The privacy screen reads nothing else.
      //
      // Not pruned. A model download writes about nine rows once and everything after it is
      // roughly one row a month, so the whole table stays smaller than a single transcript — and
      // a ledger that forgets is not evidence of anything.
      """CREATE TABLE IF NOT EXISTS network_events(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           at INTEGER NOT NULL,
           kind TEXT NOT NULL,
           host TEXT NOT NULL,
           sent INTEGER NOT NULL DEFAULT 0,
           received INTEGER NOT NULL DEFAULT 0,
           detail TEXT);""",
```

In the same `companion object`, next to `addedColumnsForTest`:

```kotlin
    /** The schema, for a unit test that must not open an encrypted database. */
    @JvmStatic
    fun schemaForTest(): List<String> = SCHEMA.toList()
```

- [ ] **Step 4: Mirror it in the readable schema**

In `src/db/schema.ts`, after the `settings` table entry, add:

```ts
  `CREATE TABLE IF NOT EXISTS network_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,          -- epoch ms
     kind TEXT NOT NULL,           -- 'licence' | 'models' | 'crash'
     host TEXT NOT NULL,           -- 'huggingface.co'
     sent INTEGER NOT NULL DEFAULT 0,     -- request BODY bytes; headers are excluded
     received INTEGER NOT NULL DEFAULT 0,
     detail TEXT                   -- 'token refresh', 'ggml-base-q5_1.bin'
   );`,
```

- [ ] **Step 5: Run the tests**

```bash
cd android && ./gradlew :app:testDebugUnitTest 2>&1 | grep -E 'BUILD|FAILED'
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt \
        android/app/src/test/java/com/innocorelabs/verbale/data/NetworkLedgerTest.kt \
        src/db/schema.ts
git commit -m "feat(privacy): a ledger for every byte that leaves"
```

---

## Task 2: The summary arithmetic

Pure, and written before anything records into it, because the month boundary is the only part of
this feature with a wrong answer that looks plausible.

**Files:**
- Create: `src/privacy/summary.ts`
- Test: `src/privacy/__tests__/summary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/privacy/__tests__/summary.test.ts`:

```ts
import { summarise, formatBytes, type NetworkEvent } from '../summary';

const AUG = Date.UTC(2026, 7, 20, 12, 0, 0); // 20 August 2026
const SEP_1 = Date.UTC(2026, 8, 1, 0, 0, 0);
const SEP_6 = Date.UTC(2026, 8, 6, 12, 0, 0);

const events: NetworkEvent[] = [
  { id: 1, at: AUG, kind: 'models', host: 'huggingface.co', sent: 0, received: 57_000_000, detail: 'ggml-base-q5_1.bin' },
  { id: 2, at: SEP_1, kind: 'licence', host: 'licence.innocorelabs.com', sent: 180, received: 620, detail: 'token refresh' },
  { id: 3, at: SEP_6, kind: 'licence', host: 'licence.innocorelabs.com', sent: 210, received: 640, detail: 'sign in' },
];

describe('what the privacy screen reports', () => {
  it('counts only the current calendar month in the headline', () => {
    // August's download is real and stays in the log; it is not "this month".
    const s = summarise(events, SEP_6);
    expect(s.callsThisMonth).toBe(2);
    expect(s.sentThisMonth).toBe(390);
  });

  it('reports the one-time setup download over all time, not this month', () => {
    // It is the largest number on the screen and it is the argument, so it must not vanish on
    // the first of the month.
    const s = summarise(events, SEP_6);
    expect(s.setupDownloadBytes).toBe(57_000_000);
    expect(s.setupHosts).toEqual(['huggingface.co']);
  });

  it('is zero for somebody who has never signed in', () => {
    const s = summarise([], SEP_6);
    expect(s.callsThisMonth).toBe(0);
    expect(s.sentThisMonth).toBe(0);
    expect(s.setupDownloadBytes).toBe(0);
  });

  it('never counts audio, because nothing can record audio into the ledger', () => {
    // The zero on the screen is derived from the kinds that exist, not printed as a constant.
    const s = summarise(events, SEP_6);
    expect(s.audioBytes).toBe(0);
  });

  it('names every host it has ever talked to, deduplicated and stable', () => {
    const s = summarise(events, SEP_6);
    expect(s.allHosts).toEqual(['huggingface.co', 'licence.innocorelabs.com']);
  });

  it('formats bytes the way a person reads them', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(390)).toBe('390 bytes');
    expect(formatBytes(57_000_000)).toBe('57.0 MB');
    expect(formatBytes(1_300_000_000)).toBe('1.3 GB');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/privacy/__tests__/summary.test.ts 2>&1 | tail -5
```

Expected: `Cannot find module '../summary'`.

- [ ] **Step 3: Write the implementation**

Create `src/privacy/summary.ts`:

```ts
/**
 * The numbers on the privacy screen, derived from the ledger and nothing else.
 *
 * Pure on purpose. The screen's credibility rests on these figures being a function of what was
 * recorded, so there is no clock, no store and no I/O in here — `now` is passed in, which is also
 * what makes the month boundary testable rather than something that breaks once a month.
 */

/** The kinds of egress this app has. There is deliberately no 'audio'. */
export type NetworkKind = 'licence' | 'models' | 'crash';

export interface NetworkEvent {
  id: number;
  at: number;
  kind: NetworkKind;
  host: string;
  /** Request BODY bytes. Headers are excluded — see the screen's footnote. */
  sent: number;
  received: number;
  detail: string | null;
}

export interface PrivacySummary {
  callsThisMonth: number;
  sentThisMonth: number;
  receivedThisMonth: number;
  /** The one-time model download, over all time: it is setup, not monthly traffic. */
  setupDownloadBytes: number;
  setupHosts: string[];
  allHosts: string[];
  /**
   * Always 0, and derived rather than printed. `NetworkKind` has no audio member, so no caller
   * can record one — the zero is a consequence of the type, which is a stronger claim than a
   * constant on a screen.
   */
  audioBytes: number;
}

function startOfMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function summarise(events: NetworkEvent[], now: number): PrivacySummary {
  const since = startOfMonth(now);
  const month = events.filter(e => e.at >= since);
  const setup = events.filter(e => e.kind === 'models');

  return {
    callsThisMonth: month.length,
    sentThisMonth: month.reduce((n, e) => n + e.sent, 0),
    receivedThisMonth: month.reduce((n, e) => n + e.received, 0),
    setupDownloadBytes: setup.reduce((n, e) => n + e.received, 0),
    setupHosts: [...new Set(setup.map(e => e.host))].sort(),
    allHosts: [...new Set(events.map(e => e.host))].sort(),
    audioBytes: 0,
  };
}

/** Bytes as a person reads them. Deliberately not exact — the log carries the exact figure. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} bytes`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx jest src/privacy/__tests__/summary.test.ts 2>&1 | tail -5
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/privacy/summary.ts src/privacy/__tests__/summary.test.ts
git commit -m "feat(privacy): the arithmetic behind the screen, with the month boundary pinned"
```

---

## Task 3: Recording, and refusing to undercount

**Files:**
- Create: `src/privacy/ledger.ts`
- Test: `src/privacy/__tests__/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/privacy/__tests__/ledger.test.ts`:

```ts
jest.mock('../../db/queries', () => ({
  db: { query: jest.fn(), getSetting: jest.fn(), setSetting: jest.fn() },
}));

import { db } from '../../db/queries';
import { record, drops, DROPS_KEY } from '../ledger';

const mockDb = db as unknown as {
  query: jest.Mock;
  getSetting: jest.Mock;
  setSetting: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockResolvedValue([]);
  mockDb.getSetting.mockResolvedValue(null);
  mockDb.setSetting.mockResolvedValue(undefined);
});

describe('recording what left the phone', () => {
  it('writes the host, the body bytes and a readable detail', async () => {
    await record({ kind: 'licence', host: 'licence.innocorelabs.com', sent: 180, received: 620, detail: 'token refresh' });
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO network_events');
    expect(params).toEqual(
      expect.arrayContaining(['licence', 'licence.innocorelabs.com', 180, 620, 'token refresh']),
    );
  });

  /**
   * The failure that matters. If the write throws, the call still happened — so swallowing it
   * produces a screen that reads LOW, which is the same class of overclaim as stamping a consent
   * record for a room that heard nothing.
   */
  it('counts a failed write instead of losing it', async () => {
    mockDb.query.mockRejectedValue(new Error('database is locked'));
    await record({ kind: 'licence', host: 'h', sent: 1, received: 1, detail: null });
    expect(mockDb.setSetting).toHaveBeenCalledWith(DROPS_KEY, '1');
  });

  it('never lets recording break the call it is recording', async () => {
    mockDb.query.mockRejectedValue(new Error('database is locked'));
    mockDb.setSetting.mockRejectedValue(new Error('also broken'));
    // Both storage paths dead, and this still must not throw into a licence refresh.
    await expect(
      record({ kind: 'licence', host: 'h', sent: 1, received: 1, detail: null }),
    ).resolves.toBeUndefined();
  });

  it('reports how many events went unrecorded', async () => {
    mockDb.getSetting.mockResolvedValue('3');
    expect(await drops()).toBe(3);
  });

  it('reports no drops when nothing has ever failed', async () => {
    mockDb.getSetting.mockResolvedValue(null);
    expect(await drops()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/privacy/__tests__/ledger.test.ts 2>&1 | tail -5
```

Expected: `Cannot find module '../ledger'`.

- [ ] **Step 3: Write the implementation**

Create `src/privacy/ledger.ts`:

```ts
import { db } from '../db/queries';
import type { NetworkEvent, NetworkKind } from './summary';

/**
 * The only way anything is written to the network ledger.
 *
 * One function because the screen's claim is "this is every byte", and that is only defensible
 * while there is a single place a byte can be recorded from. The four callers are the four call
 * sites that own this app's entire network access; `scripts/check-network-egress.py` fails the
 * build if a fifth appears.
 */

/** Settings key counting events we failed to write. Shown on the screen when non-zero. */
export const DROPS_KEY = 'network_ledger_drops';

export interface Egress {
  kind: NetworkKind;
  host: string;
  /** Request BODY bytes. Headers are excluded, and the screen says so. */
  sent: number;
  received: number;
  detail: string | null;
}

/**
 * Record one egress event. Never throws.
 *
 * A recording failure must not break the call being recorded — a licence refresh that fails
 * because the ledger is locked would be an absurd way to lose. But it must not vanish either: a
 * ledger that silently drops rows reads LOW, and a privacy screen that under-reports is worse
 * than no privacy screen. So a failure is counted and surfaced instead.
 */
export async function record(e: Egress): Promise<void> {
  try {
    await db.query(
      'INSERT INTO network_events(at, kind, host, sent, received, detail) VALUES(?, ?, ?, ?, ?, ?)',
      [Date.now(), e.kind, e.host, e.sent, e.received, e.detail],
    );
  } catch {
    try {
      const current = Number((await db.getSetting(DROPS_KEY)) ?? '0') || 0;
      await db.setSetting(DROPS_KEY, String(current + 1));
    } catch {
      // Both the ledger and the settings store are unavailable. Nothing further is possible
      // here, and throwing would take a network call down with it.
    }
  }
}

/** How many events could not be written. The screen says so rather than reading low in silence. */
export async function drops(): Promise<number> {
  try {
    return Number((await db.getSetting(DROPS_KEY)) ?? '0') || 0;
  } catch {
    return 0;
  }
}

/** The whole ledger, newest first. */
export async function events(): Promise<NetworkEvent[]> {
  try {
    return (await db.query(
      'SELECT id, at, kind, host, sent, received, detail FROM network_events ORDER BY at DESC',
    )) as NetworkEvent[];
  } catch {
    return [];
  }
}

/** Host from a URL, or the URL itself when it will not parse. Never throws into a network call. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
```

- [ ] **Step 4: Add the `query` passthrough the ledger uses**

`src/db/queries.ts` exposes typed helpers, not raw SQL. The ledger needs one generic call, so add
it to the exported `db` object alongside `getSetting` / `setSetting`:

```ts
  /**
   * Raw query, for the network ledger only.
   *
   * Everything else on this object is a named, typed helper and should stay that way. The ledger
   * is the exception because its table is written from four unrelated places and read by one
   * screen — a dozen bespoke helpers would be worse than one seam that says what it is for.
   */
  query: <T>(sql: string, params: unknown[] = []) => run<T>(sql, params),
```

- [ ] **Step 5: Run the tests**

```bash
npx jest src/privacy 2>&1 | tail -5
npx tsc --noEmit && echo "tsc ok"
```

Expected: 11 passed across the two files, and `tsc ok`.

- [ ] **Step 6: Commit**

```bash
git add src/privacy/ledger.ts src/privacy/__tests__/ledger.test.ts src/db/queries.ts
git commit -m "feat(privacy): record egress, and count what could not be recorded"
```

---

## Task 4: Wire the licence call

**Files:**
- Modify: `src/billing/subscription.ts`

- [ ] **Step 1: Record inside `post()`**

`post()` is the single place this app talks to the licence server. Replace the body of `post` in
`src/billing/subscription.ts` with:

```ts
async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const url = `${base.replace(/\/+$/, '')}${path}`;
  const payload = JSON.stringify(body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  const text = await res.text();
  // Recorded whatever the server said, including a refusal: the bytes left the phone either way,
  // and a ledger that only counts successes is not a count of what left.
  await record({
    kind: 'licence',
    host: hostOf(url),
    sent: payload.length,
    received: text.length,
    detail: path,
  });
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // A proxy error page or a captive portal, not our server. Say something a person can act on
    // rather than surfacing a JSON parse error.
    throw new Error(`The licence server sent something unexpected (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const message = (parsed as { error?: string })?.error;
    throw new Error(message ?? `The licence server refused the request (HTTP ${res.status}).`);
  }
  return parsed as T;
}
```

Add to the imports at the top of the file:

```ts
import { hostOf, record } from '../privacy/ledger';
```

- [ ] **Step 2: Typecheck and test**

```bash
npx tsc --noEmit && npm test 2>&1 | grep -E 'Tests:|Suites:|✕'
```

Expected: no type errors, all suites pass. If `src/billing/__tests__/*` stubs `fetch`, the ledger
call is stubbed with it and needs no change.

- [ ] **Step 3: Commit**

```bash
git add src/billing/subscription.ts
git commit -m "feat(privacy): count the licence call, refusals included"
```

---

## Task 5: Wire the model downloads

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt`
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ModelManagerModule.kt`

- [ ] **Step 1: Add the Kotlin writer**

In `AudioDb.kt`, next to `markAnnounced`:

```kotlin
  /**
   * Record one egress event from the native side. Never throws.
   *
   * Mirrors src/privacy/ledger.ts `record`. The download loop must not die because the ledger is
   * busy — but a silent drop makes the privacy screen read low, so a failure is counted in the
   * same settings key the TypeScript side uses and surfaced on the screen.
   */
  fun recordNetworkEvent(kind: String, host: String, sent: Long, received: Long, detail: String?) {
    try {
      db.execSQL(
        "INSERT INTO network_events(at, kind, host, sent, received, detail) VALUES(?,?,?,?,?,?)",
        arrayOf<Any?>(System.currentTimeMillis(), kind, host, sent, received, detail),
      )
    } catch (e: Exception) {
      try {
        val current = getSetting("network_ledger_drops")?.toLongOrNull() ?: 0L
        db.execSQL(
          "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)",
          arrayOf<Any?>("network_ledger_drops", (current + 1).toString()),
        )
      } catch (inner: Exception) {
        // Both paths gone. Losing a download to bookkeeping would be the worse outcome.
      }
    }
  }
```

- [ ] **Step 2: Record each file at the end of `fetchTo`**

In `ModelManagerModule.kt`, `fetchTo()` streams one source into `part`. At the end of the
`conn.inputStream.use { ... }` block — after the write loop finishes and before the function
returns — add:

```kotlin
    // One row per file actually fetched, with the host it came from. These are the largest
    // numbers the privacy screen shows, and they are the argument rather than an embarrassment:
    // this much came down so that nothing has to go up.
    AudioDb.get(reactApplicationContext).recordNetworkEvent(
      kind = "models",
      host = try { URL(source).host } catch (e: Exception) { source },
      sent = 0L, // a GET sends headers, not a body; the screen says headers are excluded
      received = part.length() - existingAtStart,
      detail = id,
    )
```

At the top of `fetchTo`, immediately after `var existing = ...`, capture the starting length so
the recorded figure is what THIS call downloaded rather than what a resumed file already held:

```kotlin
    val existingAtStart = existing
```

- [ ] **Step 3: Build**

```bash
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a \
  -PAUDIONOTES_DEBUG_UPLOAD_SIGNING 2>&1 | grep -E 'BUILD|e: '
```

Expected: `BUILD SUCCESSFUL`. If `reactApplicationContext` is not in scope in `fetchTo`, use the
module's own context field — check the class header for its name and use that.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt \
        android/app/src/main/java/com/innocorelabs/verbale/pipeline/ModelManagerModule.kt
git commit -m "feat(privacy): count the setup downloads, with the host they came from"
```

---

## Task 6: Wire crash reporting

Dormant today — there is no DSN — and wired anyway, so the screen stays complete on the day one is
added rather than silently under-reporting from then on.

**Files:**
- Modify: `src/telemetry/crash.ts`

- [ ] **Step 1: Record from `beforeSend`**

In `src/telemetry/crash.ts`, inside `Sentry.init({ ... })`, the existing `beforeSend(event)`
already scrubs the event. Add the recording immediately before its `return event;`:

```ts
      // Sentry decides when to flush, so this is the last point at which we know an event is on
      // its way out. Size is the serialised event, which is what will be sent, not a guess.
      void record({
        kind: 'crash',
        host: hostOf(SENTRY_DSN),
        sent: JSON.stringify(event).length,
        received: 0,
        detail: 'crash report',
      });
      return event;
```

Add to the imports at the top of the file:

```ts
import { hostOf, record } from '../privacy/ledger';
```

- [ ] **Step 2: Typecheck and test**

```bash
npx tsc --noEmit && npx jest src/telemetry 2>&1 | tail -5
```

Expected: no type errors; the existing crash tests still pass. They assert the SDK never starts
without consent, which this does not touch.

- [ ] **Step 3: Commit**

```bash
git add src/telemetry/crash.ts
git commit -m "feat(privacy): count a crash upload, for the build that has a DSN"
```

---

## Task 7: The screen

**Files:**
- Create: `src/screens/PrivacyScreen.tsx`
- Modify: `src/navigation/RootNavigator.tsx`
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Write the screen**

Create `src/screens/PrivacyScreen.tsx`:

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import Icon from '../components/Icon';
import { IconButton, Raised, SectionRule, Txt } from '../components/ui';
import { drops, events } from '../privacy/ledger';
import { formatBytes, summarise, type NetworkEvent } from '../privacy/summary';
import { radius, s, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Privacy'>;

const KIND_LABEL: Record<string, string> = {
  licence: 'Licence check',
  models: 'Setup download',
  crash: 'Crash report',
};

/**
 * What actually left this phone.
 *
 * The app tells people "nothing is uploaded" in six places. Every one of those is a promise the
 * reader cannot check, which is the shape of claim this project has already been bitten by. This
 * screen is the check: a count taken at the four call sites that own the app's entire network
 * access, shown with dates and hosts.
 *
 * It reports and never grades. There is no "you are private" and no green tick — the same
 * boundary the consent card holds, for the same reason.
 */
export default function PrivacyScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const [log, setLog] = useState<NetworkEvent[] | null>(null);
  const [unrecorded, setUnrecorded] = useState(0);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    events().then(setLog).catch(() => setLog([]));
    drops().then(setUnrecorded).catch(() => setUnrecorded(0));
  }, []);

  const sum = useMemo(() => summarise(log ?? [], Date.now()), [log]);

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="display">What left this phone</Txt>
      </View>

      <ScrollView contentContainerStyle={st.body} showsVerticalScrollIndicator={false}>
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
          <View style={st.pad}>
            <Txt variant="metaBlack" color={colors.inkDim}>THIS MONTH</Txt>
            <Txt variant="display" style={st.big}>
              {sum.callsThisMonth === 0 ? 'No network calls' : `${sum.callsThisMonth} network call${sum.callsThisMonth === 1 ? '' : 's'}`}
            </Txt>
            <Txt variant="body" color={colors.inkSoft}>
              {formatBytes(sum.sentThisMonth)} sent, {formatBytes(sum.receivedThisMonth)} received.
            </Txt>
            <Txt variant="display" style={st.big} color={colors.success}>
              {formatBytes(sum.audioBytes)} of audio
            </Txt>
            <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
              Audio, transcripts and minutes are never sent. Nothing in this app can put them on a
              network — that is why this reads zero, rather than a zero we typed in.
            </Txt>
          </View>
        </Raised>

        {sum.setupDownloadBytes > 0 ? (
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.pad}>
              <Txt variant="metaBlack" color={colors.inkDim}>ONE-TIME SETUP</Txt>
              <Txt variant="bodyStrong" style={st.tiny}>
                {formatBytes(sum.setupDownloadBytes)} downloaded
              </Txt>
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                From {sum.setupHosts.join(', ')}. The speech and language models run on this phone,
                which is the reason nothing has to be uploaded to use it.
              </Txt>
            </View>
          </Raised>
        ) : null}

        {/* The exception, stated rather than buried. A privacy screen with something it quietly
            does not count is worth less than no screen at all. */}
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
          <View style={st.pad}>
            <Txt variant="metaBlack" color={colors.inkDim}>NOT COUNTED HERE</Txt>
            <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
              Google Play makes its own connection when you open the subscription screen. That one
              is Play's, not ours, and this app cannot see or count it.
            </Txt>
            <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
              Sent totals are request bodies. A request also carries a few hundred bytes of headers,
              which are not counted as data you sent.
            </Txt>
          </View>
        </Raised>

        {unrecorded > 0 ? (
          <Raised edge={colors.warning} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.pad}>
              <Txt variant="bodyStrong" color={colors.warning}>
                {unrecorded} event{unrecorded === 1 ? '' : 's'} could not be recorded
              </Txt>
              <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                The database was unavailable when they happened, so the totals above are lower than
                what actually left. Said plainly rather than left to look like a smaller number.
              </Txt>
            </View>
          </Raised>
        ) : null}

        <View style={st.ruleWrap}>
          <SectionRule label="THE LOG" />
        </View>
        <Pressable
          onPress={() => setShowLog(v => !v)}
          accessibilityRole="button"
          accessibilityLabel={showLog ? 'Hide the log' : 'Show every recorded event'}>
          <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5}>
            <View style={st.row}>
              <Txt variant="bodyStrong" style={st.flex}>
                {showLog ? 'Hide the log' : `Show all ${log?.length ?? 0} recorded events`}
              </Txt>
              <Icon
                name={showLog ? 'chevronUp' : 'chevronDown'}
                size={s(18)}
                color={colors.inkFaint}
                strokeWidth={2.4}
              />
            </View>
          </Raised>
        </Pressable>

        {showLog
          ? (log ?? []).map(e => (
              <Raised key={e.id} edge={colors.line} fill={colors.card} rad={radius.lg} depth={3}>
                <View style={st.pad}>
                  <Txt variant="bodyStrong">{KIND_LABEL[e.kind] ?? e.kind}</Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                    {new Date(e.at).toLocaleString()} · {e.host}
                  </Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                    {e.sent} bytes sent, {e.received} received{e.detail ? ` · ${e.detail}` : ''}
                  </Txt>
                </View>
              </Raised>
            ))
          : null}
      </ScrollView>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    body: { padding: s(20), gap: s(12) },
    pad: { padding: s(16) },
    row: { flexDirection: 'row', alignItems: 'center', padding: s(16), gap: s(12) },
    flex: { flex: 1 },
    big: { marginTop: s(6) },
    tiny: { marginTop: s(6) },
    ruleWrap: { marginTop: s(8) },
  });
}
```

- [ ] **Step 2: Register the route**

In `src/navigation/RootNavigator.tsx`, add to `RootStackParamList` after `ConsentCard: undefined;`:

```ts
  /** What actually left the phone. No params: it is the whole ledger or nothing. */
  Privacy: undefined;
```

Add the import next to the other screen imports:

```ts
import PrivacyScreen from '../screens/PrivacyScreen';
```

Add the screen next to the `ConsentCard` entry:

```tsx
          <Stack.Screen
            name="Privacy"
            component={PrivacyScreen}
            options={{ headerShown: false }}
          />
```

- [ ] **Step 3: Link it from Settings**

In `src/screens/SettingsScreen.tsx`, inside the PRIVACY section's `<View style={st.list}>`, add
this immediately before the `<View style={st.assure}>` block, following the same markup as the
"Open-source notices" row further down the file:

```tsx
          <Raised
            edge={colors.line}
            fill={colors.card}
            rad={radius.xl}
            depth={5}
            onPress={() => navigation.navigate('Privacy')}>
            <View style={st.rowPad}>
              <View style={st.row}>
                <Icon name="shield" size={s(18)} color={colors.inkSoft} strokeWidth={2.4} />
                <View style={st.flex}>
                  <Txt variant="bodyStrong">What left this phone</Txt>
                  <Txt variant="chip" color={colors.inkSoft} style={st.tiny}>
                    Every network call this app has made, counted and dated
                  </Txt>
                </View>
                <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} strokeWidth={2.4} />
              </View>
            </View>
          </Raised>
```

- [ ] **Step 4: Typecheck, test and lint**

```bash
npx tsc --noEmit && npm test 2>&1 | grep -E 'Tests:|Suites:|✕'
npx eslint src/screens/PrivacyScreen.tsx src/screens/SettingsScreen.tsx src/privacy 2>&1 | tail -3
```

Expected: no type errors, all tests pass, and no NEW eslint errors against `main`.

- [ ] **Step 5: Commit**

```bash
git add src/screens/PrivacyScreen.tsx src/navigation/RootNavigator.tsx src/screens/SettingsScreen.tsx
git commit -m "feat(privacy): the screen, including what it cannot count"
```

---

## Task 8: The check that keeps it true

The load-bearing task. Without it the screen is accurate on release day and rots silently the
first time somebody adds a network call somewhere new.

**Files:**
- Create: `scripts/check-network-egress.py`
- Test: `scripts/__tests__/test_check_network_egress.py`

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/test_check_network_egress.py`:

```python
"""The check has to catch a violation, not merely run and exit zero.

A guard nobody has seen fail is a guard nobody knows works. The engine-encapsulation check exists
because Qwen3-ASR shipped unreachable with every test green; this one exists so the privacy screen
cannot quietly start under-reporting, and it needs the same proof.
"""
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHECK = os.path.join(ROOT, "scripts", "check-network-egress.py")


def run_against(tree):
    return subprocess.run(
        [sys.executable, CHECK, "--root", tree], capture_output=True, text=True
    )


def test_clean_tree_passes():
    tree = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(tree, "src", "screens"))
        with open(os.path.join(tree, "src", "screens", "Fine.tsx"), "w") as f:
            f.write("export const x = 1;\n")
        assert run_against(tree).returncode == 0
    finally:
        shutil.rmtree(tree)


def test_a_new_fetch_fails_the_build():
    tree = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(tree, "src", "screens"))
        with open(os.path.join(tree, "src", "screens", "Sneaky.tsx"), "w") as f:
            f.write("await fetch('https://analytics.example.com/ping');\n")
        result = run_against(tree)
        assert result.returncode == 1
        assert "Sneaky.tsx" in result.stderr
    finally:
        shutil.rmtree(tree)


def test_the_registered_call_sites_are_allowed():
    tree = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(tree, "src", "billing"))
        with open(os.path.join(tree, "src", "billing", "subscription.ts"), "w") as f:
            f.write("const res = await fetch(url, { method: 'POST' });\n")
        assert run_against(tree).returncode == 0
    finally:
        shutil.rmtree(tree)


def test_the_real_repository_passes():
    # The check is worthless if it does not hold on the tree it ships with.
    assert run_against(ROOT).returncode == 0
```

- [ ] **Step 2: Run it and watch it fail**

```bash
python3 -m pytest scripts/__tests__/test_check_network_egress.py -q 2>&1 | tail -5
```

Expected: every test errors — `scripts/check-network-egress.py` does not exist.

- [ ] **Step 3: Write the check**

Create `scripts/check-network-egress.py`:

```python
#!/usr/bin/env python3
"""Fail if anything opens a network connection outside the four registered call sites.

The privacy screen counts every byte that leaves the phone, and it can only do that while there
are exactly four places a byte can leave from. Nothing a compiler checks can express "this app has
four network call sites"; a grep can, and the cost of it being wrong is a screen that keeps
reporting confident numbers while quietly missing traffic — which is worse than having no screen,
because somebody would be relying on it.

Modelled on check-engine-encapsulation.py, which exists for the same reason: an invariant that
lives in source layout rather than in types.
"""
import argparse
import os
import re
import sys

# The four sites that own this app's entire network access, plus the ledger seam they record
# through. Adding to this list is a deliberate act and should be argued for in review.
ALLOWED = {
    os.path.join("src", "billing", "subscription.ts"),
    os.path.join("src", "telemetry", "crash.ts"),
    os.path.join("src", "privacy", "ledger.ts"),
    os.path.join(
        "android", "app", "src", "main", "java", "com", "innocorelabs", "verbale",
        "pipeline", "ModelManagerModule.kt",
    ),
}

# Tests stub these on purpose, which is the opposite of the risk being guarded.
ALLOWED_PREFIXES = (
    os.path.join("src", "privacy", "__tests__") + os.sep,
    os.path.join("src", "billing", "__tests__") + os.sep,
    os.path.join("src", "telemetry", "__tests__") + os.sep,
    os.path.join("scripts", "__tests__") + os.sep,
)

SEARCH_ROOTS = ("src", os.path.join("android", "app", "src", "main"))
EXTENSIONS = (".ts", ".tsx", ".kt", ".java")

PATTERN = re.compile(
    r"\bfetch\s*\(|\bXMLHttpRequest\b|\bopenConnection\s*\(|\bHttpURLConnection\b"
    r"|\bOkHttpClient\b|\bnew\s+Socket\s*\(|\bWebSocket\s*\("
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = parser.parse_args()
    root = args.root

    violations = []
    for search in SEARCH_ROOTS:
        base = os.path.join(root, search)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", "build", "__pycache__")]
            for name in filenames:
                if not name.endswith(EXTENSIONS):
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, root)
                if rel in ALLOWED or rel.startswith(ALLOWED_PREFIXES):
                    continue
                with open(path, encoding="utf-8", errors="replace") as f:
                    for lineno, line in enumerate(f, 1):
                        stripped = line.lstrip()
                        if stripped.startswith(("//", "*", "/*", "#")):
                            continue
                        if PATTERN.search(line):
                            violations.append(f"{rel}:{lineno}: {line.strip()}")

    if violations:
        print("A network call exists outside the registered call sites:\n", file=sys.stderr)
        for v in violations:
            print("  " + v, file=sys.stderr)
        print(
            "\nThe privacy screen claims to count every byte that leaves this phone. It can only\n"
            "do that while every byte leaves through a site that records to src/privacy/ledger.ts.\n"
            "Either record from the new site and add it to ALLOWED here, or route it through an\n"
            "existing one. Do not silence this without updating the screen's claim.",
            file=sys.stderr,
        )
        return 1
    print("network egress OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests**

```bash
chmod +x scripts/check-network-egress.py
python3 -m pytest scripts/__tests__/test_check_network_egress.py -q 2>&1 | tail -5
python3 scripts/check-network-egress.py
```

Expected: 4 passed, and `network egress OK` against the real tree.

- [ ] **Step 5: Wire it into npm so it runs without being remembered**

In `package.json`, add to `scripts`:

```json
    "check:egress": "python3 scripts/check-network-egress.py",
```

- [ ] **Step 6: Commit**

```bash
git add scripts/check-network-egress.py scripts/__tests__/test_check_network_egress.py package.json
git commit -m "test(privacy): fail the build if a fifth network call site appears"
```

---

## Task 9: Verify on hardware

**Files:** none — this is the gate.

- [ ] **Step 1: Confirm a device is attached**

```bash
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export PATH=$ANDROID_HOME/platform-tools:$PATH
adb devices -l
```

Expected: one line ending `device`.

- [ ] **Step 2: Install and run the native suite**

```bash
npm run test:device
```

Expected: `NativePipelineTest` and `MinutesParityTest` pass with no skips.

- [ ] **Step 3: The screen reads zero for somebody who never signed in**

1. Settings → **What left this phone**.
2. On a device whose models were downloaded before this build shipped, the setup card will be
   absent — the ledger only knows what it recorded. That is correct and not a bug; note it.
3. Confirm the headline reads **No network calls** and **0 bytes of audio**.

- [ ] **Step 4: A licence call appears in the log**

1. Settings → sign in (or attempt a sign-in with a wrong password — a refusal still counts, which
   is the point).
2. Reopen **What left this phone**.
3. Confirm the headline now reads 1 network call, and the log names the licence host, the byte
   counts and the path.

- [ ] **Step 5: A model download appears with its host**

Only meaningful on a device that downloads a model with this build installed. If the phone already
has every model, either skip and say so, or use Settings → the model list to fetch one that is not
yet present, then confirm a `Setup download` row appears naming `huggingface.co`.

- [ ] **Step 6: Record what shipped**

In `docs/NEXT.md`, replace item 8's row:

```
| 8 | ~~Privacy proof screen~~ **DONE 6 Sep** | me | S | Settings → "What left this phone": every network call this app has made, counted at the four call sites that own its entire network access, with dates, hosts and byte totals, and the full log behind the summary. The app claimed "nothing is uploaded" in six places and none of them was checkable; this is the check. Counts the one-time model download in full with its domains rather than hiding it — 1.3 GB came down so that nothing has to go up — and states plainly the one thing it cannot count, which is Google Play's own connection. `scripts/check-network-egress.py` fails the build if a fifth call site appears, which is what stops the screen rotting into a confident undercount. `docs/superpowers/specs/2026-09-06-privacy-proof-design.md`. |
```

```bash
git add docs/NEXT.md
git commit -m "docs: the privacy screen ships"
```

---

## Self-review

**Spec coverage.** The ledger table → Task 1. The summary arithmetic and month boundary → Task 2.
Recording, and refusing to undercount on a failed write → Task 3. The four writers → Tasks 4
(licence), 5 (models), 6 (crash); Play Billing is uncountable by design and is disclosed on the
screen in Task 7. Summary + expandable log → Task 7. Model download counted with domains as a
first-class line → Task 7. "Sent means body bytes", stated on screen → Task 7. No verdict, no green
tick → Task 7's screen copy. The CI check → Task 8. Device verification → Task 9.

**Type consistency.** `NetworkKind` and `NetworkEvent` are defined in Task 2 (`summary.ts`) and
imported by `ledger.ts` in Task 3 and the screen in Task 7. `record(Egress)`, `drops()`, `events()`
and `hostOf()` are defined in Task 3 and used in Tasks 4, 6 and 7. `DROPS_KEY` is
`'network_ledger_drops'` in Task 3 and the Kotlin writer in Task 5 uses the same literal string.
`recordNetworkEvent` is defined in Task 5 and called in the same task. `db.query` is added in Task
3 Step 4 and used by `ledger.ts` in the same task. The route name is `Privacy` in Tasks 7's param
list, screen registration and Settings link.

**One thing an implementer will hit.** Task 5 assumes `reactApplicationContext` is reachable inside
`fetchTo`. `ModelManagerModule` is a `ReactContextBaseJavaModule`, so it is — but if the class
stores its context under another name, use that; Step 3 says so rather than leaving it to be
discovered at the error.

**Not covered by any automated test, by nature.** That the screen's numbers correspond to real
traffic, rather than to what the ledger was told. Only Task 9 Steps 3 to 5 check that, and only a
packet capture would check it properly — worth doing once before launch, and out of scope here.
