# Play free trial replaces the in-app trial, and buying works — execution sheet

*23 September 2026, against `5d10b55` plus the four uncommitted release-prep files (Step 0). For
the sessions that build it. Every file, line range, string and test below was grepped today and
every expected string was computed by running the code. Do not design anything: where this sheet
names copy, a rule or a number, it is the decided answer.*

**What the founder decided today (not open for change):**

1. **One subscription, `verbale_pro`, with base plans `monthly` and `annual`** — the shape the
   code already expects. The founder re-creates it in Play Console; the two products made on
   23 Sep (`verbale_pro_1m`, `verbale_pro_12m`) are deactivated. No product id changes in code.
2. **Play's free trial replaces the in-app trial.** A 7-day free-trial *offer* sits on each base
   plan (eligibility: never had any subscription). The in-app "7 days or 3 summaries, no card"
   trial is removed from every screen and from release-build entitlement. It survives only as a
   **debug-build** entitlement lever, because four device-test classes use its settings keys to
   get Pro.

**What is wrong in the code today (why this sheet exists):**

- `BillingModule.plans()` emits one row **per offer**, not per base plan. With a trial offer on
  Monthly, Play returns two Monthly offers → two Monthly rows (duplicate React keys), one priced
  "Free". `purchase()` takes whichever offer Play listed first — the trial or not, by chance.
- **Existing bug, found while planning:** `RecordingService` reads the 15-minute cap once, from
  the start intent. "Keep recording" on the cap card started the in-app trial and lifted the cap
  **on screen only** — the service still stopped the recording at 15:00. Step 4 fixes it.
- The server adds the 3-day payment grace to a **cancelled** subscription's token, although
  `is_entitled` already refuses grace to a cancellation. With Play trials this means a trial
  cancelled on day 2 keeps Pro for 3 days after the trial. Step 5 fixes it.

**Three sessions.** Session A = Steps 0–5 (native, server; no device). Session B = Steps 6–12
(TypeScript, screens, docs, gate, report; no device). Session D = the founder's by-hand run
(report §7) — it needs the Play product, the service account and a licence tester, none of which
a builder can supply.

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. Never print a file over 200
  lines; `grep -n` to locate, then `sed -n 'A,Bp'` for at most 60 lines. `PaywallScreen.tsx` is
  585 lines, `RecordScreen.tsx` 587, `OnboardingScreen.tsx` 590, `SummaryTab.tsx` 621,
  `RecordingService.kt` is large: only the ranges named. Every command ends in its filter — run
  it exactly as written. Do not re-read a file after editing it. Do not paste code into your
  messages; commit it and name the file.
- **TDD + mutant.** Test first, watch it fail, write the code, watch it pass, apply the **named
  mutant**, watch the test fail, restore, green again. Record every mutant in the progress file's
  *Mutants* section as it happens. Never run a mutation-restore in the background.
- **Commit after each step**, subject in the house style (`git log --oneline -6`). **Never push**
  — the founder pushes. **Never run `connectedDebugAndroidTest`** (it uninstalls the app and
  wipes the phone). **Never run `adb`** in Sessions A or B. **`git status` must be clean before
  you stop.**
- **Indent like the surrounding file**: two spaces in TypeScript and Kotlin, four in Python.
  JSX attributes one per line when the tag wraps, as the neighbours do.
- **Progress file.** First action of Session A (after Step 0): create
  `docs/superpowers/reports/play-trial-progress.md` with Steps 0–12 as checkboxes and the headings
  *Decisions*, *Mutants*, *Notes for the next session*. Update and commit it with every step.
  Session B reads it first.
- **Hand-over at 150 steps**, whatever remains: finish the step you are on, commit, update the
  progress file, stop.

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `docs/play-console.md` | 17–23, 136–200, 345–352 | Steps 0, 11 |
| `android/app/src/main/java/com/innocorelabs/verbale/billing/BillingModule.kt` | 1–21, 129–286 | Step 2 |
| `android/app/src/main/java/com/innocorelabs/verbale/billing/LicenceStore.kt` | 130–139 | Step 3 |
| `android/app/src/main/java/com/innocorelabs/verbale/billing/Trial.kt` | 1–30 | Step 3 (doc comment only) |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/RecordingService.kt` | 1–30, 425–440 | Step 4 |
| `android/app/src/test/java/com/innocorelabs/verbale/billing/LicenceTest.kt` | 1–30 | Step 1: the JVM test idiom to copy |
| `android/app/build.gradle` | 250–255 | Step 2: the stale default id |
| `server/app/entitlement.py` | 52–90 | Step 5 |
| `server/tests/test_entitlement.py` | 1–24, 39–80 | Step 5 |
| `src/native/NativeBilling.ts` | 17–40 | Step 6 |
| `src/billing/__tests__/referencePrice.test.ts` | 1–30 | Step 6: the `plan()` fixture gains two fields |
| `src/billing/trial.ts` | all (≈330 lines — read 1–60, 60–200, 200–330 in three reads) | Step 7 |
| `src/billing/__tests__/trial.test.ts` | 1–30, 66–195 | Step 7 |
| `src/screens/PaywallScreen.tsx` | 40–70, 130–175, 176–330, 383–525 | Step 8 |
| `src/screens/__tests__/PaywallScreen.test.tsx` | all (≈100) | Step 8 |
| `src/navigation/RootNavigator.tsx` | 50–60 | Step 8 |
| `src/screens/meeting/SummaryTab.tsx` | 1–20, 180–215, 430–440 | Step 9 |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | 1–70, 340–362 | Step 9 |
| `src/screens/RecordScreen.tsx` | 1–40, 88–100, 185–195, 418–455 | Step 10 |
| `src/screens/OnboardingScreen.tsx` | 1–20, 72–125, 184–205, 400–420 | Step 10 |

**Interfaces you use without reading their files:**
`buyWithPlay(basePlanId: string | null): Promise<{ paid: boolean; pendingServer?: boolean }>`,
`playAvailable(): Promise<boolean>`, `playPlans(): Promise<PlayPlan[]>` from
`src/billing/subscription`; `Licence.status(): Promise<{ paid: boolean; ... }>` from
`src/native/NativeLicence`; `capMsFor(paid: boolean): number` from `src/billing/recordingCap`;
`runnable(list)` from `src/screens/deviceFit`; `ModelManager.list(): Promise<string>`,
`ModelManager.download(id)`; `Button`, `SoftButton`, `Txt` from `src/components/ui`;
`LicenceStore.entitled(ctx: Context): Boolean` in Kotlin.

---

## 2. Files that must not change

- `server/app/play.py`, `server/app/billing.py` — verification and acknowledgement already work
  for any product id and for a trial (Google reports a trial as `SUBSCRIPTION_STATE_ACTIVE`).
- `src/billing/subscription.ts` — `buyWithPlay`, `redeem`, `referencePrice` are unchanged. The
  new helpers go in a NEW file (Step 6) so screen tests need not mock them.
- `android/gradle.properties` — `playSubscriptionId=verbale_pro` is already right.
- `Trial.kt` code (only its doc comment changes), `Narrator.kt`, `BackupManager.kt`, and every
  file under `android/app/src/androidTest/` — the device tests keep using the trial keys, which
  keep working in debug builds.
- `src/billing/recordingCap.ts`, `src/pipeline/PipelineController.ts`.

---

## 3. Implementation sequence

### Session A — native and server

#### Step 0. Land the release-prep changes already in the tree

The tree carries four uncommitted files from the founder's release prep (R8 on, resource
shrinking, Billing Library 7.1.1 → 8.3.0 with the matching `queryProductDetailsAsync` change,
version 1.0.1). They are correct except one typo: in `docs/play-console.md` a blank line became
a lone `0`.

1. `sed -n 19,23p docs/play-console.md` — line 21 is `0`, between `### Data collected` and the
   table. Replace that line with an empty line (Edit tool: old `### Data collected\n0\n| Type`,
   new `### Data collected\n\n| Type`).
2. `git diff --stat` must name exactly the four files: `android/app/build.gradle`,
   `android/app/proguard-rules.pro`, `.../billing/BillingModule.kt`, `docs/play-console.md`.
   If it names anything else: stop condition.
3. Commit those four files plus this sheet:
   `build(release): R8 + resource shrinking, Play Billing 8.3.0, version 1.0.1`.
4. Create the progress file (§0) and commit it.

#### Step 1. `OfferChoice` — which offer sells a base plan (pure, JVM-tested)

**Test first.** Create `android/app/src/test/java/com/innocorelabs/verbale/billing/OfferChoiceTest.kt`:

