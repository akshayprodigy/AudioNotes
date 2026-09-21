# Phase 6a — the INTERNET permission: what it buys, what a build without it costs

## 0. Summary (five sentences, written last)

pending

## 1. Inventory — every network call site

`python3 scripts/check-network-egress.py` → `network egress OK (203 files); exit=0` (**measured**).
Its `ALLOWED` set (`scripts/check-network-egress.py:26-30`) names exactly three files a network
call may live in — `src/billing/subscription.ts`, `src/privacy/ledger.ts` (the recording seam, not
a caller itself) and `ModelManagerModule.kt`. Crashlytics is explicitly **not** in that set any
more: a comment at `scripts/check-network-egress.py:20-25` records that it left the enforced list
the day crash reporting moved off Sentry, because Crashlytics sends from native Play Services code
this app cannot see a call site in. Google Play's own subscriptions-page connection was never in
the set — it is `Linking.openURL`, not a request this app makes.

| Call site (file:line) | Kind in the ledger | Host | Fires when | Sends (fields, from the code) | Receives | Counted by the ledger? |
|---|---|---|---|---|---|---|
| `subscription.ts:63-80` `signIn` → `/api/account/signin` | `licence` | licence server (`Licence.baseUrl()`) | Someone signs in from Settings or the paywall | `email`, `password`, `deviceId` (JSON body) | `accountId`, `email`, `refreshKey`, `token`, `plan`, `expiresAt` | Yes — `post()` calls `record()` at `subscription.ts:28-34` unconditionally, success or refusal |
| `subscription.ts:94-123` `refreshIfNeeded` → `/api/licence/refresh` | `licence` | licence server | App open, opportunistically, once the token is inside `RENEW_WINDOW_SECONDS` (`subscription.ts:15`, `5 * 24 * 60 * 60` = 5 days) of `expiresAt`, or already `expired`/`none` (`subscription.ts:106-109`). Cadence against the token's own lifetime: **not measured** — the lifetime is set in `issue()`, which lives in `server/app/entitlement.py`, not in this session's read list (`main.py:60-190` and `licence.py` were read; neither defines it) — **to verify** | `deviceId`, `refreshKey` | `token`, `plan`, `expiresAt` | Yes, same `post()` seam |
| `subscription.ts:148-162` `redeem` → `/api/billing/play/link` | `licence` | licence server | After a Play purchase (`buyWithPlay`, `subscription.ts:264-273`) or a restore (`restorePlayPurchase`, `subscription.ts:282-289`) | `purchaseToken`, `deviceId` | `accountId`, `refreshKey`, `token`, `plan` | Yes, same `post()` seam |
| `ModelManagerModule.kt` `fetchTo` (called from `download`, lines 126-232) | `models` | the catalog's own mirror first (`BuildConfig.MODEL_BASE_URL`), then upstream GitHub/Hugging Face/ModelScope per part (`ModelCatalog.kt:299-303` `sourcesFor`) | First run, and only for a part not already on disk at the right size — the `allPresent` early return at `ModelManagerModule.kt:141-152` guarantees nothing already present re-fetches | nothing (a GET; headers only) | the model bytes | Yes — `AudioDb.recordNetworkEvent(kind = "models", …)` at `ModelManagerModule.kt:277-283`, with a comment noting `sent = 0L` because "a GET sends headers, not a body" |
| Crashlytics (native, Play Services) | `crash` (a `NetworkKind` member — `summary.ts:10` — that nothing writes any more) | not observable from the app | On a crash, only when `crashConsent()` is `'on'` (`crash.ts:58-67`, gate applied at `crash.ts:88-91`) | stack trace, app version, phone model (`crash.ts:5-6`); never audio/transcript/notes content (`crash.ts:17-19` rule 2) | n/a | **No** — `crash.ts:22-34` states Crashlytics assembles and uploads from native Play Services code this app cannot inspect, intercept or measure; the privacy screen names it as an uncounted, disclosed source instead |
| `Linking.openURL('https://play.google.com/store/account/subscriptions')` (`SettingsScreen.tsx:220`) | n/a | Play's own connection | Someone taps "Manage subscription" | n/a — hands off to the Play Store app | n/a | Not this app's traffic; the privacy screen states this exception verbatim (`PrivacyScreen.tsx` "NOT COUNTED HERE" block) |

