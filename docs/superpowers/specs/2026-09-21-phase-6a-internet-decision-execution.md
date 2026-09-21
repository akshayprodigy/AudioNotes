# Phase 6a — execution sheet: the INTERNET-permission decision brief

*21 September 2026, against `9c1b2a0`. One session, seven steps, ~90 builder steps. This session
writes ONE document and touches no product code. Its output is a decision brief with numbers; the
decision itself is the founder's.*

**Why.** Verbale's whole pitch is that nothing leaves the phone. Today the app holds the `INTERNET`
permission for exactly three things — the model download, the licence server (Play purchase
verification, weekly refresh, email sign-in) and Crashlytics — and it already proves the rest with a
byte-counting privacy ledger and a build check that fails if a fourth network call site appears.
The improvement report's last open privacy item is "a build with no INTERNET permission at all" —
the strongest trust claim an app like this can make, and one anyone can verify from the store
listing. Nobody has yet written down what that build would cost and what it would give up. That is
this session's job: **measure what the permission buys, item by item, against what a permission-less
build would need instead — then lay the options side by side for the founder.** Not an opinion
piece: every claim carries a file:line, a number or a "to verify" flag.

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. `grep -n` then `sed -n 'A,Bp'`, at
  most 80 lines at a time. Do not re-read a file after quoting it. Do not paste files into your
  messages; write the brief.
- **No product code.** The only files this session creates or edits are the brief
  (`docs/superpowers/specs/2026-09-21-phase-6a-internet-decision.md`) and the progress file
  (`docs/superpowers/reports/phase-6a-progress.md`). `git diff --stat` at the end names those two
  and nothing else. If a fact needs code to be changed to find out, write "not measured: would need
  X" in the brief instead.
- **No device.** The tablet's onboarding state belongs to the founder's pending by-hand run; do not
  run `adb`. Offline behaviour is read from the code's own error paths (Step 3), which is where the
  copy lives anyway.
- **Every claim is one of three kinds**, marked as such in the brief: **measured** (a number from
  the code or catalog, with file:line), **supplied** (a figure the brain put in §8 of this sheet —
  copy it with its "verify" flag; do not restate it as your own), or **judgement** (say so).
- **Commit after each step**, subject in the house style (`git log --oneline -6`). Never push.
  **`git status` must be clean before you stop.**
- **Progress file.** First action: create it with the seven steps as checkboxes and *Notes*.
  Update and commit it with every step.
- **Hand-over at 150 steps**: commit, progress file, stop. Stop also on a §6 condition.

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `android/app/src/main/AndroidManifest.xml` | 1–12 | the permission set as declared |
| `scripts/check-network-egress.py` | 1–60 | the three call sites the build enforces; run it (Step 2) |
| `src/privacy/ledger.ts` | all (77) | the one seam bytes are recorded through |
| `src/privacy/summary.ts` | all (66) | the ledger's kinds and the screen's arithmetic |
| `src/screens/PrivacyScreen.tsx` | 25–45, 80–135 | the claims the app makes today, verbatim |
| `src/billing/subscription.ts` | all (289) | the licence server calls: what each sends, when, and its error copy |
| `src/billing/trial.ts` | 1–60 | the trial is local — confirm, cite |
| `android/.../billing/Licence.kt` | 1–30, 50–115 | the signed token: fields, expiry as grace, verification |
| `android/.../billing/LicenceStore.kt` | 20–60, 90–146 | `current`, `entitled`, the monotonic clock |
| `android/.../billing/BillingModule.kt` | 20–70, 285–341 | purchase → token → server; `restore`; `acknowledgeLocally` |
| `server/app/main.py` | 60–190 | the three API endpoints the app calls, and what each verifies |
| `server/app/play.py` | 1–60 | how the server asks Google about a purchase token |
| `android/.../pipeline/ModelManagerModule.kt` | 126–200, 240–300 | the download: sources, resume, sha256; its error copy |
| `android/.../data/ModelCatalog.kt` | 140–290, 300–330 | every model's size and sources; `sourcesFor` (mirror + upstream) |
| `src/screens/OnboardingScreen.tsx` | 262–282 | the failed-download screen's copy |
| `src/screens/PaywallScreen.tsx` | 204–232 | the trial's download failure copy |
| `src/screens/SettingsScreen.tsx` | 420–460 | the Get failure copy; the sign-in form's use |
| `src/billing/SignInForm.tsx` | all | the email sign-in path (what a permission-less build loses) |
| `src/telemetry/crash.ts` | all (100) | what Crashlytics is given, and the consent gate |
| `docs/play-console.md` | 80–95 | the permission table as the store will show it |
| `docs/superpowers/specs/2026-09-06-privacy-proof-design.md` | 1–80 | the ledger's design and its stated limits |
| `docs/superpowers/specs/2026-09-02-play-only-billing-and-admin-console-design.md` | 1–60 | why the server exists; Play-only is already decided |
| `docs/superpowers/specs/2026-09-15-improvement-report-scorecard.md` | 105–125 | the three open privacy items this decision touches |
| `docs/superpowers/plans/2026-09-17-release-phases.md` | 10–25 | Phase 6's row; do not edit |