```kotlin
package com.innocorelabs.verbale.billing

import com.innocorelabs.verbale.billing.OfferChoice.Offer
import com.innocorelabs.verbale.billing.OfferChoice.Phase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Play lists one entry per OFFER — the base plan itself and every developer offer this account is
 * eligible for — not one per plan. These pin which one the paywall shows and the purchase uses.
 */
class OfferChoiceTest {

  private val monthlyPrice = Phase("₹299", 299_000_000L, "P1M", 0)
  private val annualPrice = Phase("₹2,499", 2_499_000_000L, "P1Y", 0)
  private val freeWeek = Phase("Free", 0L, "P1W", 1)

  private val monthlyBase = Offer("monthly", null, "tok-m", listOf(monthlyPrice))
  private val monthlyTrial = Offer("monthly", "free-trial-7d", "tok-m-trial", listOf(freeWeek, monthlyPrice))
  private val annualBase = Offer("annual", null, "tok-a", listOf(annualPrice))

  @Test fun `a free trial is chosen over the base plan wherever Play lists it`() {
    assertEquals("tok-m-trial", OfferChoice.choose(listOf(monthlyBase, monthlyTrial), "monthly")?.offerToken)
    assertEquals("tok-m-trial", OfferChoice.choose(listOf(monthlyTrial, monthlyBase), "monthly")?.offerToken)
  }

  @Test fun `with no developer offer the base plan is sold`() {
    assertEquals("tok-a", OfferChoice.choose(listOf(monthlyTrial, annualBase), "annual")?.offerToken)
  }

  @Test fun `a paid introductory offer is chosen over the base plan`() {
    val intro = Offer("monthly", "intro", "tok-intro", listOf(Phase("₹99", 99_000_000L, "P1M", 3), monthlyPrice))
    assertEquals("tok-intro", OfferChoice.choose(listOf(monthlyBase, intro), "monthly")?.offerToken)
  }

  @Test fun `an unknown base plan has no offer`() {
    assertNull(OfferChoice.choose(listOf(monthlyBase, annualBase), "weekly"))
  }

  @Test fun `base plans are listed once each in Play's order`() {
    assertEquals(listOf("monthly", "annual"), OfferChoice.basePlanIds(listOf(monthlyBase, monthlyTrial, annualBase)))
  }

  @Test fun `a trial plan is priced at what is charged after the trial`() {
    val p = OfferChoice.describe(monthlyTrial)!!
    assertEquals("₹299", p.price)
    assertEquals(299_000_000L, p.priceMicros)
    assertEquals("P1M", p.period)
    assertNull(p.fullPrice)
    assertEquals("P1W", p.trialPeriod)
    assertEquals(1, p.trialCycles)
  }

  @Test fun `a plain base plan has no trial and no struck price`() {
    val p = OfferChoice.describe(annualBase)!!
    assertEquals("₹2,499", p.price)
    assertEquals("P1Y", p.period)
    assertNull(p.fullPrice)
    assertNull(p.trialPeriod)
    assertEquals(0, p.trialCycles)
  }

  @Test fun `a paid intro shows its price with the standing price struck`() {
    val intro = Offer("monthly", "intro", "tok-intro", listOf(Phase("₹99", 99_000_000L, "P1M", 3), monthlyPrice))
    val p = OfferChoice.describe(intro)!!
    assertEquals("₹99", p.price)
    assertEquals("₹299", p.fullPrice)
    assertNull(p.trialPeriod)
  }
}
```

Run (fails to compile — `OfferChoice` does not exist):
`cd android && ./gradlew :app:testDebugUnitTest --tests '*OfferChoiceTest' 2>&1 | grep -E "BUILD|FAILED|error:|e: " | tail -20`

**Code.** Create `android/app/src/main/java/com/innocorelabs/verbale/billing/OfferChoice.kt`:

```kotlin
package com.innocorelabs.verbale.billing

/**
 * Which Play offer a base plan is sold with, decided without the Billing Library in sight.
 *
 * Play returns one entry per OFFER, not per plan: the base plan itself (offerId null) and every
 * developer offer this Google account is eligible for — at launch, the seven-day free trial.
 * Reading that list as one entry per plan drew two Monthly rows, one of them priced "Free", and
 * sold whichever Play happened to list first.
 *
 * Plain data in and out so the rule runs on the JVM; ProductDetails cannot be built there.
 */
object OfferChoice {
  data class Phase(val formattedPrice: String, val priceMicros: Long, val billingPeriod: String, val cycles: Int)

  data class Offer(val basePlanId: String, val offerId: String?, val offerToken: String, val phases: List<Phase>)

  /** One base plan as the paywall is told it. Field names are the JS PlayPlan's. */
  data class Plan(
    val basePlanId: String,
    val price: String,
    val priceMicros: Long,
    val period: String,
    val fullPrice: String?,
    val trialPeriod: String?,
    val trialCycles: Int,
  )

  /** A free trial: a first phase that costs nothing, followed by one that does. */
  fun isFreeTrial(o: Offer): Boolean = o.phases.size > 1 && o.phases.first().priceMicros == 0L

  /** Base plan ids in the order Play listed them, once each. */
  fun basePlanIds(offers: List<Offer>): List<String> = offers.map { it.basePlanId }.distinct()

  /**
   * The offer to sell [basePlanId] with. Play lists a developer offer only to an account eligible
   * for it, so taking one is always allowed: a free trial first, then any other offer (a paid
   * introductory price), then the plain base plan.
   */
  fun choose(offers: List<Offer>, basePlanId: String): Offer? {
    val mine = offers.filter { it.basePlanId == basePlanId }
    return mine.firstOrNull(::isFreeTrial)
      ?: mine.firstOrNull { it.offerId != null }
      ?: mine.firstOrNull()
  }

