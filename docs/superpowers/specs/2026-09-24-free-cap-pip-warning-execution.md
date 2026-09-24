# The free limit is visible in picture-in-picture and in the notification — execution sheet

*24 September 2026, against `1ce60ab`. For the session that builds it. Every file, anchor, string
and expected value below was grepped or computed by running it today. Do not design anything:
where this sheet names copy, a colour, a threshold or a rule, it is the decided answer.*

**What the founder decided (not open for change):**

- A FREE recording shows its limit in the picture-in-picture window from the first second:
  `04:12 / 15:00`. In the last 3 minutes it becomes a countdown, `2:48 left on Free`, in amber; in
  the last minute it turns red and the dot pulses. A Pro recording (no limit) looks exactly as
  today: `04:12`.
- From 3 minutes before the limit, the recording notification counts down to it (the system's own
  chronometer, counting down) and says **Stops at the 15-minute Free limit — tap to keep recording
  with Pro**. Tapping it opens the app, whose record screen already carries the trial card.
- If the limit is reached, a separate notification says **Stopped at the 15-minute Free limit**
  so a stop with the screen off is never a mystery.
- A purchase during the last 3 minutes lifts the limit on the running recording within about half
  a minute (today it is lifted only at the limit itself), so the countdown disappears soon after
  buying rather than running to 15:00.