### 1.1 What a phone sends per month, three profiles

One-time model bytes, from the catalog (`ModelCatalog.kt`), **measured**:

| Tier | Models | Bytes | Cumulative |
|---|---|---|---|
| Essentials (`required = true`, free) | `onnxruntime-lib` 17,571,160 (`:149`) + `silero-vad` 2,327,524 (`:156`) + `whisper-base` 59,707,625 (`:163`) + `diar-seg` 5,992,913 (`:178`) + `diar-emb` 28,281,164 (`:197`) | 113,880,386 | 113,880,386 (≈113.9 MB — matches the "114 MB" figure in `ModelManagerModule.kt`'s own `allPresent` comment) |
| + Pro extra: `whisper-small` (needs subscription, `ModelCatalog.kt:338`) | 190,085,487 (`:170`) | +190,085,487 | 303,965,873 |
| + the writer: `llm-qwen` 1,117,320,736 (`:262`) + `embed-bge-small` 36,806,944 (`:277`) | 1,154,127,680 | +1,154,127,680 | 1,458,093,553 (≈1.46 GB) |

`qwen3-asr` (six parts, ≈972 MB) is in the catalog but `offered = false` (`ModelCatalog.kt:246`) — nothing can select it today, so it is excluded from every profile below.

Per-call payload sizes are **estimates**: the spec's own guidance is "assume ≤ 200 bytes a field" for JSON body fields, since no device measurement was taken this session (Rule: no device). Header bytes are excluded throughout, matching the ledger's own convention (`ledger.ts:19`, `PrivacyScreen.tsx` footnote).

| Profile | One-time (models) | Monthly calls | Monthly bytes (sent + received, estimate) |
|---|---|---|---|
| **Free, never signed in** | 113,880,386 (essentials only) | 0 | 0 — nothing in `subscription.ts` runs without a `baseUrl()` call that itself only fires once signed in or after a Play purchase |
| **Pro via Play** (no email sign-in) | 1,458,093,553 (essentials + writer; whisper-small only if the person also opts in from Settings) | 1 `redeem` call at purchase/restore (one-time, not monthly) + ≈1 `refreshIfNeeded` call/month once inside the 5-day renew window — exact monthly count depends on the token's lifetime (**not measured, to verify**) | `redeem`: 2 fields sent (≤400 bytes) + 5 fields received (≤1,000 bytes) ≈ 1.4 kB, one time only. Ongoing: `refresh` ≈2 fields sent (≤400 bytes) + 3 fields received (≤600 bytes) ≈ 1 kB/month (estimate, assumes ~1 refresh/month) |
| **Pro via email sign-in** | 1,458,093,553 (same models) | 1 `signIn` call (one-time) + ≈1 `refreshIfNeeded` call/month, same cadence caveat | `signIn`: 3 fields sent (≤600 bytes) + up to 5 fields received (≤1,000 bytes) ≈ 1.6 kB, one time. Ongoing: same ≈1 kB/month as the Play profile |

Every monthly-cadence figure above carries the same flag: **"lifetime: not in read list, to verify"** — `RENEW_WINDOW_SECONDS` (`subscription.ts:15`) is measured, but the token's issued lifetime (what it is 5 days *of*) is set server-side in `entitlement.py`, outside this session's read list.

## 2. What the permission buys today

pending

### 2.1 Models

pending

### 2.2 Licence

pending

### 2.3 Crash reports

pending

## 3. The permission-less build, replacement by replacement

pending

### 3.1 Models

pending

### 3.2 Licence

pending

### 3.3 Crashes

pending

### 3.4 The listing

pending

## 4. Options and cost

pending

## 5. Decisions for the founder

pending

## 6. Recommendation (judgement)

pending

## 7. Report (status · what was read · what could not be measured · commits)

pending
