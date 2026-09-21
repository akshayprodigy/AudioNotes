# Phase 6a — the INTERNET permission: what it buys, what a build without it costs

## 0. Summary (five sentences, written last)

Today the `INTERNET` permission is used from exactly three enforced call sites — the licence server (sign-in, refresh, Play-purchase redemption), the model download, and the ledger's own recording seam — plus Crashlytics, which the build's own egress check no longer counts because it moved off a JS-driven SDK onto native Play Services. A permission-less build (Play Asset Delivery for ≈1.46 GB of models, Play Billing alone for entitlement, Android Vitals for crashes) is buildable in an estimated three sessions, is store-listing-verifiable with zero networking permissions, but gives up server-side purchase verification (the "a token is a claim, not a proof" design) and the email sign-in path, and cannot be device-tested until the Play product exists in Play Console. A smaller move — packaging the ONNX runtime `.so` into the APK instead of downloading it — costs one session, removes a 17.6 MB download and an open report item, and is independent of the bigger decision. This session's own inventory turned up two corrections to the brief it was asked to write: the JS-error "loss" under Android Vitals is already zero today because `recordError` is never called, and the token-refresh cadence in §1.1 could not be fully quantified because the token's issued lifetime lives outside this session's read list. The recommendation is to take the ONNX-runtime move now regardless, and treat the full no-INTERNET build as a founder call weighed against ≈3 sessions of work and the two entitlement/account losses in §3.2 — not as a step to take solely for the sake of the report item it closes.

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

Three purposes, in descending order of what a person notices: the model download (one-time, largest
number on the privacy screen), the licence (ongoing, mostly invisible), and crash reports (rare,
opt-in, and the one source the ledger cannot count).

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

Same three purposes, each mapped to what Google's own platform already provides without an app-held
`INTERNET` permission: Play Asset Delivery for models, Play Billing's own local query for
entitlement, and Android Vitals for crashes.

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

| Option | Store shows | Models | Entitlement | Crashes | What is lost | Cost (builder sessions) |
|---|---|---|---|---|---|---|
| **A. Keep INTERNET (today)** | Full network access | download + mirror | server-signed | Crashlytics | — | 0 |
| **B. No INTERNET** | none | Play Asset Delivery | Play Billing alone | Android Vitals | §3's lists (server-side purchase verification, email sign-in, admin-console visibility, non-fatal-JS reporting — already null today) | **estimate: 3 sessions** |
| **C. Keep INTERNET, close the two side items** | Full network access | download; ORT `.so` in the APK | server-signed | Crashlytics | — | **estimate: 1 session** |

**Option B, work items (judgement, sized):**
1. *Models session* — Gradle asset packs (install-time + 2 on-demand) wired into the AAB; `AssetPackManager` integration in `ModelManagerModule` replacing `HttpURLConnection`/`fetchTo`, keeping the sha256 check and the catalog; onboarding/Settings/paywall progress UI adapted to PAD's callback shape instead of byte-count polling.
2. *Entitlement + server-retirement session* — `LicenceStore`/`Licence.kt` rebuilt around `queryPurchasesAsync` instead of a signed token; remove `signIn`/`refreshIfNeeded`/`redeem` and `SignInForm`; decide the fate of the licence server's licensing endpoints (retire vs. keep only `/privacy`/`/terms`/`/delete-account`); update the admin console's story since it would see nothing new.
3. *Crash + gate session* — remove (or no-op, per §5) Crashlytics collection, the consent UI and the privacy screen's Crashlytics paragraph; `scripts/check-network-egress.py`'s `ALLOWED` set drops to empty and the script's assertion changes from "exactly these files" to "zero files"; manifest permission removed; a device run on a 64-bit phone to confirm PAD actually delivers (**this cannot happen until the Play product exists in Play Console — it does not today**, per §8).

**Honesty about the unknowns:** Play Asset Delivery has never been used in this repo — session 1's estimate carries the most risk of the three. The Play product does not yet exist in Play Console (§8; also `2026-09-17-release-phases.md` Phase 6's row), so option B cannot be device-verified, only built and reviewed, until that product exists — the same blocker Phase 6b already names for the final gate.