**Must not change:** everything. This session edits no file but the brief and the progress file.

---

## 2. Steps

### Step 1 — the frame

Create the progress file. Create the brief with the table of contents in §3, each section holding
one line: *pending*. Commit: `docs(6a): the INTERNET decision brief — frame`.

### Step 2 — the inventory (measured)

Run `python3 scripts/check-network-egress.py; echo "exit=$?"` → must end `exit=0`. Then fill §1 of
the brief, **one row per network call site**, from the code:

| Call site (file:line) | Kind in the ledger | Host | Fires when | Sends (fields, from the code) | Receives | Counted by the ledger? |

Rows to find: (a) `subscription.ts` `signIn` → `/api/account/signin`; (b) `refreshIfNeeded` →
`/api/licence/refresh` (state the cadence: `RENEW_WINDOW_SECONDS` against the token's lifetime — read
the lifetime from `server/app/main.py`'s refresh handler or `licence.py` if main.py delegates; if the
lifetime is not in the read list, write "lifetime: not in read list, to verify"); (c) `redeem` →
`/api/billing/play/link` after a Play purchase or restore; (d) `ModelManagerModule.download` → the
catalog's mirror first, upstream (GitHub/Hugging Face) as fallback, per part; (e) Crashlytics — native,
Play Services, host and bytes not observable from the app; fires on a crash and only when the consent
in `crash.ts` is on. Also `Linking.openURL` to the Play subscriptions page (SettingsScreen ≈220) —
note it as "hands off to the Play app; not this app's traffic".

Then §1.1: **what a person's phone actually sends per month** (measured, arithmetic from the rows):
three profiles — *free, never signed in* (models once; nothing after), *Pro via Play* (models once,
one redeem, then refreshes at the cadence you found: give payload bytes per call from the field list,
assume ≤ 200 bytes a field), *Pro via email sign-in* (add the sign-in). One table, bytes and calls per
month, and the one-time model bytes per tier from the catalog (essentials, + Pro extras, + the
writer). Mark it *measured* where the numbers come from code and *estimate* where you sized a field.

Commit: `docs(6a): §1 inventory — every byte, by call site`.

### Step 3 — what the permission buys, and what its absence looks like today (measured)

§2 of the brief, one subsection per purpose:

**2.1 Models.** Which models, sizes (catalog), first-run total for free and for Pro, whether anything
re-downloads later (the `allPresent` early return says no; cite). Then: **offline today** — the exact
copy a person sees when the download cannot reach the network, from `OnboardingScreen` (the failed
screen, quote it), `PaywallScreen` (the Alert), `SettingsScreen` (the Alert). Quote each verbatim with
file:line.

**2.2 Licence.** What each of the three endpoints establishes (from `main.py`) and what the device
trusts without the network: the signed token's `expiresAt` is the grace period (`Licence.kt` 1–30 —
quote the sentence), the monotonic clock (`LicenceStore.kt`), the trial being local (`trial.ts`).
Then: **offline today** — a Pro user with a valid token loses nothing until expiry; state the
expiry-to-lockout behaviour you can read, and quote `subscription.ts`'s error copy for a failed
refresh/sign-in. Then the design's own reason for the server (`BillingModule.kt` 20–45, quote: a
purchase token "is a claim, not a proof") — this is the sentence the decision turns on.