**Why this is native only.** The PiP window is a native view (`PipContentView`) — React Native
cannot render there — and the notification belongs to `RecordingService`. Buying still happens in
the app (Play's sheet cannot open in PiP); these surfaces warn and bring the user back.

**One session, no device.** Steps 1–6. The founder checks it on a phone from the report's §7.

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. Never print a file over 200
  lines; `grep -n` to locate, then `sed -n 'A,Bp'` for at most 60 lines. `RecordingService.kt` is
  879 lines and `CaptureController.kt` 468: only the ranges named. Every command ends in its
  filter — run it exactly as written. Do not re-read a file after editing it. Do not paste code
  into your messages; commit it and name the file.
- **TDD + mutant.** Test first, watch it fail, write the code, watch it pass, apply the **named
  mutant**, watch the test fail, restore, green again. Record each mutant in the report as it
  happens. Never run a mutation-restore in the background.
- **Commit after each step**, subject in the house style (`git log --oneline -6`). **Never push.**
  **Never run `connectedDebugAndroidTest` or any `adb` command** in this session. **`git status`
  must be clean before you stop.**
- **Indent like the surrounding file**: two spaces in Kotlin; XML as its neighbours.
- **Hand-over at 150 steps**: finish the step you are on, commit, write what is left at the top of
  the report under *Not done*, stop.

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/RecordingService.kt` | 40–62, 136–148, 236–250, 425–455, 585–630, 695–705, 750–830 | Steps 3, 4, 5 |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/CaptureController.kt` | 95–102, 338–366 | Step 2 |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/PipContentView.kt` | 25–100, 190–212 | Step 6 |
| `android/app/src/main/res/values/strings.xml` | 9–45 | Steps 4, 5 |
| `android/app/src/test/java/com/innocorelabs/verbale/pipeline/CaptureWarningsTest.kt` | 1–25 | Step 1: the JVM test idiom |
| `src/billing/recordingCap.ts` | 20–55 | Read only: `WARN_BEFORE_MS` (3 min), which `CapClock` mirrors |

**Interfaces you use without reading their files:** `LicenceStore.entitled(ctx: Context): Boolean`
(`com.innocorelabs.verbale.billing`, already imported in `RecordingService.kt`);
`CaptureController.elapsedMs(): Long`, `CaptureController.capturedMs`, `CaptureController.isRecording`,
`CaptureController.paused`.

## 2. Files that must not change

- Everything under `src/` (TypeScript). The record screen's cap card is already right.
- `CaptureWarnings.kt`, `PipController.kt`, `MainActivity.kt`, `ProcessingService.kt`,
  `AndroidManifest.xml`, the server.

---

## 3. Implementation sequence

### Step 1. `CapClock` — the free limit's phase and the PiP label (pure, JVM-tested)

**Test first.** Create `android/app/src/test/java/com/innocorelabs/verbale/pipeline/CapClockTest.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.pipeline.CapClock.Phase
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What a FREE recording's limit looks like while it runs. The boundaries match the record
 * screen's own card (src/billing/recordingCap.ts, WARN_BEFORE_MS = 3 minutes) so the PiP window,
 * the notification and the screen change at the same second.
 */
class CapClockTest {
  private val cap = 900_000L // 15 minutes

  @Test fun `a recording with no limit is just the clock`() {
    assertEquals(Phase.UNCAPPED, CapClock.phase(252_000L, 0L))
    assertEquals("04:12", CapClock.pipLabel(252_000L, 0L))
    assertEquals("75:03", CapClock.pipLabel(4_503_000L, 0L))
  }

  @Test fun `a free recording shows its limit from the start`() {
    assertEquals(Phase.QUIET, CapClock.phase(252_000L, cap))
    assertEquals("04:12 / 15:00", CapClock.pipLabel(252_000L, cap))
    assertEquals("11:59 / 15:00", CapClock.pipLabel(719_999L, cap))
  }

  @Test fun `the countdown starts exactly three minutes before the limit`() {
    assertEquals(Phase.QUIET, CapClock.phase(719_999L, cap))
    assertEquals(Phase.WARNING, CapClock.phase(720_000L, cap))
    assertEquals("3:00 left on Free", CapClock.pipLabel(720_000L, cap))
    assertEquals("2:48 left on Free", CapClock.pipLabel(732_000L, cap))
  }

  @Test fun `the last minute is its own phase`() {
    assertEquals(Phase.WARNING, CapClock.phase(839_999L, cap))
    assertEquals("1:01 left on Free", CapClock.pipLabel(839_999L, cap))
    assertEquals(Phase.FINAL, CapClock.phase(840_000L, cap))
    assertEquals("1:00 left on Free", CapClock.pipLabel(840_000L, cap))
  }

  @Test fun `the countdown rounds up so it never reads a second early`() {
    assertEquals("0:41 left on Free", CapClock.pipLabel(859_000L, cap))
    assertEquals("0:41 left on Free", CapClock.pipLabel(859_500L, cap))
  }

  @Test fun `past the limit it holds at zero`() {
    assertEquals("0:00 left on Free", CapClock.pipLabel(900_000L, cap))
    assertEquals("0:00 left on Free", CapClock.pipLabel(930_000L, cap))
    assertEquals(0L, CapClock.remainingMs(930_000L, cap))
    assertEquals(168_000L, CapClock.remainingMs(732_000L, cap))
  }
}
```

Run (fails to compile — `CapClock` does not exist):
`cd android && ./gradlew :app:testDebugUnitTest --tests '*CapClockTest' 2>&1 | grep -E "BUILD|FAILED|e: " | tail -20`

**Code.** Create `android/app/src/main/java/com/innocorelabs/verbale/pipeline/CapClock.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

import java.util.Locale

/**
 * The free tier's length limit, as the surfaces outside the app show it.
 *
 * The record screen has its own card for the last three minutes; the PiP window and the recording
 * notification are what a person sees when the app is NOT in front, which is how most meetings
 * are recorded. They change at the same second the card does: WARN_BEFORE_MS mirrors
 * WARN_BEFORE_MS in src/billing/recordingCap.ts, and if one moves the other moves in the same
 * commit.
 *
 * Pure: no clock, no Android. The capture loop and the PiP view pass the numbers in.
 */
object CapClock {
  /** Mirrors WARN_BEFORE_MS in src/billing/recordingCap.ts. */
  const val WARN_BEFORE_MS = 3 * 60_000L

  /** The last minute, when the warning turns red. */
  const val FINAL_MS = 60_000L

  enum class Phase { UNCAPPED, QUIET, WARNING, FINAL }

  fun phase(elapsedMs: Long, capMs: Long): Phase {
    if (capMs <= 0L) return Phase.UNCAPPED
    val left = capMs - elapsedMs
    return when {
      left <= FINAL_MS -> Phase.FINAL
      left <= WARN_BEFORE_MS -> Phase.WARNING
      else -> Phase.QUIET
    }
  }

  fun remainingMs(elapsedMs: Long, capMs: Long): Long = (capMs - elapsedMs).coerceAtLeast(0L)

  /** "04:12" — the clock as the PiP window has always drawn it. */
  private fun clock(ms: Long): String {
    val s = (ms / 1000L).coerceAtLeast(0L)
    return String.format(Locale.ROOT, "%02d:%02d", s / 60, s % 60)
  }

  /** "2:48" — rounded UP, so the countdown never says a second less than there is. */
  private fun countdown(ms: Long): String {
    val s = (ms.coerceAtLeast(0L) + 999L) / 1000L
    return String.format(Locale.ROOT, "%d:%02d", s / 60, s % 60)
  }

  /** What the PiP window prints under the microphone. */
  fun pipLabel(elapsedMs: Long, capMs: Long): String = when (phase(elapsedMs, capMs)) {
    Phase.UNCAPPED -> clock(elapsedMs)
    Phase.QUIET -> "${clock(elapsedMs)} / ${clock(capMs)}"
    Phase.WARNING, Phase.FINAL -> "${countdown(remainingMs(elapsedMs, capMs))} left on Free"
  }

  /** The warning phases, where a purchase can still lift the limit and the surfaces count down. */
  fun counting(phase: Phase): Boolean = phase == Phase.WARNING || phase == Phase.FINAL
}
```

Run the same command → `BUILD SUCCESSFUL`. Count from the XML:
`grep -o 'tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*"' android/app/build/test-results/testDebugUnitTest/TEST-com.innocorelabs.verbale.pipeline.CapClockTest.xml`
→ `tests="6" skipped="0" failures="0"`.

**Mutant M1:** in `phase`, change `left <= WARN_BEFORE_MS` to `left < WARN_BEFORE_MS`. *the
countdown starts exactly three minutes before the limit* must fail. Restore.
**Mutant M2:** in `countdown`, delete `+ 999L`. *the countdown rounds up…* must fail. Restore.
Green again.

Commit: `feat(record): CapClock — the free limit's phase and the PiP label, in one pure place`.

### Step 2. The limit lives in `CaptureController`, where the PiP window can read it

In `CaptureController.kt`, directly after the line
`@Volatile var capturedMs: Long = 0L` (≈line 99) and a blank line, add:

```kotlin
  /**
   * The free tier's length limit for the recording in progress, in ms of captured audio; 0 means
   * none. RecordingService sets it at start and clears it when a purchase lifts it; the PiP window
   * and the notification read it. One copy, so every surface agrees on whether there is a limit.
   */
  @Volatile var capMs: Long = 0L
```

In `onCaptureEnded`, after the line `capturedMs = 0L`, add `capMs = 0L`.

Run: `cd android && ./gradlew :app:testDebugUnitTest 2>&1 | grep -E "BUILD|FAILED|e: " | tail -5`
→ `BUILD SUCCESSFUL`. Commit: `refactor(record): the free limit is CaptureController state, not the service's alone`.

### Step 3. `RecordingService` uses that one copy, and lifts the limit early on a purchase

In `RecordingService.kt`:

3.1 Delete the field `@Volatile private var capMs = 0L` (≈line 144). In its place add:

```kotlin
  /** The free limit's phase at the last check; the notification is re-posted when it changes. */
  @Volatile private var capPhase = CapClock.Phase.UNCAPPED
```

3.2 In `onStartCommand`'s `StartRoute.CAPTURE ->` branch, delete the line
`capMs = intent?.getLongExtra(EXTRA_CAP_MS, 0L) ?: 0L` (≈242) and, directly AFTER the line
`CaptureController.adopt(applicationContext, id!!, System.currentTimeMillis(), path!!)`, add:

```kotlin
        CaptureController.capMs = intent?.getLongExtra(EXTRA_CAP_MS, 0L) ?: 0L
        capPhase = CapClock.Phase.UNCAPPED
```

3.3 In the capture loop, replace this exact block (≈433–451):

```kotlin
            // About once a second (buffers are 128 ms): cheap, and a warning a second late is fine.
            if (reads % WARN_CHECK_EVERY_READS == 0) CaptureController.refreshWarning(filesDir.usableSpace)
            if (capMs > 0L && reads % DISK_CHECK_EVERY_READS == 0) {
              val capturedMs = File(path).length() / BYTES_PER_MS
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
            }
```

with:

```kotlin
            // About once a second (buffers are 128 ms): cheap, and a warning a second late is fine.
            if (reads % WARN_CHECK_EVERY_READS == 0) {
              CaptureController.refreshWarning(filesDir.usableSpace)
              // The free limit's phase drives the notification's countdown. Re-posted only when the
              // phase changes: the countdown itself is the system's chronometer, not our re-posts.
              val phase = CapClock.phase(CaptureController.capturedMs, CaptureController.capMs)
              if (phase != capPhase) {
                capPhase = phase
                refreshNotification()
              }
            }
            val cap = CaptureController.capMs
            if (cap > 0L && reads % DISK_CHECK_EVERY_READS == 0) {
              val capturedMs = File(path).length() / BYTES_PER_MS
              // In the last three minutes, ask whether Pro has been bought — the record screen's
              // card and the notification both sell it then — and lift the limit for the recording
              // ALREADY RUNNING, so the countdown stops soon after the purchase rather than at the
              // limit. About every half a minute (the disk-check cadence), and only in those three
              // minutes: it is a database read and a signature check. This is the ONE place the
              // limit is lifted or enforced.
              if (CapClock.counting(CapClock.phase(capturedMs, cap)) && LicenceStore.entitled(this@RecordingService)) {
                Log.i(TAG, "entitled at ${capturedMs}ms with ${cap - capturedMs}ms to the free limit — cap lifted")
                CaptureController.capMs = 0L
              } else if (capturedMs >= cap) {
                Log.i(TAG, "free tier limit reached at ${capturedMs}ms — stopping and keeping it")
                endReason = END_CAP_REACHED
                recording = false
              }
            }
```

Run the Kotlin command from Step 2 → `BUILD SUCCESSFUL`. Then
`grep -n "capMs" android/app/src/main/java/com/innocorelabs/verbale/pipeline/RecordingService.kt`
must show only `EXTRA_CAP_MS` lines and `CaptureController.capMs` — no bare `capMs` field left.

Commit: `fix(record): one copy of the free limit, lifted within half a minute of a purchase`.

### Step 4. The notification counts down to the limit

4.1 `strings.xml`: after the line with `name="notif_warn_storage"`, add:

```xml
    <string name="notif_cap_warning">Stops at the %1$d-minute Free limit — tap to keep recording with Pro</string>
    <string name="notif_cap_reached_title">Stopped at the %1$d-minute Free limit</string>
    <string name="notif_cap_reached_body">The recording is kept and is being transcribed. Pro records without a limit.</string>
```

4.2 In `buildNotification()`, after the line `val warning = CaptureController.warning`, add:

```kotlin
    // The free limit, from three minutes out: the body says so and the chronometer counts DOWN.
    val capMs = CaptureController.capMs
    val capLeftMs = CapClock.remainingMs(CaptureController.capturedMs, capMs)
    val capCounting = CaptureController.isRecording && !paused && !silenced &&
      CapClock.counting(CapClock.phase(CaptureController.capturedMs, capMs))
```

4.3 In the `val body = when {` block, directly after the line
`paused -> getString(R.string.notif_body_paused)`, add:

```kotlin
      capCounting -> getString(R.string.notif_cap_warning, (capMs / 60_000L).toInt())
```

4.4 Replace these exact lines (≈816–822; the `} else {` line itself is included):

```kotlin
    } else {
      // Wall-clock instant at which this meeting's CAPTURED time would have started had it never
      // been paused; the system counts up from there.
      b.setWhen(System.currentTimeMillis() - CaptureController.elapsedMs())
      b.setUsesChronometer(true)
      b.setShowWhen(true)
    }
```

with:

```kotlin
    } else if (capCounting) {
      // Counts DOWN to the free limit, drawn by the system, so nothing is re-posted each second.
      b.setWhen(System.currentTimeMillis() + capLeftMs)
      b.setUsesChronometer(true)
      b.setChronometerCountDown(true)
      b.setShowWhen(true)
    } else {
      // Wall-clock instant at which this meeting's CAPTURED time would have started had it never
      // been paused; the system counts up from there.
      b.setWhen(System.currentTimeMillis() - CaptureController.elapsedMs())
      b.setUsesChronometer(true)
      b.setShowWhen(true)
    }
```

(The tap target is unchanged: `setContentIntent(open)` already opens `MainActivity`, which brings a
PiP'd app back to full screen on the record screen, where the trial card is.)

Run the Kotlin command → `BUILD SUCCESSFUL`.
Commit: `feat(record): the recording notification counts down to the free limit`.

### Step 5. Say it when the limit stops a recording

5.1 In the companion object, after `private const val NOTIF_ID = 42`, add:

```kotlin
    /** "Stopped at the Free limit" — separate from NOTIF_ID, which goes when the service does. 43/44 are ProcessingService's. */
    private const val CAP_NOTICE_ID = 45
```

5.2 Directly above the line `    // Release CaptureController.stop() only now — the PCM is flushed and the row is updated,`
(in `onDestroy`, ≈line 615), add:

```kotlin
    if (endReason == END_CAP_REACHED) postCapReachedNotice()
```

5.3 Directly above `  private fun refreshNotification() {`, add:

```kotlin
  /**
   * A free recording just stopped at its limit — very likely with the screen off or in PiP, where
   * nothing else said so. Plain and silent; tapping opens the app. Read before onCaptureEnded
   * clears the limit, which is why onDestroy calls it first.
   */
  private fun postCapReachedNotice() {
    val minutes = (CaptureController.capMs / 60_000L).toInt()
    val open = PendingIntent.getActivity(
      this, 5,
      Intent(this, com.innocorelabs.verbale.MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val n = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(getString(R.string.notif_cap_reached_title, minutes))
      .setContentText(getString(R.string.notif_cap_reached_body))
      .setSmallIcon(R.drawable.ic_notification_rec)
      .setSilent(true)
      .setAutoCancel(true)
      .setContentIntent(open)
      .build()
    try {
      NotificationManagerCompat.from(this).notify(CAP_NOTICE_ID, n)
    } catch (_: Exception) {
      // POST_NOTIFICATIONS denied. The recording is kept and processed either way.
    }
  }

```

Run the Kotlin command → `BUILD SUCCESSFUL`.
Commit: `feat(record): a notification when the free limit stops a recording`.

### Step 6. The PiP window shows the limit

In `PipContentView.kt`:

6.1 After the line `private val cBlush = Color.parseColor("#FFC9CE")`, add:

```kotlin
  // The free limit's warning colours: amber for the last three minutes, the danger edge for the
  // last one. Both dark enough to read on cCanvas at PiP size.
  private val cAmber = Color.parseColor("#B86E00")
```

6.2 In `onDraw`, replace `drawClock(canvas, w * 0.5f, h * 0.85f, h, paused)` with
`drawClock(canvas, w * 0.5f, h * 0.85f, w, h, paused, t)`.

6.3 Replace the whole `private fun drawClock(...)` function with:

```kotlin
  private fun drawClock(canvas: Canvas, cx: Float, cy: Float, w: Float, h: Float, paused: Boolean, t: Float) {
    val ms = CaptureController.elapsedMs()
    val capMs = CaptureController.capMs
    val phase = CapClock.phase(ms, capMs)
    val label = CapClock.pipLabel(ms, capMs)
    text.color = when (phase) {
      CapClock.Phase.WARNING -> cAmber
      CapClock.Phase.FINAL -> cDangerEdge
      else -> cInk
    }
    text.textSize = h * 0.16f
    val dotR = h * 0.028f
    val gap = h * 0.035f
    // "2:48 left on Free" is wider than "04:12"; shrink to fit rather than clip in a small window.
    val maxW = w * 0.9f
    var tw = text.measureText(label)
    if (dotR * 2f + gap + tw > maxW) {
      text.textSize *= maxW / (dotR * 2f + gap + tw)
      tw = text.measureText(label)
    }
    val totalW = dotR * 2f + gap + tw
    val left = cx - totalW / 2f
    fill.color = if (paused) cInkFaint else cDanger
    // The last minute: the dot pulses, so the window reads as urgent even at a glance.
    if (phase == CapClock.Phase.FINAL && !paused) {
      fill.alpha = (255 * (0.35 + 0.65 * Math.abs(Math.sin(t * 4.0)))).toInt()
    }
    canvas.drawCircle(left + dotR, cy, dotR, fill)
    fill.alpha = 255
    val fm = text.fontMetrics
    canvas.drawText(label, left + dotR * 2f + gap, cy - (fm.ascent + fm.descent) / 2f, text)
  }
```

Run the Kotlin command → `BUILD SUCCESSFUL`.
Commit: `feat(pip): the free limit in picture-in-picture — the limit, then a countdown`.

### Step 7. Gate, release build, report

1. `scripts/gate.sh 2>&1 | grep -E "==>|ok |FAILED|gate:" | tail -20` — every stage `ok`. If the
   device stage finds a phone, **stop it** (Ctrl-C) and re-run with `STAGES="types js scans
   mutations kotlin cpp" scripts/gate.sh 2>&1 | grep -E "==>|ok |FAILED|gate:" | tail -20`: this
   session runs no `adb`. Force Kotlin:
   `cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks 2>&1 | grep -E "BUILD|FAILED" | tail -3`.
2. `cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a 2>&1 | grep -E "BUILD|FAILED|error:" | tail -5`
   → `BUILD SUCCESSFUL`.
3. `git diff --stat 1ce60ab..HEAD` may name only: `CapClock.kt`, `CapClockTest.kt`,
   `CaptureController.kt`, `RecordingService.kt`, `PipContentView.kt`, `strings.xml`, this sheet,
   the report.
4. Write the report (§8), commit: `docs(report): free limit in PiP and the notification — built, by-hand steps`.

---

## 4. Expected interfaces after this sheet

- `CapClock.phase(elapsedMs, capMs): Phase` (`UNCAPPED | QUIET | WARNING | FINAL`),
  `CapClock.remainingMs`, `CapClock.pipLabel`, `CapClock.counting(phase)`,
  `CapClock.WARN_BEFORE_MS = 180_000`, `CapClock.FINAL_MS = 60_000`.
- `CaptureController.capMs: Long` (volatile; 0 = no limit), cleared in `onCaptureEnded`.
- `RecordingService` has no `capMs` field of its own.
- Strings `notif_cap_warning`, `notif_cap_reached_title`, `notif_cap_reached_body`.

## 5. Tests and commands

| Command | Must print |
|---|---|
| `cd android && ./gradlew :app:testDebugUnitTest --tests '*CapClockTest' 2>&1 \| grep -E "BUILD\|FAILED" \| tail -5` | `BUILD SUCCESSFUL`; XML `tests="6" … failures="0"` |
| `cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks 2>&1 \| grep -E "BUILD\|FAILED" \| tail -3` | `BUILD SUCCESSFUL` |
| gate (Step 7.1) | every stage `ok` |
| `assembleRelease` (Step 7.2) | `BUILD SUCCESSFUL` |

Mutants M1, M2 (Step 1) must each fail their named test, then be restored.

## 6. Acceptance criteria

- §5 all as stated; both mutants killed and recorded.
- `git grep -n "private var capMs" -- android` → no output.
- `git diff --stat 1ce60ab..HEAD` as in Step 7.3; `git status` clean.

## 7. Stop conditions

- A step needs a change in a §2 file: stop, write what and why in the report, commit.
- Two unsuccessful fixes of the same compile error or failing test: stop, record the error and both
  attempts, commit.
- A gate stage fails in a file this session did not touch: do not investigate; record the last 20
  lines, commit.
- At 150 steps: finish the current step, commit, note what is left, stop.

## 8. The report contract

`docs/superpowers/reports/2026-09-24-free-cap-pip-warning.md`:

1. **Status** in one line.
2. **What was built**, per step, with commit hashes.
3. **Decisions**, each with its cause.
4. **Tests**: name, result, mutant, mutant result.
5. **Gate summary** and the `assembleRelease` result.
6. **Device**: "not run — founder's by-hand session".
7. **By hand, for the founder** — copy verbatim. Needs a phone signed in to a FREE Google account
   (no Pro, no trial active) with this build installed (a new internal-testing upload, or a
   release APK side-loaded for the look-only steps 1–4):
   1. Start a recording, press Home. The PiP window shows **● 00:0x / 15:00** in the normal ink
      colour. (A Pro account shows **● 00:0x** only — check once if you have one.)
   2. Leave it running. At **12:00** the PiP text becomes **3:00 left on Free** in amber and counts
      down; the notification (pull the shade) now counts DOWN and reads **Stops at the 15-minute
      Free limit — tap to keep recording with Pro**.
   3. At **14:00** the PiP text turns red and the dot pulses: **1:00 left on Free** … .
   4. Pause from PiP: the countdown freezes and the dot goes grey; the notification shows
      *Paused at …*. Resume: the countdown carries on.
   5. **Tap the notification** during the countdown: the app comes to full screen on the record
      screen with the **Keep recording — 7 days free** card. (Internal-testing install only: buy
      with the licence tester → within about half a minute the PiP/notification countdown is gone
      and the recording passes 15:00.)
   6. **Without buying**, let it reach 15:00: the recording stops (up to ~30 s past 15:00 — the
      disk-check cadence), a notification **Stopped at the 15-minute Free limit** appears, and the
      meeting is processed as normal.
8. **Known gaps** (at least: the limit is enforced on a ~33 s cadence, so a free recording can run
   up to ~33 s past 15:00 — unchanged from before; nothing here is JVM-testable beyond `CapClock`).
9. **Commits**: `git log --oneline 1ce60ab..HEAD`.

If something was not run, say so — never mark it done.

## 9. The prompt that starts the session

> Read `docs/superpowers/specs/2026-09-24-free-cap-pip-warning-execution.md` and execute it exactly
> as written: Steps 1–7, under its token rules. Stop when the report is committed, when a stop
> condition is met, or at 150 steps. Do not push.

## 10. Deliberately NOT in this sheet

- Buying from PiP or from the notification directly — Play's sheet needs the full app.
- A shorter test limit for faster device checks — the by-hand run takes ~16 minutes, accepted.
- The record screen's card (TypeScript) — already right; it and these surfaces share the
  3-minute boundary.
