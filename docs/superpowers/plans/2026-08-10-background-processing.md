# Background Processing (Foreground Service + Resume-by-Stage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make meeting processing (VAD → ASR → diarize → minutes) survive the app being backgrounded or killed by running it in a foreground service, and stop redoing the expensive ASR on every interruption by resuming from the last completed, persisted stage.

**Architecture:** Today the pipeline runs on a bare `Thread` inside `AudioPipelineModule.process()` ([AudioPipelineModule.kt:156](../../../android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt#L156)); when Android reclaims the app process the thread dies and, on reopen, `PipelineController.sweep()` re-runs the whole pipeline from VAD. We introduce a new foreground service `ProcessingService` (type `dataSync`, modeled on `RecordingService`) that owns a serial queue of meeting ids and runs the native stages with a progress notification, so processing continues when the user leaves the app. A pure `resumePlan(status, hasSegments, hasUtterances, hasSpeakers)` function decides which stages remain, so a meeting interrupted after ASR resumes at diarization instead of re-transcribing. `AudioPipelineModule.process()` becomes a thin trigger that enqueues into the service. Minutes stay in JS for this phase (cheap text work) and run on next JS availability; the expensive native stages are what we make durable.

**Tech Stack:** Kotlin (Android foreground service, `NotificationCompat`, `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC`), existing JNI bridge (`NativeBridge`), SQLite via `AudioDb`, React Native TurboModule event bridge, TypeScript orchestration in `PipelineController`. Kotlin unit tests via JUnit (Robolectric not required for the pure logic). JS tests via the repo's existing Jest setup.

---

## Scope note

This plan is **Feature A only**. "Transcribe during recording" (Feature B) is a separate plan — it depends on this plan's resume-by-stage persistence **plus** two new native APIs that do not exist yet:
1. A handle-based streaming ASR (`nativeAsrLoad/TranscribeSpan/Free`) so the whisper model stays loaded across spans — today every `nativeTranscribe` reloads the model ([whisper_asr.cpp:65-80](../../../cpp/asr/whisper_asr.cpp#L65)).
2. A streaming VAD handle to detect spans closing mid-capture — today no live VAD runs during capture.
Do not attempt Feature B here.

---

## File Structure

**Create:**
- `android/app/src/main/java/com/audionotes/pipeline/ProcessingService.kt` — foreground service; owns the serial processing queue, the progress notification, and the wake lock. Runs one meeting at a time on a worker thread.
- `android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt` — the actual VAD/ASR/diarize sequence extracted out of `AudioPipelineModule.process()`, made resume-aware. Callable from the service (and, in tests, in isolation). Emits progress via a small callback interface so the service can update the notification and `AudioPipelineModule` can forward JS events.
- `android/app/src/main/java/com/audionotes/pipeline/ResumePlan.kt` — pure function deciding remaining stages from persisted state. No Android deps → unit-testable.
- `android/app/src/test/java/com/audionotes/pipeline/ResumePlanTest.kt` — unit tests for `ResumePlan`.

**Modify:**
- `android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt` — `process()` and `recoverOrphans()` become thin triggers that start/enqueue `ProcessingService`; the heavy `Thread` body moves to `ProcessingEngine`. Keep the JS event emitters (`emitProgress`/`emitComplete`) and expose them to the engine via a listener.
- `android/app/src/main/java/com/audionotes/data/AudioDb.kt` — add read helpers the resume decision needs: `getStatus(id): String?`, `hasSegments(id): Boolean`, `hasUtterances(id): Boolean`, `hasSpeakers(id): Boolean` (or a single `pipelineState(id)` returning all four).
- `android/app/src/main/AndroidManifest.xml` — declare `ProcessingService` with `foregroundServiceType="dataSync"`; add `FOREGROUND_SERVICE_DATA_SYNC` permission.
- `src/pipeline/PipelineController.ts` — `process()` still awaits native completion then runs `buildMinutes`/`enhanceMinutes`; add resilience so minutes run for any meeting left in `diarized`/`asr` on the next sweep even if the native side already finished in the background.

---

## Task 1: Pure resume-plan decision (`ResumePlan.kt`) — TDD

**Files:**
- Create: `android/app/src/main/java/com/audionotes/pipeline/ResumePlan.kt`
- Test: `android/app/src/test/java/com/audionotes/pipeline/ResumePlanTest.kt`

Observed status progression (from the code, not the wider type union): `captured → vad → asr → diarized → done`, with `error` terminal. Persisted rows per stage: VAD writes `segments`, ASR writes `utterances`, diarize writes `speakers` ([AudioDb.kt](../../../android/app/src/main/java/com/audionotes/data/AudioDb.kt)). The decision must rely on **persisted rows**, not status alone, because status advances at stage entry and a kill can leave status ahead of committed rows.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.audionotes.pipeline

import org.junit.Assert.assertEquals
import org.junit.Test

class ResumePlanTest {
  private fun plan(status: String, seg: Boolean, utt: Boolean, spk: Boolean) =
    ResumePlan.remaining(
      ResumePlan.State(status = status, hasSegments = seg, hasUtterances = utt, hasSpeakers = spk),
    )

  @Test fun freshCapture_runsAllStages() {
    assertEquals(listOf(Stage.VAD, Stage.ASR, Stage.DIARIZE), plan("captured", false, false, false))
  }

  @Test fun vadDone_skipsVad() {
    assertEquals(listOf(Stage.ASR, Stage.DIARIZE), plan("vad", true, false, false))
  }

  @Test fun asrDone_resumesAtDiarize() {
    assertEquals(listOf(Stage.DIARIZE), plan("asr", true, true, false))
  }

  @Test fun diarizeDone_nothingNative() {
    assertEquals(emptyList<Stage>(), plan("diarized", true, true, true))
  }

  @Test fun statusAheadOfRows_rerunsFromMissingRows() {
    // status says asr but utterances never committed (killed mid-write) -> ASR must re-run.
    assertEquals(listOf(Stage.ASR, Stage.DIARIZE), plan("asr", true, false, false))
  }

  @Test fun noSpeechIsTerminal_notResumable() {
    // VAD ran, produced no segments -> ASR/diarize impossible; caller treats as terminal.
    assertEquals(emptyList<Stage>(), plan("vad", false, false, false))
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.audionotes.pipeline.ResumePlanTest"`
Expected: FAIL — `ResumePlan` / `Stage` unresolved.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.audionotes.pipeline

/** The native pipeline stages, in order. Minutes runs in JS and is not part of this plan. */
enum class Stage { VAD, ASR, DIARIZE }

/**
 * Decides, from a meeting's persisted state, which native stages still need to run.
 *
 * Persisted ROWS are the source of truth, not `status`: status advances when a stage STARTS, so a
 * process killed mid-stage can leave status ahead of the rows actually committed. We only skip a
 * stage when its output rows exist. "VAD ran but produced no segments" is a genuine no-speech
 * recording, not resumable — remaining() returns empty and the caller marks it terminal.
 */
object ResumePlan {
  data class State(
    val status: String,
    val hasSegments: Boolean,
    val hasUtterances: Boolean,
    val hasSpeakers: Boolean,
  )

  fun remaining(s: State): List<Stage> {
    // Terminal no-speech: VAD already ran (status past 'captured') and committed zero segments.
    if (!s.hasSegments && s.status != "captured") return emptyList()

    val stages = mutableListOf<Stage>()
    if (!s.hasSegments) stages += Stage.VAD
    if (!s.hasUtterances) stages += Stage.ASR
    if (!s.hasSpeakers) stages += Stage.DIARIZE
    return stages
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.audionotes.pipeline.ResumePlanTest"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/audionotes/pipeline/ResumePlan.kt \
        android/app/src/test/java/com/audionotes/pipeline/ResumePlanTest.kt
git commit -m "feat(pipeline): pure resume-by-stage decision from persisted rows"
```

---

## Task 2: DB read helpers for the resume decision

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/data/AudioDb.kt`

Add a single query returning the four facts `ResumePlan.State` needs, so the engine makes one DB round-trip. Follow the existing `AudioDb` query style (see `getAudioPath`/`replaceSegments`).

- [ ] **Step 1: Add `pipelineState`**

```kotlin
/**
 * The four facts the resume planner needs, in one read: current status and whether each stage's
 * output rows exist. Rows (not status) decide what to skip — see ResumePlan.
 */
fun pipelineState(meetingId: String): com.audionotes.pipeline.ResumePlan.State {
  val db = readableDatabase
  fun exists(table: String, col: String): Boolean =
    db.rawQuery("SELECT 1 FROM $table WHERE $col = ? LIMIT 1", arrayOf(meetingId)).use { it.moveToFirst() }
  val status = db.rawQuery("SELECT status FROM meetings WHERE id = ? LIMIT 1", arrayOf(meetingId)).use {
    if (it.moveToFirst()) it.getString(0) else "captured"
  }
  return com.audionotes.pipeline.ResumePlan.State(
    status = status,
    hasSegments = exists("segments", "meeting_id"),
    hasUtterances = exists("utterances", "meeting_id"),
    hasSpeakers = exists("speakers", "meeting_id"),
  )
}
```

> Before writing, confirm the actual column names in `AudioDb.kt` (`meeting_id` vs `meetingId`) for `segments`/`utterances`/`speakers` and the meetings PK/status column, and match them exactly. If a table stores segments as a single flat blob row rather than one row per span, `exists` still works (any row = VAD ran).

- [ ] **Step 2: Verify it compiles**

Run: `cd android && ./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/audionotes/data/AudioDb.kt
git commit -m "feat(db): pipelineState() read for resume-by-stage"
```

---

## Task 3: Extract the pipeline body into `ProcessingEngine` (resume-aware)

**Files:**
- Create: `android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt`
- Modify: `android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt` (move the `Thread` body out; keep event emitters)

Move the VAD/ASR/diarize sequence currently inline in `AudioPipelineModule.process()` ([:156-263](../../../android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt#L156)) into a plain class that:
- takes `Context`, `meetingId`, options, and a `Listener`;
- calls `NativeBridge.ensureLoaded(ctx)` then reads `db.pipelineState(meetingId)` and `ResumePlan.remaining(...)`;
- runs only the remaining stages, persisting after each and calling `listener.onStage(stage, done, total)` / `listener.onComplete(outcome, message)`;
- checks a `@Volatile var cancelled` between stages (same semantics as today).

- [ ] **Step 1: Define the engine + listener**

```kotlin
package com.audionotes.pipeline

import android.content.Context
import android.util.Log
import com.audionotes.data.AudioDb
import com.audionotes.data.ModelCatalog
import java.io.File

class ProcessingEngine(
  private val ctx: Context,
  private val meetingId: String,
  private val model: String,
  private val listener: Listener,
) {
  interface Listener {
    fun onStage(stage: String, done: Int, total: Int)
    fun onComplete(outcome: String, message: String? = null) // done | cancelled | error
  }

  @Volatile var cancelled = false

  /** Runs the remaining native stages for [meetingId]. Safe to call from a worker thread. */
  fun run() {
    try {
      NativeBridge.ensureLoaded(ctx)
      val db = AudioDb.get(ctx)
      val audioPath = db.getAudioPath(meetingId)
      if (audioPath == null || !File(audioPath).exists()) {
        // Audio deleted by retention (a re-run after transcription) — nothing to re-derive.
        listener.onComplete("done"); return
      }
      val remaining = ResumePlan.remaining(db.pipelineState(meetingId))
      if (remaining.isEmpty()) { listener.onComplete("done"); return }

      if (Stage.VAD in remaining) {
        listener.onStage("vad", 0, 1)
        val modelPath = ModelCatalog.fileFor(ctx, "vad")?.absolutePath
          ?: ensureVadModelFallback()
        val segments = NativeBridge.nativeVad(audioPath, modelPath, RecordingService.SAMPLE_RATE)
        db.replaceSegments(meetingId, segments)
        db.setStatus(meetingId, "vad")
        listener.onStage("vad", 1, 1)
        Log.i(TAG, "VAD produced ${segments.size / 2} segments for $meetingId")
        if (checkCancelled()) return
        if (segments.isEmpty()) { listener.onComplete("done"); return } // no speech: terminal
      }

      if (Stage.ASR in remaining) {
        // ... move the ASR block from AudioPipelineModule.process() here verbatim, reading
        // segments back from db (db.segments(meetingId)) instead of a local variable, since VAD
        // may have run in a PRIOR session. Persist utterances, setStatus("asr"), onStage("asr",…).
        if (checkCancelled()) return
      }

      if (Stage.DIARIZE in remaining) {
        // ... move the diarize block here verbatim; guard on diar models installed; setStatus("diarized").
      }

      listener.onComplete("done")
    } catch (e: Exception) {
      Log.e(TAG, "process failed for $meetingId", e)
      try { AudioDb.get(ctx).setStatus(meetingId, "error") } catch (_: Exception) {}
      listener.onComplete("error", e.message ?: e.toString())
    }
  }

  private fun checkCancelled(): Boolean {
    if (!cancelled) return false
    listener.onComplete("cancelled"); return true
  }

  private fun ensureVadModelFallback(): String { /* move ensureVadModel() from AudioPipelineModule */ TODO() }

  companion object { private const val TAG = "AudioPipeline" }
}
```

> Implementer note: the `// ...` blocks are a verbatim move of the existing ASR and diarize code from `AudioPipelineModule.process()` — including the `ModelCatalog.asrIdForModel(model)`, the `starts`/`ends` LongArrays, `db.replaceUtterancesJson`, the `stageDone` timing log, and the diar-model existence guard. The one change: when ASR resumes in a later session, read VAD spans from `db.segments(meetingId)` rather than a local `segments` list. Replace the `TODO()` by moving the real `ensureVadModel()` implementation across.

- [ ] **Step 2: Point `AudioPipelineModule.process()` at the engine (temporary in-thread wiring)**

Keep behavior identical for now (still a `Thread`, not the service yet) so this task is verifiable on its own:

```kotlin
@ReactMethod
fun process(meetingId: String, options: ReadableMap, promise: Promise) {
  cancelled.remove(meetingId)
  val model = if (options.hasKey("model")) options.getString("model") ?: "base" else "base"
  Thread {
    val engine = ProcessingEngine(ctx, meetingId, model, object : ProcessingEngine.Listener {
      override fun onStage(stage: String, done: Int, total: Int) = emitProgress(meetingId, stage, done, total)
      override fun onComplete(outcome: String, message: String?) {
        if (outcome == "error") emitComplete(meetingId, "error", message ?: "")
        else emitComplete(meetingId, outcome)
      }
    })
    engines[meetingId] = engine
    try { engine.run(); promise.resolve(null) }
    catch (e: Exception) { promise.reject("process_failed", e) }
    finally { engines.remove(meetingId); cancelled.remove(meetingId) }
  }.start()
}
```

Add `private val engines = java.util.concurrent.ConcurrentHashMap<String, ProcessingEngine>()` and make `cancel()` set `engines[meetingId]?.cancelled = true` in addition to the existing `cancelled` set.

- [ ] **Step 3: Build + device smoke test (behavior unchanged)**

Run: `cd android && ./gradlew :app:assembleDebug` then install and record→stop a short clip; confirm it still transcribes and reaches READY, and that reprocessing a READY meeting now **skips** VAD/ASR (watch logcat: no second `ASR produced` line).

Expected: BUILD SUCCESSFUL; reprocess of a done meeting completes near-instantly.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt \
        android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt
git commit -m "refactor(pipeline): extract resume-aware ProcessingEngine from the module"
```

---

## Task 4: `ProcessingService` foreground service

**Files:**
- Create: `android/app/src/main/java/com/audionotes/pipeline/ProcessingService.kt`
- Modify: `android/app/src/main/AndroidManifest.xml`

Mirror `RecordingService`'s foreground setup ([RecordingService.kt:412-434, 515-584](../../../android/app/src/main/java/com/audionotes/pipeline/RecordingService.kt#L412)) but with type `dataSync`, no mic, a PARTIAL wake lock, and a serial queue of meeting ids. The service processes ids one at a time via `ProcessingEngine`, updates the notification with the current stage, and `stopSelf()`s when the queue drains.

- [ ] **Step 1: Manifest — declare service + permission**

Add under `<manifest>` permissions:
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
```
Add under `<application>`:
```xml
<service
    android:name=".pipeline.ProcessingService"
    android:exported="false"
    android:foregroundServiceType="dataSync" />
```

- [ ] **Step 2: Implement the service**

```kotlin
package com.audionotes.pipeline

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Runs meeting processing (VAD/ASR/diarize) in the background so it survives the app being
 * backgrounded or killed. One meeting at a time on a worker thread; a progress notification keeps
 * the process alive and shows the user what's happening. Enqueue more ids while running via a
 * fresh startService with EXTRA_MEETING_ID.
 */
class ProcessingService : Service() {
  private val queue = ConcurrentLinkedQueue<String>()
  @Volatile private var worker: Thread? = null
  @Volatile private var current: ProcessingEngine? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra(EXTRA_MEETING_ID)
    if (id != null && queue.none { it == id } && current?.let { false } != true) queue.add(id)
    startForegroundSafe(currentLabel())
    ensureWorker()
    return START_REDELIVER_INTENT
  }

  private fun ensureWorker() {
    if (worker?.isAlive == true) return
    worker = Thread {
      try {
        acquireWakeLock()
        while (true) {
          val id = queue.poll() ?: break
          updateNotification("Transcribing meeting…")
          val engine = ProcessingEngine(this, id, "base", object : ProcessingEngine.Listener {
            override fun onStage(stage: String, done: Int, total: Int) {
              updateNotification(stageLabel(stage))
              AudioPipelineBridge.emitProgress(id, stage, done, total)
            }
            override fun onComplete(outcome: String, message: String?) {
              AudioPipelineBridge.emitComplete(id, outcome, message)
            }
          })
          current = engine
          engine.run()
          current = null
        }
      } finally {
        releaseWakeLock()
        stopForegroundCompat()
        stopSelf()
      }
    }.also { it.name = "audionotes-processing"; it.start() }
  }

  fun cancel(meetingId: String) {
    queue.remove(meetingId)
    if (current?.let { true } == true) current?.cancelled = true
  }

  // --- foreground / notification (mirrors RecordingService) ---
  private fun startForegroundSafe(text: String) {
    createChannel()
    val n = buildNotification(text)
    if (Build.VERSION.SDK_INT >= 29)
      startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(NOTIF_ID, n)
  }
  private fun updateNotification(text: String) =
    NotificationManagerCompat.from(this).notify(NOTIF_ID, buildNotification(text))
  private fun buildNotification(text: String) =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("AudioNotes")
      .setContentText(text)
      .setOngoing(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  private fun createChannel() = NotificationManagerCompat.from(this).createNotificationChannel(
    NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_LOW)
      .setName("Transcribing").build())
  private fun stopForegroundCompat() =
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
  private fun acquireWakeLock() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "audionotes:processing").apply { acquire(6 * 60 * 60 * 1000L) }
  }
  private fun releaseWakeLock() { wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null }
  private fun currentLabel() = "Transcribing meeting…"
  private fun stageLabel(stage: String) = when (stage) {
    "vad" -> "Cleaning up audio…"; "asr" -> "Writing words down…"; "diarize" -> "Separating speakers…"; else -> "Transcribing meeting…"
  }

  companion object {
    private const val EXTRA_MEETING_ID = "meetingId"
    private const val NOTIF_ID = 43
    private const val CHANNEL_ID = "audionotes.processing"
    fun enqueue(ctx: Context, meetingId: String) {
      val i = Intent(ctx, ProcessingService::class.java).putExtra(EXTRA_MEETING_ID, meetingId)
      if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
    }
  }
}
```

> Implementer notes: (1) `AudioPipelineBridge` is a tiny static forwarder (Task 5) so the service can emit JS events without holding the React module. (2) Match the small-icon to whatever `RecordingService` uses. (3) The `current?.let { false } != true` guard in `onStartCommand` is a placeholder for "don't double-enqueue the meeting already running" — implement it against a `@Volatile var currentId: String?` instead; simplify to `if (id != null && id != currentId && id !in queue) queue.add(id)`.

- [ ] **Step 3: Build**

Run: `cd android && ./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/audionotes/pipeline/ProcessingService.kt \
        android/app/src/main/AndroidManifest.xml
git commit -m "feat(pipeline): ProcessingService foreground service (dataSync) with serial queue"
```

---

## Task 5: Route processing through the service + static event forwarder

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt`
- Create: `android/app/src/main/java/com/audionotes/pipeline/AudioPipelineBridge.kt`

Make `process()` enqueue into the service instead of running its own `Thread`, and give the service a way to emit JS events (best-effort) through a static forwarder that holds the current `ReactApplicationContext` weakly.

- [ ] **Step 1: Static forwarder**

```kotlin
package com.audionotes.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/** Lets the background service emit RN events without owning the module. Best-effort: no-op if JS is gone. */
object AudioPipelineBridge {
  @Volatile private var ref: WeakReference<ReactApplicationContext>? = null
  fun attach(ctx: ReactApplicationContext) { ref = WeakReference(ctx) }
  fun emitProgress(meetingId: String, stage: String, done: Int, total: Int) = emit("onStageProgress",
    mapOf("meetingId" to meetingId, "stage" to stage, "chunk" to done, "total" to total))
  fun emitComplete(meetingId: String, outcome: String, message: String?) =
    emit(if (outcome == "error") "onError" else "onStageComplete",
      buildMap { put("meetingId", meetingId); put("outcome", outcome); if (message != null) put("message", message) })
  private fun emit(event: String, data: Map<String, Any?>) {
    val ctx = ref?.get() ?: return
    try {
      val m = Arguments.createMap()
      data.forEach { (k, v) -> when (v) { is Int -> m.putInt(k, v); is String -> m.putString(k, v); else -> {} } }
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, m)
    } catch (_: Exception) { /* no JS context */ }
  }
}
```

Call `AudioPipelineBridge.attach(ctx)` in `AudioPipelineModule.init` (alongside `CaptureController.addListener`).

- [ ] **Step 2: `process()` enqueues; `recoverOrphans` kicks the sweep**

```kotlin
@ReactMethod
fun process(meetingId: String, options: ReadableMap, promise: Promise) {
  cancelled.remove(meetingId)
  ProcessingService.enqueue(ctx, meetingId)
  // Resolve immediately: the SERVICE owns completion now, and JS learns of it via onStageComplete.
  promise.resolve(null)
}
```

> This changes the `process()` contract: it no longer blocks until done. Update `PipelineController.process()` (Task 6) to await the `onStageComplete` event rather than the promise for the "then run minutes" step. `cancel()` forwards to the service: `ProcessingService`-held engine via a static `cancel` hook, plus the existing `cancelled` set as a fallback.

- [ ] **Step 3: Build + device test — the core outcome**

Run: `cd android && ./gradlew :app:assembleDebug`, install. Record a 60s clip, hit Stop, then **immediately background the app and open another app**. Confirm: the "Transcribing…" notification appears and advances through stages; `pidof com.audionotes` may go away but the service keeps the process alive; reopen after ~1 min and the meeting is READY without a from-scratch restart.

Expected: processing completes with the app backgrounded.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/audionotes/pipeline/AudioPipelineBridge.kt \
        android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt
git commit -m "feat(pipeline): run processing in ProcessingService; forward events via bridge"
```

---

## Task 6: JS orchestration — minutes after background completion

**Files:**
- Modify: `src/pipeline/PipelineController.ts`

`process()` no longer blocks on the native promise (the service now owns completion). Rework it to trigger native processing, then run minutes when the meeting is transcribed — whether completion arrives via the `onStageComplete` event (app alive) or is discovered on the next `sweep()` (app was killed and reopened). The sweep already picks up meetings in `asr`/`diarized`; ensure `buildMinutes` runs for those and drives them to `done`.

- [ ] **Step 1: Make `process()` await native completion via event, then minutes**

```ts
async process(meetingId: string, opts: { model: 'base' | 'small'; useLLM: boolean }): Promise<void> {
  await this.awaitNativeComplete(meetingId, () => AudioPipeline.process(meetingId, opts));
  await this.buildMinutes(meetingId);                 // deterministic floor
  if (opts.useLLM !== false) await this.enhanceMinutes(meetingId);
  await this.applyRetention(meetingId);
}

/** Resolve when the service reports this meeting done/cancelled/error. Falls back to a poll so a
 *  kill that drops the event never hangs the caller — the next sweep still finishes minutes. */
private awaitNativeComplete(meetingId: string, kick: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = this.onComplete((e) => { if (e.meetingId === meetingId) { off(); resolve(); } });
    kick().catch(() => { off(); resolve(); });
  });
}
```

- [ ] **Step 2: Ensure the sweep finishes minutes for background-completed meetings**

In `sweep()`, a meeting the service already advanced to `diarized` (or `asr`) while the app was dead needs its minutes built without re-running native. `buildMinutes` is safe to call when `utterances` exist; when they don't but `segments` do, leave it for native. Adjust `sweep()` so that for a pending meeting it first checks native state and, if only minutes remain, calls `buildMinutes` directly instead of `process()`:

```ts
for (const m of pending) {
  if (this.inFlight.has(m.id)) continue;
  this.inFlight.add(m.id);
  try {
    const utt = await db.utterances(m.id);
    const spk = await db.speakers(m.id);
    if (utt.length > 0 && spk.length > 0) {
      await this.buildMinutes(m.id);                  // native stages already done in background
      if (/* useLLM default */ true) await this.enhanceMinutes(m.id);
      await this.applyRetention(m.id);
    } else {
      await this.process(m.id, { model: 'base', useLLM: true });
    }
  } catch { /* leave status; next sweep retries */ }
  finally { this.inFlight.delete(m.id); }
}
```

- [ ] **Step 3: Run JS tests**

Run: `yarn jest src/pipeline` (or the repo's test command)
Expected: existing pipeline tests pass; add a test that a `diarized` meeting with utterances+speakers goes to `done` via `buildMinutes` without calling `AudioPipeline.process`.

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/PipelineController.ts
git commit -m "feat(pipeline): finish minutes after background native completion"
```

---

## Task 7: End-to-end device verification (the acceptance test)

**Files:** none (manual/device).

- [ ] **Step 1: Background-survival**

Record 90s, Stop, immediately switch to another app for 2 min. Expected: "Transcribing…" notification runs to completion; meeting READY on return; logcat shows each stage once.

- [ ] **Step 2: Kill-mid-ASR resume**

Record 3 min, Stop, force-stop the app (`adb shell am force-stop com.audionotes`) ~20s into ASR. Reopen. Expected: it resumes at the stage after the last committed rows (no duplicate `ASR produced` for spans already done — with the service, ideally ASR wasn't interrupted at all; if it was, VAD is skipped and ASR re-runs once).

- [ ] **Step 3: No-speech terminal**

Record 20s of silence, Stop. Expected: VAD produces 0 segments → meeting marked terminal (no endless re-sweep), matching the pre-existing `error`/empty handling.

- [ ] **Step 4: Backlog order**

With several pending meetings, Stop a new one. Expected: notification processes them serially without duplicate concurrent runs (the `inFlight`/queue guards hold).

- [ ] **Step 5: Commit any fixes, then update memory**

Update `pip-recorder`/`android-build-run` memories with the new ProcessingService, the `dataSync` foreground type, and the resume-by-stage contract.

---

## Self-Review notes

- **Spec coverage:** durable background processing = Tasks 4–5; resume-by-stage = Tasks 1–3, 6; both device-verified in Task 7. ✅
- **Contract change flagged:** `AudioPipeline.process()` becomes fire-and-forget (Task 5) and JS awaits the completion event (Task 6) — the one behavioral break; RecordScreen's `process().catch()` at [RecordScreen.tsx:113](../../../src/screens/RecordScreen.tsx#L113) still works because it doesn't depend on the promise resolving at completion, but re-verify its UI (it navigates to the Meeting screen which listens for events anyway).
- **Minutes-in-background is intentionally deferred:** the expensive native stages are made durable; minutes (cheap JS text work) still complete on next JS availability. If "notes ready in the notification without reopening" is required, a follow-up ports `extractMinutes` to Kotlin or runs a HeadlessJS task — out of scope here.
- **Open verification for the implementer:** exact DB column names in `pipelineState` (Task 2); the small-icon resource; and whether `START_REDELIVER_INTENT` re-delivery double-enqueues (dedupe by `currentId` + `queue` membership).