**2.3 Crash reports.** From `crash.ts`: what is sent (stack, app version, phone model), what is never
sent, the consent gate, and that the ledger cannot count it. Count how many files import
`telemetry/crash` (`grep -rl "telemetry/crash" src --include='*.ts' --include='*.tsx' | grep -v __tests__ | wc -l`).

Commit: `docs(6a): §2 what the permission buys, and today's offline behaviour`.

### Step 4 — the permission-less build: what replaces each (supplied + judgement)

§3 of the brief, one subsection per replacement, each ending in a **"what is lost"** list:

**3.1 Models → Play Asset Delivery.** Use the figures in §8 of this sheet (copy their "verify" flags).
Map every catalog model to a pack type by size: essentials as install-time (sum them; include
`onnxruntime-lib` and say whether it could instead ship in `jniLibs` — it is a 17.6 MB `.so`, arm64
only), `whisper-small` and `embed-bge-small` as on-demand, `llm-qwen` as on-demand (1.12 GB against
the per-pack limit in §8). State what stays: the sha256 check, the catalog. State what goes: the
mirror/upstream sources, `HttpURLConnection`, resume-by-Range, the "separate downloader identity"
item (moot). Lost: side-loaded/APK installs cannot fetch models at all (no Play → no packs) — say
whether that matters for a Play-only product.