  /**
   * What the paywall shows for one offer. `price` is the first amount actually charged — after a
   * free trial, the standing price. `fullPrice` is set only when that first charge is a discount
   * on the standing price: it is the one honest source for a struck-through price.
   */
  fun describe(o: Offer): Plan? {
    val standing = o.phases.lastOrNull() ?: return null
    val charged = o.phases.firstOrNull { it.priceMicros > 0L } ?: return null
    val trial = if (isFreeTrial(o)) o.phases.first() else null
    return Plan(
      basePlanId = o.basePlanId,
      price = charged.formattedPrice,
      priceMicros = charged.priceMicros,
      period = standing.billingPeriod,
      fullPrice = if (charged.priceMicros < standing.priceMicros) standing.formattedPrice else null,
      trialPeriod = trial?.billingPeriod,
      trialCycles = trial?.cycles ?: 0,
    )
  }
}
```

Run the same command → `BUILD SUCCESSFUL`, 8 tests. Read the count from
`android/app/build/test-results/testDebugUnitTest/TEST-com.innocorelabs.verbale.billing.OfferChoiceTest.xml`
(`grep -o 'tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*"' <file>` → `tests="8" skipped="0" failures="0"`).

**Mutant M1:** in `choose`, replace the whole return with `return mine.firstOrNull()`. The test
*a free trial is chosen over the base plan wherever Play lists it* must fail. Restore.
**Mutant M2:** in `describe`, change `charged.priceMicros < standing.priceMicros` to
`charged.priceMicros <= standing.priceMicros`. *a trial plan is priced…* and *a plain base plan…*
must fail. Restore. Green again.

Commit: `feat(billing): OfferChoice — sell a base plan with its free trial, one row per plan`.

#### Step 2. `BillingModule` uses `OfferChoice`

In `BillingModule.kt` (as committed in Step 0):

1. Add this private helper directly above `@ReactMethod fun plans(` (anchor: `grep -n "fun plans" BillingModule.kt`), after the doc comment's preceding blank line — i.e. place it before the `/**` that starts `plans()`'s doc:

```kotlin
  private fun offersOf(details: ProductDetails): List<OfferChoice.Offer> =
    details.subscriptionOfferDetails.orEmpty().map { o ->
      OfferChoice.Offer(
        basePlanId = o.basePlanId,
        offerId = o.offerId,
        offerToken = o.offerToken,
        phases = o.pricingPhases.pricingPhaseList.map { p ->
          OfferChoice.Phase(p.formattedPrice, p.priceAmountMicros, p.billingPeriod, p.billingCycleCount)
        },
      )
    }

```

2. Replace the body of `plans()` — from `productDetails({ promise.resolve(Arguments.createArray()) }) { details ->`
   through the matching `}` before the method's closing brace — with:

```kotlin
    productDetails({ promise.resolve(Arguments.createArray()) }) { details ->
      val offers = offersOf(details)
      val out = Arguments.createArray()
      // One row per BASE PLAN. Play lists the free trial as a second offer on the same plan;
      // OfferChoice picks the one this account will actually be sold.
      for (id in OfferChoice.basePlanIds(offers)) {
        val plan = OfferChoice.choose(offers, id)?.let(OfferChoice::describe) ?: continue
        out.pushMap(
          Arguments.createMap().apply {
            putString("basePlanId", plan.basePlanId)
            putString("price", plan.price)
            putDouble("priceMicros", plan.priceMicros.toDouble())
            putString("period", plan.period)
            putString("fullPrice", plan.fullPrice)
            putString("trialPeriod", plan.trialPeriod)
            putInt("trialCycles", plan.trialCycles)
            putString("title", details.title)
          },
        )
      }
      promise.resolve(out)
    }
```

3. In `plans()`'s doc comment, after the line `*   fullPrice     the price BEFORE an introductory or promotional phase, when Play reports`
   and its continuation line `*                 more than one phase — otherwise null`, add:

```kotlin
   *   trialPeriod   ISO-8601 length of Play's free trial for this account ("P1W"), or null when
   *                 there is none or the account has already had one
   *   trialCycles   how many trialPeriods the free trial lasts (1 for a one-week trial), 0 without
```

4. In `purchase()`, replace from `val offers = details.subscriptionOfferDetails.orEmpty()` through
   `val offerToken = offer.offerToken` with:

```kotlin
      val offers = offersOf(details)
      val ids = OfferChoice.basePlanIds(offers)
      // Named, not positional. With monthly AND annual, the first-listed plan could charge a year
      // up front for a tap on "monthly"; a caller that does not say which plan is refused. Within
      // the plan, OfferChoice sells the free trial when this account is eligible for one.
      val planId = basePlanId ?: ids.singleOrNull()
      val offer = planId?.let { OfferChoice.choose(offers, it) }
      if (offer == null) {
        promise.reject(
          "no_offer",
          if (basePlanId == null && ids.size > 1) {
            "This subscription has ${ids.size} base plans; say which one to buy."
          } else {
            "No base plan '" + (basePlanId ?: "") + "' is configured in Play Console. " +
              "Available: " + ids.joinToString(", ")
          },
        )
        return@productDetails
      }
      val offerToken = offer.offerToken
```

5. In `android/app/build.gradle` (line ≈254), change the fallback `'verbale_pro_monthly'` to
   `'verbale_pro'`. The comment in `gradle.properties` calls the old default a trap; this removes it.

Run: `cd android && ./gradlew :app:testDebugUnitTest 2>&1 | grep -E "BUILD|FAILED|error:|e: " | tail -20`
→ `BUILD SUCCESSFUL` (this compiles `BillingModule.kt` against Billing 8.3.0).

Commit: `fix(billing): one paywall row per base plan, and buy its free trial when eligible`.

#### Step 3. The in-app trial grants nothing in a release build

In `LicenceStore.kt`, replace

```kotlin
  fun entitled(ctx: Context): Boolean = current(ctx).isPaid || Trial.isActive(ctx)
```

with

```kotlin
  fun entitled(ctx: Context): Boolean =
    current(ctx).isPaid || (BuildConfig.DEBUG && Trial.isActive(ctx))
```

and append to that function's doc comment (before its closing `*/`):

```kotlin
   *
   * Since 23 Sep 2026 the trial customers get is Play's free-trial offer, which arrives as an
   * ordinary paid licence. The in-app trial below is a DEBUG-only lever: the device tests write
   * its three settings keys to get Pro without a purchase. A release build never reads it.
```

In `Trial.kt`, insert after the first paragraph of the class doc (after the line ending
`would grant a person nothing at all, and would never count what it had granted.`), a blank ` *`
line and:

```kotlin
 * **Retired as a product, 23 Sep 2026.** Customers now get Play's seven-day free trial, which the
 * licence server turns into an ordinary paid licence. Nothing in the app starts this trial any
 * more, and LicenceStore.entitled consults it only in a DEBUG build — where the device tests
 * (NativePipelineTest, PeopleDbTest, ThreadsDbTest, VerificationTrialTest) write its keys to get
 * Pro without a purchase.
```

`BuildConfig` is already imported in `LicenceStore.kt` (line 5). No JVM test can observe
`BuildConfig.DEBUG` (it is true in every unit-test run); the proof is Step 12's release-build
check. Run the Kotlin command from Step 2 → `BUILD SUCCESSFUL`.

Commit: `fix(billing): the in-app trial is a debug-only test lever, not a release entitlement`.

#### Step 4. Pro bought mid-recording lifts the cap on the recording already running

In `RecordingService.kt`, find the anchor `grep -n "free tier limit reached" RecordingService.kt`
(≈line 437). Replace the block

```kotlin
              if (capturedMs >= capMs) {
                Log.i(TAG, "free tier limit reached at ${capturedMs}ms — stopping and keeping it")
                endReason = END_CAP_REACHED
                recording = false
              }
```

with

```kotlin
              if (capturedMs >= capMs) {
                // The cap was read once, from the start intent. The cap card sells Play's trial
                // three minutes before this line; a purchase made there must lift the cap for the
                // recording ALREADY RUNNING, or "Keep recording" is a promise the service breaks.
                // Asked here, once, rather than every second: it is a database read and a
                // signature check.
                if (LicenceStore.entitled(this@RecordingService)) {
                  Log.i(TAG, "free tier limit reached at ${capturedMs}ms, but now entitled — cap lifted")
                  capMs = 0L
                } else {
                  Log.i(TAG, "free tier limit reached at ${capturedMs}ms — stopping and keeping it")
                  endReason = END_CAP_REACHED
                  recording = false
                }
              }
```

Add `import com.innocorelabs.verbale.billing.LicenceStore` in import order (after
`import com.innocorelabs.verbale.R`). `capMs` is already `@Volatile private var` (line ≈143), so
it is assignable. No JVM test reaches a running service; the proof is §7 step 5 on a phone.
Run the Kotlin command → `BUILD SUCCESSFUL`.

Commit: `fix(record): a purchase during the cap warning lifts the cap on the running recording`.

#### Step 5. Server: no grace on top of a cancelled subscription's token

**Test first.** In `server/tests/test_entitlement.py`, after
`test_a_token_never_outlives_the_paid_period_plus_grace`, add:

```python
def test_a_cancelled_subscription_mints_no_grace_past_its_end(store, signing_key):
    """A Play trial cancelled on day two ends with the trial, not three days after it."""
    account = _entitled_account(store, period_end=NOW + 5 * DAY, status="cancelled")
    issued = issue(store, signing_key, account.id, "dev_1", NOW)
    assert issued is not None
    assert issued.expires_at == NOW + 5 * DAY
    assert _exp(issued) == issued.expires_at
```

Run: `cd server && .venv/bin/python -m pytest -q tests/test_entitlement.py 2>&1 | tail -5` → 1 failed.

**Code.** In `server/app/entitlement.py`, replace

```python
    ceiling = sub.current_period_end + PAYMENT_GRACE_SECONDS
```

with

```python
    # The grace is for a payment that may still go through. A cancellation has none coming --
    # is_entitled already refuses it grace -- so its token ends with the period, and a Play trial
    # cancelled on day two ends with the trial.
    grace = PAYMENT_GRACE_SECONDS if sub.status in ("active", "past_due") else 0
    ceiling = sub.current_period_end + grace
```

Run the same command → all passed. Then the full server suite:
`cd server && .venv/bin/python -m pytest -q 2>&1 | tail -3` → `passed`, 0 failed.

**Mutant M3:** change the new line to `grace = PAYMENT_GRACE_SECONDS`. The new test must fail.
Restore.

Commit: `fix(server): a cancelled subscription's licence ends with its period, no grace on top`.

**End of Session A.** Update the progress file, commit, stop.

---

### Session B — TypeScript, screens, docs

#### Step 6. `PlayPlan` gains the trial; the pure trial helpers

1. `src/native/NativeBilling.ts`: in `interface PlayPlan`, after the `fullPrice` field, add:

```ts
  /** ISO 8601 length of Play's free trial for this account ("P1W"); null when none is offered. */
  trialPeriod: string | null;
  /** How many trialPeriods the trial lasts; 0 without a trial. */
  trialCycles: number;
```

2. `src/billing/__tests__/referencePrice.test.ts`: its `plan()` fixture builds a `PlayPlan`; add
   `trialPeriod: null, trialCycles: 0,` to the defaults object so it still type-checks.

3. **Test first.** Create `src/billing/__tests__/trialTerms.test.ts`:

```ts
import type { PlayPlan } from '../../native/NativeBilling';
import { trialLength, trialPlan, trialTerms } from '../trialTerms';

const plan = (o: Partial<PlayPlan>): PlayPlan => ({
  basePlanId: 'monthly',
  price: '₹299',
  priceMicros: 299e6,
  period: 'P1M',
  fullPrice: null,
  trialPeriod: null,
  trialCycles: 0,
  title: 'Verbale Pro',
  ...o,
});
const monthlyTrial = plan({ trialPeriod: 'P1W', trialCycles: 1 });
const annualTrial = plan({
  basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y',
  trialPeriod: 'P7D', trialCycles: 1,
});
const annual = plan({ basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y' });

describe('trialLength', () => {
  it('reads a week and seven days as the same seven days', () => {
    expect(trialLength(monthlyTrial)).toBe('7 days');
    expect(trialLength(plan({ trialPeriod: 'P7D', trialCycles: 1 }))).toBe('7 days');
  });
  it('multiplies by the cycle count', () => {
    expect(trialLength(plan({ trialPeriod: 'P1W', trialCycles: 2 }))).toBe('14 days');
    expect(trialLength(plan({ trialPeriod: 'P2W', trialCycles: 1 }))).toBe('14 days');
  });
  it('says one day and one month in the singular', () => {
    expect(trialLength(plan({ trialPeriod: 'P1D', trialCycles: 1 }))).toBe('1 day');
    expect(trialLength(plan({ trialPeriod: 'P1M', trialCycles: 1 }))).toBe('1 month');
  });
  it('is null with no trial or an unreadable period', () => {
    expect(trialLength(plan({}))).toBeNull();
    expect(trialLength(plan({ trialPeriod: 'garbage', trialCycles: 1 }))).toBeNull();
  });
});

describe('trialTerms', () => {
  it('states the length, the price after, how often, and how to avoid paying', () => {
    expect(trialTerms(monthlyTrial)).toBe(
      'Free for 7 days, then ₹299 a month until you cancel. Cancel in Google Play before the trial ends and you pay nothing.',
    );
    expect(trialTerms(annualTrial)).toBe(
      'Free for 7 days, then ₹2,499 a year until you cancel. Cancel in Google Play before the trial ends and you pay nothing.',
    );
  });
  it('never invents a period it cannot name', () => {
    expect(trialTerms({ ...monthlyTrial, period: 'P2M' })).toBe(
      'Free for 7 days, then ₹299 each billing period until you cancel. Cancel in Google Play before the trial ends and you pay nothing.',
    );
  });
  it('is null without a trial', () => {
    expect(trialTerms(annual)).toBeNull();
  });
});

describe('trialPlan', () => {
  it('prefers the asked-for period when both plans have a trial', () => {
    expect(trialPlan([monthlyTrial, annualTrial], 'P1Y')?.basePlanId).toBe('annual');
  });
  it('falls back to whichever plan has one', () => {
    expect(trialPlan([monthlyTrial, annual], 'P1Y')?.basePlanId).toBe('monthly');
  });
  it('is null when no plan has a trial', () => {
    expect(trialPlan([plan({}), annual], 'P1M')).toBeNull();
  });
});
```

Run: `npx jest src/billing/__tests__/trialTerms.test.ts --silent 2>&1 | tail -15` → fails (no module).

4. **Code.** Create `src/billing/trialTerms.ts`:

```ts
import type { PlayPlan } from '../native/NativeBilling';

/**
 * Play's free trial, in words.
 *
 * Pure and native-free on purpose, so every screen that mentions the trial can use it in tests
 * without mocking anything. The trial itself is Play's — an offer on each base plan, shown only
 * to an account that has never subscribed — and nothing here grants or checks it.
 *
 * Play's subscription policy asks for the length, the price after it, how often that price is
 * charged, and how to cancel, stated where the offer is made. `trialTerms` is that sentence.
 */

const UNIT: Record<string, [string, string, number]> = {
  D: ['day', 'days', 1],
  W: ['day', 'days', 7],
  M: ['month', 'months', 1],
  Y: ['year', 'years', 1],
};

/** "7 days" for a one-week trial; null when the plan has none or the period cannot be read. */
export function trialLength(plan: Pick<PlayPlan, 'trialPeriod' | 'trialCycles'>): string | null {
  const m = /^P(\d+)([DWMY])$/.exec(plan.trialPeriod ?? '');
  if (!m) return null;
  const [one, many, factor] = UNIT[m[2]];
  const n = Number(m[1]) * factor * Math.max(1, plan.trialCycles);
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

const EVERY: Record<string, string> = {
  P1W: 'a week',
  P1M: 'a month',
  P3M: 'every 3 months',
  P6M: 'every 6 months',
  P1Y: 'a year',
};

/** The terms sentence shown with every trial offer. Null when the plan has no trial. */
export function trialTerms(plan: PlayPlan): string | null {
  const length = trialLength(plan);
  if (!length || !plan.price) return null;
  const every = EVERY[plan.period ?? ''] ?? 'each billing period';
  return (
    `Free for ${length}, then ${plan.price} ${every} until you cancel. ` +
    'Cancel in Google Play before the trial ends and you pay nothing.'
  );
}

/** The plan to offer a trial on: `prefer`'s period if it has one, else any plan that does. */
export function trialPlan(plans: PlayPlan[], prefer: 'P1M' | 'P1Y'): PlayPlan | null {
  return (
    plans.find(p => trialLength(p) !== null && p.period === prefer) ??
    plans.find(p => trialLength(p) !== null) ??
    null
  );
}
```

Run the jest command → all pass. Then `npx tsc --noEmit 2>&1 | tail -15` → no output. (If `tsc`
names another file that builds a `PlayPlan` literal, add the same two fields there — that is a
type-driven fixup; record it under *Decisions*.)

**Mutant M4:** in `trialLength`, change `factor *` to `1 *`. *reads a week and seven days…* must
fail. Restore.

Commit: `feat(billing): PlayPlan carries Play's free trial; trialTerms says it in words`.

#### Step 7. Remove the in-app trial from `trial.ts`

Rewrite `src/billing/trial.ts` as follows (keep everything not named here byte-for-byte):

- **Replace the file's header comment** (the first `/** … */`, lines 4–21) with:

```ts
/**
 * What the screens may SAY about Pro, and when to offer it.
 *
 * The free trial is Play's (an offer on each base plan, see trialTerms.ts) and arrives as an
 * ordinary paid licence, so there is one question here: is there a licence. The in-app trial
 * that lived in this file until 23 Sep 2026 is gone from the product; its native half survives
 * in Trial.kt as a debug-only lever for the device tests.
 *
 * Enforcement is native and not here: Narrator, the model download and the Ask gate check a
 * signed licence a JS bundle cannot forge.
 */
```

- **Delete:** `TRIAL_DAYS`, `TRIAL_SUMMARIES`, `DAY_SECONDS`, the `KEY_STARTED`/`KEY_USED`/`KEY_ENDED`
  block with its doc comment, `TrialStatus`, `TrialEndReason`, `TrialState`, `UNSTARTED`,
  `shape`, `trialState`, `startTrial`, `noteTrialSummary`.
- **Keep:** the imports, `KEY_CLOCK_FLOOR` and `monotonicNow` (used by `markPaywallSeen`),
  `KEY_PAYWALL_SEEN`, the nudge keys, `int`, `markPaywallSeen`, everything from `NUDGE_EVERY` to
  the end of the file.
- **Replace** `Entitlement`, `entitlement` and `shouldOfferPaywall` (with their doc comments) by:

```ts
export interface Entitlement {
  /** May the paid features run: a Play subscription, including Play's free trial. */
  paid: boolean;
  licence: LicenceStatus | null;
}

/**
 * The one question every screen asks. Not enforcement — that is native — only what the UI may say.
 */
export async function entitlement(): Promise<Entitlement> {
  const licence = await Licence.status().catch(() => null);
  return { paid: Boolean(licence?.paid), licence };
}

/**
 * Whether this is the moment to offer Pro: once, off the first meeting that finished processing,
 * never to a subscriber, and never twice — the second showing is a nag, and this app's pitch is
 * that it does not behave like that.
 */
export async function shouldOfferPaywall(): Promise<boolean> {
  const seen = int(await db.getSetting(KEY_PAYWALL_SEEN).catch(() => null));
  if (seen > 0) return false;
  const { licence } = await entitlement();
  return !licence?.paid;
}
```

- In the `NudgeInput.entitlement` field comment, change `it is already true for a subscriber OR a
  running trial` to `it is already true for a subscriber, including one on Play's trial`.

**`src/billing/__tests__/trial.test.ts`:** remove `TRIAL_DAYS`, `TRIAL_SUMMARIES`,
`noteTrialSummary`, `startTrial`, `trialState` from the import; delete the whole
`describe('starting', …)`, `describe('the two limits', …)` and `describe('the clock', …)` blocks;
in `describe('the contextual offer', …)` delete the test `is not made to somebody who already
decided`. Replace the header comment's two sentences with `What the screens may say about Pro,
and when the contextual offer is made.` If `withNativeClock` or `systemNow` become unused, delete
them only if `tsc` or jest says so.

Run: `npx jest src/billing --silent 2>&1 | tail -15` → green. Then
`npx tsc --noEmit 2>&1 | tail -30` — it will list every screen still importing a deleted name
(`PaywallScreen`, `SummaryTab`, `RecordScreen`, `OnboardingScreen`, their tests). **Do not fix
them in this step**; they are Steps 8–10. Commit with the tree failing tsc only in those files:
`refactor(billing): entitlement is the licence; the in-app trial leaves trial.ts`.

#### Step 8. The paywall sells Play's trial

**Route.** `src/navigation/RootNavigator.tsx` line 55: `Paywall: { meetingId?: string } | undefined;`
→ `Paywall: { meetingId?: string; from?: 'onboarding' } | undefined;`

**Test first.** Replace `src/screens/__tests__/PaywallScreen.test.tsx` from the
`jest.mock('../../billing/trial', …)` block to the end of the file with:

```tsx
jest.mock('../../billing/trial', () => ({
  __esModule: true,
  entitlement: jest.fn(),
  markPaywallSeen: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../billing/subscription', () => ({
  __esModule: true,
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
  playPrice: jest.fn().mockResolvedValue(null),
  buyWithPlay: jest.fn(),
  referencePrice: jest.fn().mockReturnValue(null),
}));
jest.mock('../../native/NativeModelManager', () => ({
  __esModule: true,
  default: {
    list: jest.fn().mockResolvedValue('[]'),
    deviceFit: jest.fn().mockResolvedValue('{"freeBytes":100000000000}'),
    download: jest.fn(),
  },
}));
jest.mock('../../billing/SignInForm', () => () => null);

// Fake timers end the Pop entrance animations with the suite; see the other screen tests.
beforeEach(() => {
  jest.useFakeTimers();
  (entitlement as jest.Mock).mockResolvedValue({ paid: false, licence: null });
});
afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;

const plan = (o: Partial<PlayPlan>): PlayPlan => ({
  basePlanId: 'monthly', price: '₹299', priceMicros: 299e6, period: 'P1M',
  fullPrice: null, trialPeriod: null, trialCycles: 0, title: 'Verbale Pro', ...o,
});
const monthlyTrial = plan({ trialPeriod: 'P1W', trialCycles: 1 });
const annualTrial = plan({
  basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y',
  trialPeriod: 'P1W', trialCycles: 1,
});
const monthly = plan({});
const annual = plan({ basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y' });

async function render(params?: { from?: 'onboarding' }) {
  let tree!: renderer.ReactTestRenderer;
  const route = { key: 'paywall', name: 'Paywall', params } as any;
  await act(async () => {
    tree = renderer.create(<PaywallScreen navigation={nav} route={route} />);
  });
  await act(async () => {});
  return tree;
}

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root
    .findAll(n => typeof n.props.children === 'string')
    .map(n => n.props.children as string);

function sellsPlans(list: PlayPlan[]) {
  (playAvailable as jest.Mock).mockResolvedValue(true);
  (playPlans as jest.Mock).mockResolvedValue(list);
}

describe('PaywallScreen sells Play\'s free trial', () => {
  it('offers the trial on the preselected plan, with its terms', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    const tree = await render();
    expect(tree.root.findAllByProps({ label: 'Try it free for 7 days' }, { deep: false })).toHaveLength(1);
    expect(texts(tree)).toContain(
      'Free for 7 days, then ₹2,499 a year until you cancel. Cancel in Google Play before the trial ends and you pay nothing.',
    );
  });

  it('states the price when Play offers this account no trial', async () => {
    sellsPlans([monthly, annual]);
    const tree = await render();
    expect(tree.root.findAllByProps({ label: 'Subscribe — ₹2,499' }, { deep: false })).toHaveLength(1);
    expect(texts(tree).some(t => t.startsWith('Free for'))).toBe(false);
  });

  it('never offers the old in-app trial', async () => {
    const tree = await render();
    expect(tree.root.findAllByProps({ label: 'Try Pro free for 7 days' }, { deep: false })).toHaveLength(0);
  });

  it('buys the chosen base plan and says the trial started', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    (buyWithPlay as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render();
    await act(async () => {
      tree.root.findByProps({ label: 'Try it free for 7 days' }).props.onPress();
    });
    expect(buyWithPlay).toHaveBeenCalledWith('annual');
    expect(alert.mock.calls[0][0]).toBe('Your free trial has started');
  });

  it('from first run, a purchase goes straight back to setup', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    (buyWithPlay as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render({ from: 'onboarding' });
    await act(async () => {
      tree.root.findByProps({ label: 'Try it free for 7 days' }).props.onPress();
    });
    expect(nav.goBack).toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});
```

and change the file's imports at the top to:

```tsx
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import PaywallScreen from '../PaywallScreen';
import { entitlement } from '../../billing/trial';
import { buyWithPlay, playAvailable, playPlans } from '../../billing/subscription';
import type { PlayPlan } from '../../native/NativeBilling';
```

(the `ScrollView` import and the old `nav`/`route`/`render` definitions go; the
`react-native-safe-area-context` mock stays). Run:
`npx jest src/screens/__tests__/PaywallScreen.test.tsx --silent 2>&1 | tail -20` → fails.

**Code — `src/screens/PaywallScreen.tsx`:**

8.1 Imports (lines 20–27): the `../billing/trial` import becomes
`import { entitlement, markPaywallSeen, type Entitlement } from '../billing/trial';` and add
`import { trialLength, trialTerms } from '../billing/trialTerms';` after the
`../billing/subscription` import.

8.2 `export default function PaywallScreen({ navigation }: Props)` →
`export default function PaywallScreen({ navigation, route }: Props)`.

8.3 `const [busy, setBusy] = useState<'trial' | 'buy' | null>(null);` →
`const [busy, setBusy] = useState<'buy' | null>(null);`

8.4 Replace `onStartTrial` — from its doc comment `/**\n   * Start the trial, then fetch the model it is a trial of.` through the end of its `useCallback(…, [load]);` — with:

```tsx
  /**
   * Fetch the writer the subscription pays for, straight after the purchase.
   *
   * Not silent and not in the background: it is over a gigabyte, and somebody who has just
   * started a trial and watches nothing happen for ten minutes on hotel wifi has been lied to. A
   * failure is said plainly and costs nothing — Settings fetches it later.
   */
  const fetchWriter = useCallback(async () => {
    try {
      scroller.current?.scrollTo({ y: 0, animated: true });
      const list: { id: string; kind: string; installed: boolean; unsupportedReason?: string | null }[] = JSON.parse(
        await ModelManager.list(),
      );
      const missing = runnable(list).filter(m => m.kind === 'llm' && !m.installed);
      for (const m of missing) {
        setDl({ downloaded: 0, total: 0 });
        await ModelManager.download(m.id);
      }
      setWriterInstalled(true);
    } catch (e: any) {
      Alert.alert(
        'The writer could not be downloaded',
        `${String(e?.message ?? e)}\n\nPro is on and nothing has been lost. You can fetch the ` +
          'model from Settings once you are on a better connection.',
      );
    } finally {
      setDl(null);
    }
  }, []);
```

8.5 Replace `onBuy` (the whole `const onBuy = useCallback(…);`) with:

```tsx
  const onBuy = useCallback(async () => {
    setBusy('buy');
    try {
      const plan = plans.find(p => p.basePlanId === chosenPlan) ?? null;
      const result = await buyWithPlay(chosenPlan);
      if (result.paid) {
        await load();
        // From first run: straight back to setup, whose Download button fetches the writer along
        // with everything else. A second download started here would race it.
        if (route.params?.from === 'onboarding') {
          navigation.goBack();
          return;
        }
        const free = plan ? trialLength(plan) : null;
        Alert.alert(
          free ? 'Your free trial has started' : 'You are on Pro',
          free
            ? `Pro is on, free for ${free}. Cancel in Google Play before then and you pay nothing.`
            : 'The written summary and the narrated minutes are on.',
        );
        await fetchWriter();
      }
      // Not paid means the buyer backed out or the payment is still authorising. Neither is a
      // failure, and neither earns a dialog.
    } catch (e: any) {
      Alert.alert('Could not complete the purchase', String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [chosenPlan, plans, load, fetchWriter, navigation, route.params]);
```

8.6 Replace from `const trial = ent?.trial;` through
`const priceLabel = playCost ? \`Subscribe — ${playCost}\` : 'Subscribe';` with:

```tsx
  const bought = Boolean(ent?.licence?.paid);
  const chosen = plans.find(p => p.basePlanId === chosenPlan) ?? null;
  // Play shows its trial only to an account that has never subscribed, so its presence on the
  // chosen plan is the whole eligibility check.
  const chosenFree = chosen ? trialLength(chosen) : null;
  const terms = chosen ? trialTerms(chosen) : null;

  /** The one line under the title, which is the only line most people will read. */
  const headline = bought
    ? 'You are on Pro. Everything below is already on.'
    : 'Let the phone write your minutes for you, in sentences, before you decide.';

  const priceLabel = chosenFree
    ? `Try it free for ${chosenFree}`
    : playCost
      ? `Subscribe — ${playCost}`
      : 'Subscribe';
```

8.7 Mascot: `mood={bought || trial?.status === 'active' ? 'happy' : 'idle'}` → `mood={bought ? 'happy' : 'idle'}`.

8.8 In the CTA block: delete the whole `{trial?.status === 'unstarted' ? ( <> <Button … Try Pro free …/> … </> ) : null}`
(from the line `{trial?.status === 'unstarted' ? (` at ≈388 to its closing `) : null}` at ≈411).

8.9 In each plan row, after the `<Txt variant="body" color={colors.ink}>{pl.price ?? '—'}</Txt>`
element, add:

```tsx
                            {trialLength(pl) ? (
                              <Txt variant="chip" color={colors.primary}>
                                {trialLength(pl)} free
                              </Txt>
                            ) : null}
```

8.10 Replace the buy-button wrapper — from
`<View style={trial?.status === 'unstarted' ? st.secondary : undefined}>` through its closing
`</View>` — with:

```tsx
                  <Button
                    label={busy === 'buy' ? 'One moment…' : priceLabel}
                    icon="check"
                    onPress={onBuy}
                    disabled={busy !== null}
                    full
                  />
                  {terms ? (
                    <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                      {terms}
                    </Txt>
                  ) : null}
                  {!bought && !writerInstalled && writerMb > 0 ? (
                    <Txt variant="chip" color={colors.inkFaint} style={st.note}>
                      Pro downloads a {writerMb} MB model once you start, so start on wifi.
                    </Txt>
                  ) : null}
                  {spaceShort ? (
                    <Txt variant="chip" color={colors.warning} style={st.note}>
                      {spaceShort}
                    </Txt>
                  ) : null}
```

and delete the now-unused `secondary: { flexDirection: 'row' },` style (≈line 581).

8.11 Delete the `{trial?.status === 'ended' ? ( … Nothing was taken away when the trial ended … ) : null}` block (≈513–518).

8.12 Header doc (≈lines 46–49): replace
`processing, and it offers the trial before it offers the price: seven days and three summaries`
`is a cheaper thing to ask for than a card, and it is the only honest way to answer "is it any`
`good on MY meetings", which is the only question that matters here.` with
`processing, and it leads with Play's free trial — seven days, then the price, cancellable in Play`
`— because it is the only honest way to answer "is it any good on MY meetings", which is the only`
`question that matters here.` And at ≈line 65, `before the trial or the price.` →
`before the trial and the price.`

Run the Paywall jest command → 5 passed. `npx tsc --noEmit 2>&1 | grep PaywallScreen | tail -10` → nothing.

**Mutant M5:** in 8.6 change `priceLabel` to always the `playCost` branch (delete the
`chosenFree ?` arm). *offers the trial on the preselected plan…* must fail. Restore.
**Mutant M6:** delete the `if (route.params?.from === 'onboarding') {…}` block. *from first run…*
must fail. Restore. Green again.

Commit: `feat(paywall): sell Play's free trial with its terms; the in-app trial button goes`.

#### Step 9. The Summary tab offers Play's trial

`src/screens/meeting/SummaryTab.tsx`:

9.1 Line 13 `import { TRIAL_DAYS, entitlement } from '../../billing/trial';` →
`import { entitlement } from '../../billing/trial';` and add below it:

```tsx
import { playAvailable, playPlans } from '../../billing/subscription';
import { trialLength, trialPlan } from '../../billing/trialTerms';
```

9.2 Replace the comment + state at ≈186–189 (`// Whether the free trial is still there to be offered…` … `const [trialOffer, setTrialOffer] = React.useState(false);`) with:

```tsx
  // Play's free trial, when this account can still have one: "7 days", or null. Play lists the
  // trial only to an account that never subscribed, so a spent trial is simply absent (A07, 22 Sep).
  const [trialFree, setTrialFree] = React.useState<string | null>(null);
```

9.3 Replace

```tsx
        setPaid(ent.paid);
        setTrialOffer(ent.trial?.status === 'unstarted');
        if (!ent.paid) {
          setReason('locked');
          return;
        }
```

with

```tsx
        setPaid(ent.paid);
        if (!ent.paid) {
          setReason('locked');
          if (await playAvailable()) {
            const t = trialPlan(await playPlans(), 'P1Y');
            if (alive) setTrialFree(t ? trialLength(t) : null);
          }
          return;
        }
```

9.4 `label={trialOffer ? \`Try it free for ${TRIAL_DAYS} days\` : 'Get Pro'}` →
`label={trialFree ? \`Try it free for ${trialFree}\` : 'Get Pro'}`

**Tests** — `src/screens/meeting/__tests__/SummaryTab.test.tsx`:
- The `jest.mock('../../../billing/trial', …)` factory loses `TRIAL_DAYS: 7,`. Below it add:

```tsx
jest.mock('../../../billing/subscription', () => ({
  __esModule: true,
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
}));
```

  and add `import { playAvailable, playPlans } from '../../../billing/subscription';` with the
  other imports at ≈29–32.
- Replace `describe('the trial offer on the card (Step 5)', …)` with:

```tsx
describe('Play\'s trial on the card', () => {
  const annualTrial = {
    basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y',
    fullPrice: null, trialPeriod: 'P1W', trialCycles: 1, title: null,
  };

  test('offers the trial when Play has one for this account', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false, licence: null });
    (playAvailable as jest.Mock).mockResolvedValue(true);
    (playPlans as jest.Mock).mockResolvedValue([annualTrial]);
    const tree = await renderTab({ minutes: [] });
    await act(async () => {});
    expect(
      tree.root.findAllByProps({ label: 'Try it free for 7 days' }, { deep: false }),
    ).toHaveLength(1);
  });

  test('says Get Pro when Play offers no trial', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false, licence: null });
    (playAvailable as jest.Mock).mockResolvedValue(true);
    (playPlans as jest.Mock).mockResolvedValue([]);
    const tree = await renderTab({ minutes: [] });
    await act(async () => {});
    expect(tree.root.findAllByProps({ label: 'Get Pro' }, { deep: false })).toHaveLength(1);
    const t = tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string);
    expect(t.some(s => s.includes('Try it free'))).toBe(false);
  });
});
```

Run: `npx jest src/screens/meeting --silent 2>&1 | tail -15` → green.
**Mutant M7:** make the label always `'Get Pro'`. *offers the trial…* must fail. Restore.

Commit: `feat(summary): the locked card offers Play's trial when this account can have one`.

#### Step 10. Record screen and onboarding

No jest harness exists for either screen; `tsc` and §7 (steps 5, 6) are their proof.

**`src/screens/RecordScreen.tsx`:**

10.1 Add `Alert,` as the first name in the `react-native` import (lines 2–12, alphabetical).
Line 37 `import { entitlement, startTrial } from '../billing/trial';` →
`import { entitlement } from '../billing/trial';` and add below it:

```tsx
import { buyWithPlay, playAvailable, playPlans } from '../billing/subscription';
import { trialLength, trialPlan, trialTerms } from '../billing/trialTerms';
import type { PlayPlan } from '../native/NativeBilling';
```

10.2 After `const [lifting, setLifting] = useState(false);` (≈96) add:

```tsx
  // The plan the cap card can sell in place — monthly first, the smaller commitment for a decision
  // made mid-meeting. Null when this install cannot buy through Play or the account has had its
  // trial. RecordingService re-asks for the entitlement when the limit is reached, so a purchase
  // here lifts the cap on the recording already running.
  const [trialOffer, setTrialOffer] = useState<PlayPlan | null>(null);
  useEffect(() => {
    let alive = true;
    playAvailable()
      .then(can => (can ? playPlans() : []))
      .then(pl => {
        if (alive) setTrialOffer(trialPlan(pl, 'P1M'));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
```

10.3 In the cap card (≈422–452) replace the comment above it with:

```tsx
          {/* The offer arrives with three minutes left, not at the limit: enough to read this,
              decide, and carry on without breaking stride. A purchase here lifts the cap for the
              recording ALREADY RUNNING — RecordingService asks for the entitlement again when the
              limit is reached, rather than trusting the cap it started with. */}
```

and replace the inner `<Txt variant="chip" color={colors.inkDim}>…</Txt>` plus the whole
`<SoftButton … />` with:

```tsx
                <Txt variant="chip" color={colors.inkDim}>
                  {trialOffer
                    ? `This recording will stop at 15 minutes and be transcribed in full. Pro has no limit. ${trialTerms(trialOffer)}`
                    : 'This recording will stop at 15 minutes and be transcribed in full.'}
                </Txt>
                {trialOffer ? (
                  <SoftButton
                    icon="check"
                    label={lifting ? 'One moment…' : `Keep recording — ${trialLength(trialOffer)} free`}
                    disabled={lifting}
                    onPress={async () => {
                      setLifting(true);
                      try {
                        const result = await buyWithPlay(trialOffer.basePlanId);
                        if (result.paid) {
                          const e = await entitlement();
                          setCapMs(capMsFor(Boolean(e?.paid)));
                        }
                      } catch (err: any) {
                        // The recording is untouched either way: it still stops cleanly at the
                        // limit and is kept. Only the purchase failed, so say why.
                        Alert.alert('Could not start the trial', String(err?.message ?? err));
                      } finally {
                        setLifting(false);
                      }
                    }}
                  />
                ) : null}
```

**`src/screens/OnboardingScreen.tsx`:**

10.4 Line 16 `import { TRIAL_DAYS, startTrial } from '../billing/trial';` → delete, and add:

```tsx
import { playAvailable, playPlans } from '../billing/subscription';
import { trialLength, trialPlan } from '../billing/trialTerms';
```

10.5 After `const [crashOptIn, setCrashOptIn] = useState(false);` (≈121) add:

```tsx
  // Whether Pro can be bought on this install, and Play's trial length if this account has one.
  const [proOffer, setProOffer] = useState<{ canBuy: boolean; free: string | null }>({
    canBuy: false,
    free: null,
  });
  useEffect(() => {
    playAvailable()
      .then(async can => {
        if (!can) return;
        const pl = await playPlans();
        const t = trialPlan(pl, 'P1Y');
        setProOffer({ canBuy: pl.length > 0, free: t ? trialLength(t) : null });
      })
      .catch(() => {});
  }, []);

  // Back from the Pro screen: a purchase made there is read here and setup carries on as Pro —
  // the Download button then fetches the writer with everything else.
  useEffect(
    () =>
      navigation.addListener('focus', () => {
        Licence.status()
          .then(e => {
            if (!e.paid) return;
            setPaid(true);
            setTier('pro');
            setWantWriter(true);
          })
          .catch(() => {});
      }),
    [navigation],
  );
```

10.6 Replace `choosePro` and its doc comment (≈185–204) with:

```tsx
  /**
   * Taking Pro at setup opens the Pro screen, where Play's free trial is offered with its terms —
   * the terms belong where the purchase is made. Coming back paid is picked up by the focus
   * listener above; coming back without buying leaves the choice where it was.
   */
  const choosePro = () => navigation.navigate('Paywall', { from: 'onboarding' });
```

10.7 Replace

```tsx
          <View style={st.tierGap}>
            <SoftButton label={`Try Pro free for ${TRIAL_DAYS} days`} icon="ai" onPress={choosePro} />
          </View>
```

with

```tsx
          {proOffer.canBuy ? (
            <View style={st.tierGap}>
              <SoftButton
                label={proOffer.free ? `Try Pro free for ${proOffer.free}` : 'Get Pro'}
                icon="ai"
                onPress={choosePro}
              />
            </View>
          ) : null}
```

10.8 The comment at ≈166 `/** Entitled to the paid models, either already or by the trial just started. */` →
`/** Entitled to the paid models: already, or by a purchase just made on the Pro screen. */`

Run: `npx tsc --noEmit 2>&1 | tail -15` → **no output** (every Step 7 error is now gone). Then
`npx jest --silent 2>&1 | tail -15` → all suites pass.

Commit: `feat(record,onboarding): Play's trial from the cap card and from first run`.

#### Step 11. Docs

In `docs/play-console.md`:

11.1 Replace the table under `### Product to create in Play Console` with:

```markdown
| | |
|---|---|
| Type | Subscription |
| Product ID | `verbale_pro` — must match `playSubscriptionId` in `android/gradle.properties` exactly |
| Base plan `monthly` | Auto-renewing, 1 month. ₹299 in India, $4.99 in the United States |
| Base plan `annual` | Auto-renewing, 1 year. ₹2,499 in India, $39.99 in the United States |
| Offer `free-trial-7d` on EACH base plan | Free trial, 1 week. Eligibility: *New customer acquisition → Never had any subscription* — one trial per Google account, across both plans |
| Other markets | Let Play convert from USD unless a market needs a hand-set figure |
```

and after that table's following paragraph add:

```markdown
The app never names an offer id: `OfferChoice` sells a base plan's free-trial offer whenever Play
lists one for the account (Play lists it only to an eligible account), otherwise the plain base
plan. So renaming or re-creating the offer needs no release — but a trial on only ONE plan means
the paywall's preselected Yearly shows no trial.

The two products created on 23 Sep 2026 (`verbale_pro_1m`, `verbale_pro_12m`) were the wrong
shape — two subscriptions instead of one with two base plans — and are deactivated. Product ids
can never be reused, which does not matter: nothing references them.
```

11.2 In the service-account list, replace step 3 (`3. Put the JSON (or its path) in …`) with:

```markdown
3. Put the key on the VPS **inline**, in `/opt/verbale/.env`, as ONE line in single quotes (a
   path does not work: the container mounts only its database volume, and `deploy.sh` rsyncs
   `/opt/verbale` with `--delete`, which would erase a key file kept there):
   `python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1]))))' key.json`
   → paste as `PLAY_SERVICE_ACCOUNT_JSON='<that line>'`. Then
   `cd /opt/verbale && docker compose up -d` — **not** `restart`, which keeps the old
   environment. Check the probe below no longer says 503. A new service account can take up to
   a day before Google honours its Play Console permissions; a 401 in that window is expected.
```

11.3 Replace the section `### The free trial needs nothing from the Console` (heading and its
paragraph) with:

```markdown
### The free trial is Play's

Seven days free, then the plan's price, set as the `free-trial-7d` offer on each base plan (see
above). Play charges nothing until the trial ends, reminds the buyer, and handles cancellation;
Google reports a trialling subscription as `SUBSCRIPTION_STATE_ACTIVE`, so the server mints an
ordinary licence whose expiry is the trial's end (plus the payment grace while it is still set
to renew — none once cancelled). The paywall states the terms under the button, as Play's
subscription policy asks.

The in-app "7 days or 3 summaries, no card" trial was removed on 23 Sep 2026. Its native half,
`Trial.kt`, survives as a DEBUG-only entitlement lever for the device tests; a release build
never reads it. **Testing Pro on a release build therefore needs a licence tester** (Play Console
→ Settings → License testing) on a build installed from a Play testing track — test trials last
minutes, not days — or a seeded account (`server/deploy/seed-test-account.sh`).
```

11.4 In the `## Still to do before filing` list, replace
`- [ ] Create the \`verbale_pro\` subscription with base plans \`monthly\` and \`annual\` at the prices above` with
`- [ ] Create the \`verbale_pro\` subscription: base plans \`monthly\` and \`annual\` at the prices above, and the \`free-trial-7d\` offer on each`.

Commit: `docs(play-console): one subscription, Play's free trial, and the service account that works`.

#### Step 12. The gate, the release check, then the report

1. `scripts/gate.sh 2>&1 | grep -E "==>|ok |FAILED|gate:" | tail -20` — every stage `ok` except
   `device` if it needs a phone (record it as not run). Kotlin results can be cached: force them with
   `cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks 2>&1 | grep -E "BUILD|FAILED" | tail -5`.
2. Release compile (R8 is newly on; this proves the release variant still builds and minifies):
   `cd android && ./gradlew :app:assembleRelease 2>&1 | grep -E "BUILD|FAILED|error:|R8|Missing class" | tail -20`
   → `BUILD SUCCESSFUL`. Do not install it.
3. `git diff --stat 5d10b55..HEAD` — may name only: the four Step 0 files, this sheet, the
   progress file, the report, and the files named in Steps 1–11 (plus any type-driven `PlayPlan`
   fixup recorded under *Decisions*).
4. Write the report (§8), delete the progress file (its content is in the report), commit:
   `docs(report): Play trial and billing — built, gate clear, by-hand steps for the founder`.

---

## 4. Expected interfaces after this sheet

- Kotlin `OfferChoice.choose(offers, basePlanId): Offer?`, `OfferChoice.describe(offer): Plan?`,
  `OfferChoice.basePlanIds(offers): List<String>`.
- `Billing.plans()` rows: `{ basePlanId, price, priceMicros, period, fullPrice, trialPeriod, trialCycles, title }` — one per base plan.
- `LicenceStore.entitled(ctx)` = paid licence, or (DEBUG only) the in-app trial.
- TS `PlayPlan` += `trialPeriod: string | null; trialCycles: number`.
- `src/billing/trialTerms.ts`: `trialLength(plan)`, `trialTerms(plan)`, `trialPlan(plans, prefer)`.
- `src/billing/trial.ts`: `Entitlement = { paid; licence }`; `entitlement()`, `shouldOfferPaywall()`,
  `markPaywallSeen()`, the nudge functions, `PRO_MODEL_IDS`, `isProModel`. No `TRIAL_*`, no `startTrial`.
- Route `Paywall: { meetingId?: string; from?: 'onboarding' } | undefined`.

## 5. Tests and commands

| Command | Must print |
|---|---|
| `cd android && ./gradlew :app:testDebugUnitTest --tests '*OfferChoiceTest' 2>&1 \| grep -E "BUILD\|FAILED" \| tail -5` | `BUILD SUCCESSFUL`; XML `tests="8" … failures="0"` |
| `cd server && .venv/bin/python -m pytest -q 2>&1 \| tail -3` | `passed`, no `failed` |
| `npx jest src/billing --silent 2>&1 \| tail -15` | all passed |
| `npx jest src/screens/__tests__/PaywallScreen.test.tsx --silent 2>&1 \| tail -15` | 5 passed |
| `npx jest src/screens/meeting --silent 2>&1 \| tail -15` | all passed |
| `npx tsc --noEmit 2>&1 \| tail -15` | nothing |
| `scripts/gate.sh 2>&1 \| grep -E "==>\|ok \|FAILED\|gate:" \| tail -20` | every stage `ok` (device: not run is allowed) |
| `cd android && ./gradlew :app:assembleRelease 2>&1 \| grep -E "BUILD\|FAILED\|error:" \| tail -10` | `BUILD SUCCESSFUL` |

Mutants: M1, M2 (Step 1), M3 (Step 5), M4 (Step 6), M5, M6 (Step 8), M7 (Step 9) — each must
make its named test fail, then be restored.

## 6. Acceptance criteria

- Everything in §5 prints what it must; all seven mutants killed and recorded.
- `git grep -n -E "TRIAL_DAYS|TRIAL_SUMMARIES|startTrial|noteTrialSummary|trialState" -- src` → no output.
- `git grep -n "No card, nothing to cancel\|no account, no card" -- src` → no output.
- `git diff --stat 5d10b55..HEAD` as in Step 12.3. `git status` clean.

## 7. Stop conditions

- A step needs a change in a §2 file: stop, write what and why in the progress file, commit, report.
- Two unsuccessful fixes of the same failing test or compile error: stop, record the error and
  both attempts, commit, report.
- A gate stage fails in a file this session did not touch: do not investigate; record the last
  20 lines, commit, report.
- `assembleRelease` fails in R8 (`Missing class`, a keep-rule error): record the last 20 lines
  and stop — R8 is the founder's Step 0 change and is not this sheet's to tune.
- At 150 steps: finish the current step, commit, update the progress file, stop.

## 8. The report contract

`docs/superpowers/reports/2026-09-23-play-trial-and-billing.md`:

1. **Status** in one line.
2. **What was built**, per step, with commit hashes.
3. **Decisions** taken, each with its cause (including type-driven fixups).
4. **Tests**: a table — name, result, mutant, mutant result.
5. **Gate summary** (stage → ok / not run) and the `assembleRelease` result.
6. **Device**: "not run — founder's by-hand session" (no builder session has a device).
7. **By hand, for the founder** — copy this list verbatim, it needs the Play product, the service
   account and a licence tester:
   1. Probe: `curl -s -X POST https://verbale.innocorelabs.com/api/billing/play/link -H 'content-type: application/json' -d '{"purchaseToken":"probe","deviceId":"probe"}'` — must NOT say "not configured".
   2. Install the release build from the **internal testing** track, signed in as a licence tester
      who has never subscribed. Open Pro. Expect two rows: **Monthly ₹299 · 7 days free** and
      **Yearly ₹2,499 · 7 days free** with ~~₹3,588~~ save 30%; Yearly preselected; button
      **Try it free for 7 days**; under it *Free for 7 days, then ₹2,499 a year until you cancel.
      Cancel in Google Play before the trial ends and you pay nothing.*
   3. Tap it. Play's sheet must say the trial and the price after it. Confirm. Expect the alert
      **Your free trial has started**, then the writer download with its byte counter. Settings
      shows Pro. (Test trials last minutes: Play then renews it as a test charge.)
   4. Reopen Pro: headline *You are on Pro*. In Play → Subscriptions, Verbale shows the trial.
   5. **Cap lift** (a second, never-subscribed tester, or the first after its test subscription
      has lapsed): record past 12:00 → the card reads *…Pro has no limit. Free for 7 days, then
      ₹299 a month…* with **Keep recording — 7 days free**. Tap, buy. The recording must run
      **past 15:00** and keep going. `adb logcat -d | grep "cap lifted" | tail -2` shows the line.
   6. **First run**: `pm clear` → onboarding shows **Try Pro free for 7 days** (an account that
      has had a trial sees **Get Pro** — correct). Tap → Pro screen → buy → it returns to setup
      by itself, now as Pro, and the Download button includes the writer.
   7. **Summary card** on an unpaid account with a trial left: **Try it free for 7 days**; with
      none left: **Get Pro**.
   8. Cancel the test subscription in Play. After the next licence refresh Pro ends at the
      trial's end with no extra three days.
8. **Known gaps** (at least: Onboarding and Record screens have no jest harness — proof is §7
   steps 5–6; the in-app trial's native half remains as a debug lever).
9. **Commits**: `git log --oneline 5d10b55..HEAD`.

If something was not run, say so — never mark it done.

## 9. The prompts that start each session

Session A:

> Read `docs/superpowers/specs/2026-09-23-play-trial-and-billing-execution.md` and execute
> Session A exactly as written: Steps 0–5, under its token rules. Stop after committing Step 5
> and the progress file, when a stop condition is met, or at 150 steps. Do not push.

Session B:

> Read `docs/superpowers/specs/2026-09-23-play-trial-and-billing-execution.md` and then
> `docs/superpowers/reports/play-trial-progress.md`. Execute Session B exactly as written:
> Steps 6–12, under its token rules. Stop when the report is committed, when a stop condition is
> met, or at 150 steps. Do not push.

## 10. What is deliberately NOT in this sheet

- The Play Console product, the offer, deactivating the old products, the licence testers, the
  Google Cloud service account and putting its key on the VPS — the founder's (see the handover).
- Deploying the server change (Step 5): the founder runs
  `VERBALE_HOST=root@69.62.82.85 server/deploy/deploy.sh` after Session A.
- Real-time developer notifications (Pub/Sub). Refresh-on-open re-asks Google; that is enough
  at launch.
- Renaming `src/billing/trial.ts` to match what is left in it — a churn-only change for after
  the AAB.
- Deleting `Trial.kt` and moving the device tests to another lever — after launch.