**Option C, work items (judgement, sized):** one session — move `onnxruntime-lib` out of the download path and into `jniLibs` inside the APK (removes the 17.6 MB first-run download and the improvement report's "ONNX runtime packaged, not downloaded" open item, `2026-09-15-improvement-report-scorecard.md:117`); no manifest, entitlement, or crash-reporting change at all.

## 5. Decisions for the founder

1. **A, B, or C.** Keep `INTERNET` as-is (A); remove it entirely for Play Asset Delivery + Play Billing alone + Android Vitals (B); or keep it but fold the ORT runtime into the APK (C). A commits to the status quo cost (0 sessions) and the current trust story (a byte-counting screen with one named, disclosed exception). B commits to ≈3 builder sessions, losing server-side purchase verification and the email sign-in path, in exchange for a store listing with no networking permissions at all — verifiable by anyone before they install. C commits to 1 session and removes only the smallest of the three open privacy-report items, keeping everything else as today.
2. **If B: is the email sign-in path given up?** Yes commits to Play Billing as the only way into a subscription on this device — no non-Play sign-in, no accounts the design doc's read range identifies a use for beyond what could not be established this session (§3.2 — to verify with the founder before deciding). No means B is not really available as scoped, since Play Billing alone has no concept of a server account to sign into.
3. **If B: is JS-error reporting given up, or replaced?** Given up commits to relying solely on Android Vitals (native/Java crashes and ANRs only) — which, per §3.3, is not actually a reduction from what ships today, since `recordError` is never called from anywhere in this app right now. Replaced would mean building a new non-fatal-JS-error path from scratch, which is new scope this session found no existing demand for.
4. **Does the ORT `.so` move into the APK regardless of A/B/C?** Yes removes a 17.6 MB first-run download and the improvement report's "runtime packaged" item under every option, at the cost of an equivalent increase in the arm64 APK/AAB split size. No leaves it exactly as it is today. This decision is independent of 1–3 and could be taken immediately.

## 6. Recommendation (judgement)

**C now, B later if the founder wants the store-listing claim badly enough to fund it.** The strongest reason *for* B is that a permission table with zero networking rows is verifiable by a technical buyer from the store listing alone, before they install anything — a stronger, cheaper-to-check trust signal than any in-app screen, and it closes the improvement report's single remaining open privacy item outright. The strongest reason *against* B is that its two real losses — server-side purchase verification (a patched, rooted-phone APK could self-grant Pro against a local Play IPC answer, where today the signed token forces the claim through a server that can refuse it) and the email sign-in path (whose current userbase this session could not establish and is flagged to verify) — are both entitlement-integrity and account-flexibility regressions taken on for a permission-table line, not for anything a user-facing feature needs, and B cannot even be device-verified until the Play product exists in Play Console. Option 4 (the ORT `.so` into `jniLibs`) is worth taking regardless of A/B/C — it is one session, has no listed downside, and independently removes a device-observed re-download bug's largest single file from the network path.

## 7. Report (status · what was read · what could not be measured · commits)

**Status:** complete. All seven steps done; §0 written last; every section filled; no product code touched.

**Files read** (exactly the ranges in the execution sheet's §1): `android/app/src/main/AndroidManifest.xml`, `scripts/check-network-egress.py` (also run twice), `src/privacy/ledger.ts`, `src/privacy/summary.ts`, `src/screens/PrivacyScreen.tsx`, `src/billing/subscription.ts`, `src/billing/trial.ts`, `android/.../billing/Licence.kt`, `android/.../billing/LicenceStore.kt`, `android/.../billing/BillingModule.kt`, `server/app/main.py`, `server/app/play.py`, `android/.../pipeline/ModelManagerModule.kt`, `android/.../data/ModelCatalog.kt`, `src/screens/OnboardingScreen.tsx`, `src/screens/PaywallScreen.tsx`, `src/screens/SettingsScreen.tsx`, `src/billing/SignInForm.tsx`, `src/telemetry/crash.ts`, `docs/play-console.md`, `docs/superpowers/specs/2026-09-06-privacy-proof-design.md`, `docs/superpowers/specs/2026-09-02-play-only-billing-and-admin-console-design.md`, `docs/superpowers/specs/2026-09-15-improvement-report-scorecard.md`, `docs/superpowers/plans/2026-09-17-release-phases.md`. `server/app/licence.py`, `server/app/store.py` and `server/app/entitlement.py` were grepped for symbol locations only, per the stop-condition rule — never read in full or by range.

**What could not be measured, and why:**
- The signed token's issued lifetime (§1.1, §2.2) — set in `issue()`, which lives in `server/app/entitlement.py`, outside the read list; the exact monthly `refreshIfNeeded` call count is therefore an estimate rather than a count.
- Exact per-field JSON payload byte sizes (§1.1) — no device measurement was taken this session (Rule 0: no device); sized per the sheet's own "assume ≤ 200 bytes a field" guidance and marked estimate throughout.
- Who uses the email sign-in path today (§3.2, §5.2) — the assigned range of the 2026-09-02 design doc (lines 1–60) does not name specific users; a single `grep -n "tester|founder"` over that whole file, per the stop-condition rule, found no match. Recorded as "to verify" rather than asserted.
- Every Play Asset Delivery mechanic in §3.1 and §8 (pack types, the 1.5 GB/4 GB limits, Play Billing's IPC-not-permission behaviour) is carried exactly as *supplied* with its "verify" flag intact — this session did not independently confirm current Play documentation.

**A correction the inventory surfaced, not anticipated by the sheet:** §3.3's "lost: JS errors that do not crash the process" is smaller than framed — `crash.ts` never re-exports a `recordError`-shaped call, and no file in the app calls one today, so Android Vitals would not regress anything currently shipping on that axis.

**Verification pass (Step 6):** `python3 scripts/check-network-egress.py` → `exit=0`, re-run clean. Three quotes spot-checked verbatim with `grep -n` (`BillingModule.kt`'s "claim, not a proof", `OnboardingScreen.tsx`'s "That download stopped", `Licence.kt`'s "remaining life IS the grace period") — all matched exactly. The table of contents matches the execution sheet's §3 exactly. `git diff --stat 9c1b2a0..HEAD` shows **four** files, not two, because two docs commits (`d92bacd`, `9f70d5f` — the phase split and the execution sheet itself) already sat between `9c1b2a0` and this session's actual starting point; they predate this session and are not this session's edits. Scoped instead to this session's own start (`d92bacd..HEAD`), the diff is exactly the two files the rule intends: the brief and the progress file, nothing else.

**Commits this session:**
- `b15123e` docs(6a): the INTERNET decision brief — frame
- `3adee1f` docs(6a): §1 inventory — every byte, by call site
- `1f3caec` docs(6a): §2 what the permission buys, and today's offline behaviour
- `5e0eb05` docs(6a): §3 the permission-less build, replacement by replacement
- `05b9920` docs(6a): §4–§6 options, decisions, recommendation
- `2574ea8` docs(6a): brief checked against its rules
- (final) docs(6a): report; progress file retired

## 8. Review (the brain, 21 Sep)

Faithful to its sheet: one file, the progress file created and retired, every figure sourced or
flagged, the three spot-checked quotes verbatim. The two gaps it flagged close from the server code
it was not allowed to read, and three considerations are added.

**Closed — the token's lifetime (measured).** `DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60`
(`server/app/licence.py:40`); `issue()` caps it at the subscription's own ceiling
(`server/app/entitlement.py:74`). With `RENEW_WINDOW_SECONDS` = 5 days, a Pro phone refreshes about
every 9 days: **≈3.3 calls and ≈3 kB a month.** After a lapsed renewal the server allows 3 days
(`PAYMENT_GRACE_SECONDS`, `entitlement.py:29`) before the token stops being reissued.

**Closed — who uses the email sign-in (measured).** Nobody can, today. `store.create_account()` is
called from one place, the Play-link path (`server/app/billing.py:140`), with no email and no
password; a password is set only by `store.py:325`, reached from `deploy/seed-test-account.sh`; the
admin console is read-only by construction (`server/app/admin.py:4-7`). The schema's own comment says
what the path is for: "They can add an email later to use the subscription on a desktop" — a client
that does not exist. **Decision 2 therefore costs nothing today**; it forecloses a desktop client
sharing one subscription, which would need a server again.

**Added — the store-visible size (supplied, verify).** Under B the essentials become install-time
packs, so the listing's download size rises from ≈30 MB (today's AAB) to ≈130 MB. The repo's own
comment (`src/native/NativeModelManager.ts:1-2`) records why that matters: size kills install
conversion. Fast-follow packs — fetched by Play right after install, not shown as install size — may
avoid it; verify on the Play docs before sizing B's first session.

**Added — the server itself.** B retires the licence server as a running cost and as a single point
of failure for paying customers (today the 14-day token is the only thing standing between a server
outage and a lockout). The brief lists the server's losses; this is its gain.

**Corrected — what Android Vitals sees.** In a release build an uncaught JavaScript exception IS a
process crash (`com.facebook.react.common.JavascriptException`, with the JS stack in its message), so
Vitals reports it. The only class B loses is non-fatal JS errors — which, as §3.3 found, are zero.

**Review verdict on the recommendation.** C is right and belongs in 6b's build regardless. On B the
brief is fair; with the two closures above, B's real remaining costs are (1) server-side purchase
verification, (2) ≈3 sessions with Play Asset Delivery never used here, (3) no device test until the
Play product exists, (4) the listing's size unless fast-follow works. Its gain is the one claim this
product's buyer can verify before installing. Sequencing suggestion (judgement): launch on C; make B
the first post-launch release, tested on a Play internal track once the product exists — removing a
permission in an update is a change users welcome, adding one is not, so nothing is lost by the order.