**3.2 Licence → Play Billing alone.** The device would trust `queryPurchasesAsync` (the state Play
reports) instead of a server-signed token. Lost, item by item: server-side verification against
Google (the "claim, not a proof" sentence — a patched APK on a rooted phone could grant itself Pro);
the email sign-in and the accounts it serves (who uses it today, from the design doc: testers, the
founder's grants); the admin console's view of subscribers (it would see nothing — Play Console does
instead); the weekly refresh (moot). Kept: purchase, restore on the same Google account, the trial,
the monotonic clock. Say what the licence server would become (retired, or kept only for the legal
pages `/privacy`, `/terms`, `/delete-account` which are website, not app).

**3.3 Crashlytics → Android Vitals.** Vitals reports native and Java crashes and ANRs to Play Console
with no app permission and no SDK. Lost: JavaScript errors that do not kill the process (the
`recordError` paths — count from Step 3), the consent toggle becomes moot (remove or keep as a no-op?
— judgement, flag it), the privacy screen's Crashlytics paragraph goes (a gain: the one uncounted
source disappears and the screen's claim becomes total).

**3.4 What the store listing would show.** From `docs/play-console.md` 80–95: the permission table
without `INTERNET`, and the sentence the listing could then make. Judgement: one paragraph on what
that is worth to this product's buyer.

Commit: `docs(6a): §3 the permission-less build, replacement by replacement`.

### Step 5 — the options and their cost (judgement, sized)

§4 of the brief: a table with three rows —

| Option | Store shows | Models | Entitlement | Crashes | What is lost | Cost (builder sessions) |
|---|---|---|---|---|---|---|
| A. Keep INTERNET (today) | Full network access | download + mirror | server-signed | Crashlytics | — | 0 |
| B. No INTERNET | none | Play Asset Delivery | Play Billing alone | Android Vitals | §3's lists | your estimate |
| C. Keep INTERNET, close the two side items | Full network access | download; ORT `.so` in the APK | server-signed | Crashlytics | — | your estimate |

Cost in builder sessions, each ≤ 150 steps, listing the work items per session (for B: Gradle asset
packs + `AssetPackManager` in `ModelManagerModule` replacing HTTP; `LicenceStore` from Play purchases
+ removing sign-in/refresh/redeem + the server retire; Crashlytics removal + consent UI + privacy
screen + `check-network-egress.py` (which then asserts ZERO sites); the manifest; the gate; a device
run on a 64-bit phone). Be honest about the unknowns: PAD has never been used in this repo; the Play
product does not yet exist in Play Console (so B cannot be device-tested until it does).

§5 of the brief: **§0-style decisions for the founder** — numbered, each one sentence, each with the
two answers and what each answer commits to. At minimum: (1) A, B or C; (2) if B, whether the email
sign-in path is given up; (3) if B, whether JS-error reporting is given up or replaced (by what);
(4) whether the ORT `.so` moves into the APK regardless (it removes a 17.6 MB download and the
"runtime packaged" item, under any option).

§6 of the brief: **recommendation** — one paragraph, marked *judgement*, with the single strongest
reason for and the single strongest reason against.

Commit: `docs(6a): §4–§6 options, decisions, recommendation`.

### Step 6 — verify the brief against its own rules

Read the brief once, top to bottom. Every number has a file:line or a "supplied — verify" flag or an
"estimate". Every quote is verbatim (spot-check three with `grep -n`). The table of contents matches
§3 of this sheet. `python3 scripts/check-network-egress.py` still `exit=0`. `git diff --stat 9c1b2a0..HEAD`
names only the brief and the progress file. Fix, commit: `docs(6a): brief checked against its rules`.

### Step 7 — report and hand-over

Append §7 *Report* to the brief (see §7 below). `git rm docs/superpowers/reports/phase-6a-progress.md`.
Commit: `docs(6a): report; progress file retired`. `git status` → clean. Stop.

---

## 3. The brief's table of contents (fixed)

```
# Phase 6a — the INTERNET permission: what it buys, what a build without it costs
0. Summary (five sentences, written last)
1. Inventory — every network call site            1.1 What a phone sends per month, three profiles
2. What the permission buys today                 2.1 Models  2.2 Licence  2.3 Crash reports
3. The permission-less build, replacement by replacement   3.1 Models  3.2 Licence  3.3 Crashes  3.4 The listing
4. Options and cost
5. Decisions for the founder
6. Recommendation (judgement)
7. Report (status · what was read · what could not be measured · commits)
```

## 4. Exact commands

| Step | Command | Must print |
|---|---|---|
| 2, 6 | `python3 scripts/check-network-egress.py; echo "exit=$?"` | `exit=0` |
| 3 | `grep -rl "telemetry/crash" src --include='*.ts' --include='*.tsx' \| grep -v __tests__ \| wc -l` | a number (today 3) |
| 6 | `git diff --stat 9c1b2a0..HEAD \| tail -3` | the brief, the progress file, nothing else |

## 5. Acceptance

- The brief exists with the §3 table of contents, every section filled, §0 written last.
- Every network call site in `check-network-egress.py`'s `ALLOWED` set appears in §1 with file:line.
- Every figure from §8 below appears with its "verify" flag intact.
- No product file changed: `git diff --stat 9c1b2a0..HEAD` names two files.
- `git status` clean; nothing pushed.

## 6. Stop conditions

- A fact needs code to be run or changed to establish → write "not measured: would need …", continue.
- A file in the read list is not where the sheet says → `grep -rn` for the symbol once; if still
  absent, record it and continue without it.
- 150 steps → commit, progress file, stop.

## 7. Report (appended to the brief as §7)

Status in one line · the files actually read (names only) · every claim you could not measure and
why · the commits.

---

## 8. Facts supplied by the brain (copy with their flags; the founder verifies before deciding)

| Fact | Figure | Flag |
|---|---|---|
| Play Asset Delivery: install-time packs | count toward the app's total; delivered with the APK, no permission | verify on Play docs |
| Play Asset Delivery: fast-follow / on-demand packs | up to **1.5 GB each**, fetched by the Play Store app on the app's request — the app needs no `INTERNET` permission of its own | verify (1.5 GB per-pack limit) |
| Play Asset Delivery: total | **4 GB** across the app and all its packs | verify |
| Play Billing without `INTERNET` | `queryPurchasesAsync`, `launchBillingFlow`, acknowledge all go over IPC to the Play Store app; the app's own permission is not involved | verify |
| Android Vitals | crashes and ANRs reported by the system to Play Console; no SDK, no permission; **JavaScript exceptions that do not crash the process are not seen** | measured (by construction) |
| The ORT runtime `.so` | 17,571,160 bytes (`ModelCatalog.kt:149`), arm64 only; loadable from `jniLibs` instead of a download | measured |
| The writer | 1,117,320,736 bytes (`ModelCatalog.kt:262`) — under the per-pack limit above | measured |
| Sizes: essentials, whisper-small, embed | read from the catalog in Step 3 | measured |
| The Play product | does not yet exist in Play Console (the founder's item) — option B cannot be device-tested until it does | project state |
