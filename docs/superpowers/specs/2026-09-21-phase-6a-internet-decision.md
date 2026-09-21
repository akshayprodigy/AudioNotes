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

**Which models, and first-run totals** (measured, from §1.1's table, `ModelCatalog.kt`):
- Free/essentials: `onnxruntime-lib`, `silero-vad`, `whisper-base`, `diar-seg`, `diar-emb` — 113,880,386 bytes (≈113.9 MB).
- Pro adds, when downloaded: `whisper-small` (190,085,487, opt-in from Settings) and the writer bundle `llm-qwen` + `embed-bge-small` (1,154,127,680, offered at trial start and to Pro). Full Pro total if everything is fetched: 1,458,093,553 bytes (≈1.46 GB).

**Nothing re-downloads later.** `ModelManagerModule.kt:141-152`: once every part of a model is on disk at its catalog size, `allPresent` returns early before any network call — "Guarded here rather than in each caller because this is the one path all three share" (`:134-135`). The comment cites a device observation: before this guard, re-entering onboarding re-fetched the whole 114 MB, "over the user's mobile data … and now off our own mirror's egress" (`:129-131`).

**Offline today — the exact copy a person sees:**
- Onboarding, the failed-download screen (`OnboardingScreen.tsx:283-289`): *"That download stopped"* / *""{current}" could not be fetched. Check your connection and try again — anything already downloaded is kept, so it picks up where it left off."* Two ways out: "Try again" or "Continue without it".
- Paywall, trial-start writer download failure (`PaywallScreen.tsx:220-227`, an `Alert.alert`): *"The writer could not be downloaded"* / *"{message}\n\nYour trial has started and nothing has been spent. You can fetch the model from Settings once you are on a better connection."*
- Settings, the Get failure (`SettingsScreen.tsx:446-448`, an `Alert.alert`): *"Could not download"* / *"{message}"* — the raw error string, no bespoke offline copy.

### 2.2 Licence

**What each endpoint establishes** (`server/app/main.py:60-190`):
- `POST /api/account/signin` (`:65-102`) — authenticates an email/password, registers the device (refusing past `DEVICE_LIMIT`, `:87-91`), issues a device-scoped refresh key and a signed licence token.
- `POST /api/licence/refresh` (`:105-124`) — no password, just the device-scoped refresh key; also the one place a Play subscription's cancellation or expiry is noticed, since "a Play subscription is pulled, not pushed: there is no webhook telling us it lapsed" (`:117-119`) — silent on any Google failure so an outage there "must not revoke a paying customer" (`:119`).
- `POST /api/billing/play/link` (`:129-148`) — exchanges a verified Play purchase token for the same token/refresh-key pair the web sign-in path returns; "safe to call repeatedly … each call re-verifies with Google and re-registers the device, so 'restore purchases' is this endpoint and nothing else" (`:138-140`).

**What the device trusts without the network:** the signed token's `expiresAt` doubles as the offline grace window — "The token's remaining life IS the grace period" (`Licence.kt:14-15`) — verified purely by an on-device ECDSA signature check (`Licence.kt:76-107` `verify`), against a clock that only moves forward (`LicenceStore.kt:114-136` `advanceClock`/`monotonicNow`, `Licence.kt:70-72`). The trial is entirely local: `TRIAL_DAYS` / `TRIAL_SUMMARIES` counters live in the encrypted settings store and are checked against the same monotonic clock (`trial.ts:20-49`), with no server involved at all.

**Offline today:** a Pro user with a valid token loses nothing until `exp` (the payload's expiry field, `Licence.kt:29,95`) — `verify` returns `ACTIVE` for any correctly signed, correctly device-bound token where `exp > now` (`Licence.kt:100-106`), and only flips to `EXPIRED` once time actually runs out; there is no separate "haven't phoned home lately" check. `refreshIfNeeded`'s failure path is silent by design — `catch { return null }` (`subscription.ts:120-122`) — so a failed background refresh produces no dialog; the only user-visible failure copy is `signIn`'s and comes from `post()`'s own error handling (`subscription.ts:38-46`): a non-JSON response reads *"The licence server sent something unexpected (HTTP {status})."*, and a JSON refusal surfaces the server's own `error` message or *"The licence server refused the request (HTTP {status})."*

**The sentence the decision turns on** (`BillingModule.kt:27-30`): *"a purchase here produces one thing — a purchase token — and that token is a claim, not a proof. It goes to the licence server, which asks Google whether it is real and mints a signed licence if it is. … Somebody who patches this class gets a token the server will reject."*

### 2.3 Crash reports

From `crash.ts`: sent is a stack trace, the app version, and the phone model, *"after somebody has said yes"* (`:5-6`); never sent is "no user id, no custom keys, no logs" and specifically nothing that could carry a transcript line, which is why `recordError` is "deliberately not re-exported" (`:17-19`). The consent gate is `CRASH_CONSENT_KEY` (`:45`), read/written through the encrypted settings store (`crashConsent`/`setCrashConsent`, `:58-79`) and re-applied on every launch — including to turn collection back *off*, because "Crashlytics persists this flag across launches" (`:84-86`). Collection is disabled by default in the manifest, "the only switch that works before any JavaScript runs" (`:15-16`).

The ledger cannot count it: reports are "assembled and uploaded by native Play Services code that this app cannot inspect, intercept or measure" (`:25-26`), which is also why `scripts/check-network-egress.py` no longer lists `telemetry/crash.ts` as an enforced call site (§1).

Files importing `telemetry/crash` (measured — `grep -rl "telemetry/crash" src --include='*.ts' --include='*.tsx' | grep -v __tests__ | wc -l`): **3** — `src/screens/PrivacyScreen.tsx`, `src/screens/SettingsScreen.tsx`, `src/screens/OnboardingScreen.tsx`.

## 3. The permission-less build, replacement by replacement

pending

### 3.1 Models

**Mapping catalog models to Play Asset Delivery pack types, by size** (figures from §8 below, "verify" flags carried over unchanged):

| Pack type | Contents | Bytes |
|---|---|---|
| Install-time (counts toward the app's total; delivered with the APK, no permission — *supplied, verify on Play docs*) | `silero-vad` + `whisper-base` + `diar-seg` + `diar-emb` | 96,309,226 (≈96.3 MB) |
| Install-time or `jniLibs` | `onnxruntime-lib` — 17,571,160 bytes (`ModelCatalog.kt:149`, **measured**), arm64 only. It could instead ship directly in `jniLibs` inside the APK rather than as a pack, which removes it from being a network-shaped item at all; §5 asks this as its own decision (4) since it applies under every option, not only B |
| On-demand (fast-follow, up to **1.5 GB each** — *supplied, verify*) | `whisper-small` 190,085,487 (`:170`) and `embed-bge-small` 36,806,944 (`:277`), each well under the per-pack limit | 226,892,431 |
| On-demand | `llm-qwen` ("the writer") — 1,117,320,736 bytes (`:262`, **measured**), against the 1.5 GB per-pack limit — fits, ≈383 MB of headroom | 1,117,320,736 |
| **Total across app + packs** | | ≈1.46 GB, against Play Asset Delivery's **4 GB total** across the app and all its packs (*supplied, verify*) — comfortable headroom even if `qwen3-asr` (≈972 MB, currently `offered = false`) were ever added |

**What stays:** the sha256 check per part (`ModelManagerModule.kt:203-213`) and the catalog itself (`ModelCatalog.kt`) — both are mechanism-independent and there is no reason PAD removes either as a defence-in-depth layer over Play's own pack integrity checks.

**What goes:** the mirror/upstream fallback list (`sourcesFor`, `ModelCatalog.kt:299-303`) and the app's own `MODEL_BASE_URL` bucket — Play becomes the sole distribution path; `HttpURLConnection`/`fetchTo` (`ModelManagerModule.kt:238-283`) — replaced by `AssetPackManager` callbacks; resume-by-`Range` (`ModelManagerModule.kt:247`) — Play's own pack download already resumes. The improvement-report's open item "separate downloader identity" (`2026-09-15-improvement-report-scorecard.md:115`) becomes moot — there is no app-owned downloader identity left to have one.

**Lost:** a side-loaded APK (no Play Store present) cannot fetch on-demand packs at all, because there is no Play Store app to request them from — install-time content ships inside the Android App Bundle so it is unaffected, but anything on-demand (whisper-small, the writer) would be unreachable outside Play. Judgement: this is very likely immaterial — the product is already Play-only by design (`2026-09-02-play-only-billing-and-admin-console-design.md:20-23`: "The app ships through Google Play, and purchases happen through Play Billing inside the app. There is no web checkout, no desktop build today, and no second store."), so a side-load path is not a distribution channel this product currently supports regardless of the INTERNET decision.

### 3.2 Licence

The device would trust `queryPurchasesAsync` (`BillingModule.kt:295-309`) — what Play itself reports the account owns — instead of a server-signed token.

**Lost, item by item:**
- **Server-side verification against Google.** The design's own reason for the server is exactly this sentence (`BillingModule.kt:27-30`): *"a purchase token is a claim, not a proof … Somebody who patches this class gets a token the server will reject."* Without the server, the claim (Play's local IPC answer) becomes the proof; a patched APK on a rooted phone could, in principle, spoof what `queryPurchasesAsync` reports and grant itself Pro locally, which the current ECDSA-signed-token design specifically defeats.
- **The email sign-in path and the accounts it serves.** `SignInForm.tsx` and `subscription.ts:signIn` go entirely — there is no non-Play way to authenticate an account under Play Billing alone. Who relies on it today is **not established from the read list**: the assigned range of `2026-09-02-play-only-billing-and-admin-console-design.md` (lines 1–60) does not name specific users, and a single `grep -n "tester|founder"` over that file (per the stop-condition rule) found no match — **to verify** directly with the founder before treating this as low-cost.
- **The admin console's view of subscribers.** `register_admin(app, store)` (`main.py:181-184`) would see nothing new — Play Console's own subscriber list would be the only view, which is a real capability loss for "who has subscribed?" (the console's stated Goal, `2026-09-02-...-design.md:27`) unless Play Console's own reporting is judged sufficient.
- **The weekly-cadence refresh.** Moot — nothing to refresh against once there is no server-issued token.

**Kept:** purchase and restore on the same Google account (`buyWithPlay`/`restorePlayPurchase` reduce to calling `Billing` directly), the trial (`trial.ts` is already fully local), the monotonic clock (`LicenceStore.kt` `advanceClock`, needed by the trial regardless of licensing model).

**What the licence server becomes:** under option B it could be retired for licensing entirely, kept only for the legal pages it also serves — `/privacy`, `/terms`, `/delete-account` (`register_pages`, `main.py:171`) are website surfaces, not app traffic, and would need to move or stay hosted independently either way.

### 3.3 Crashes

Android Vitals reports native/Java crashes and ANRs to Play Console with no app permission and no SDK (*supplied, measured by construction*).

**Lost:** JavaScript errors that do not crash the process. This is a smaller loss than the sheet anticipated: `crash.ts:17-19` states `recordError` is "deliberately not re-exported" specifically so no caller can hand it an `Error` that might contain a transcript line — and indeed no file in this app currently imports or calls a `recordError`-shaped function from `telemetry/crash` (the three importers found in §2.3 are the three screens that read consent/availability state, not error reporters). So today's build already reports **zero** non-fatal JS errors through this path; Vitals would not be a regression on that specific axis, only a confirmation that the capability was never wired up.

**The consent toggle becomes moot** — nothing left to consent to. Judgement, flagged for the founder: remove the Settings toggle and the onboarding ask entirely, or keep it as a inert no-op for continuity with existing installs' stored preference? Either is defensible; removing is simpler and matches "don't keep dead surface", but a no-op avoids a jarring UI disappearance for anyone who already turned it on.

**A gain:** the privacy screen's Crashlytics paragraph (`PrivacyScreen.tsx`, the `crashOn` block) goes entirely — the one disclosed-but-uncounted source disappears, and "every byte is counted" becomes literally true rather than true-with-one-named-exception.

### 3.4 The listing

From `docs/play-console.md:84-93`, the permission table without the `INTERNET` row would read:

| Permission | Why |
|---|---|
| `RECORD_AUDIO` | The app records meetings |
| `FOREGROUND_SERVICE`, `..._MICROPHONE`, `..._DATA_SYNC` | The two services above |
| `POST_NOTIFICATIONS` | Recording and processing progress |
| `WAKE_LOCK` | Finishing a transcription without the CPU sleeping mid-pass |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Asked for, never required |

— plus the doc's existing line, unchanged and now stronger: "No `QUERY_ALL_PACKAGES`, no location, no contacts, no storage permissions." The listing could then add, truthfully: *no network access permission of any kind.*

**Judgement:** for a product whose entire pitch is "nothing leaves the phone," a permission table with zero networking rows is a claim a technical buyer can verify from the store listing alone, before installing anything and without reading a privacy policy — that is a materially stronger trust signal than a byte-counting screen inside the app, which only a buyer who has already installed the app will ever see.

## 4. Options and cost

pending

## 5. Decisions for the founder

pending

## 6. Recommendation (judgement)

pending

## 7. Report (status · what was read · what could not be measured · commits)

pending
