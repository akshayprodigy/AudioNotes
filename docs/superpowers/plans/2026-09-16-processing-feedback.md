# Processing Feedback — Implementation Plan

> **SHIPPED 16 Sep 2026.** All ten tasks done; device-verified on the Pixel 7 Pro (spec §"Device verification"). Three defects the phone found are fixed in-branch.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A processing screen whose ETA is learned from this phone and whose long stages visibly move; a pipeline that pauses and says so when the phone is too hot or the battery too low; and a way into the action tracker that already exists.

**Architecture:** The C++ core's per-window ASR progress/abort callbacks and sherpa's per-chunk diarization callback are wired through JNI to a Kotlin `StageProgress` callback; `ProcessingEngine` forwards counts as the existing `onStage` event, waits out a thermal/battery pause inside the same callback, and persists each stage's measured realtime rate in `settings`. `progressFor` (JS, pure) prices the wait from those rates and the running stage's fraction. The Library renders the action tally it already computes.

**Tech Stack:** C++ (JNI), Kotlin (engine, service, pure rule objects with JUnit), TypeScript/React Native (jest + react-test-renderer), the existing bridge events.

Spec: `docs/superpowers/specs/2026-09-16-processing-feedback-design.md`.

**House rule:** every new test is mutation-checked — break the thing it names, watch it fail, restore. A test that cannot fail against its defect is itself a defect.

---

## File map

| File | Responsibility |
|---|---|
| `android/.../pipeline/StageRates.kt` (new) | Pure: the blend and the guards for a stage's learned rate. |
| `android/.../pipeline/ProcessingBudget.kt` (new) | Pure: when post-hoc processing pauses and when a pause lifts. |
| `android/.../pipeline/NativeBridge.kt` | `StageProgress` fun interface; new trailing param on `nativeTranscribe` / `nativeDiarize`. |
| `cpp/jni/audionotes_jni.cpp` | Wrap the Kotlin callback as `AsrProgressFn`/`AsrCancelFn` and as the diarizer's progress. |
| `cpp/diar/diarizer.{h,cpp}` | `setProgress(DiarProgressFn)`; `diarize()` uses `ProcessWithCallback`. |
| `cpp/pipeline/pipeline.cpp` | Wire diarize progress to `report("diarize", …)` (CLI shows it; proves the callback). |
| `android/.../pipeline/ProcessingEngine.kt` | Forward counts; wait out pauses; persist rates; `Listener.onPause`. |
| `android/.../pipeline/ProcessingService.kt` | Notification line while paused; `emitPause`. |
| `android/.../pipeline/AudioPipelineBridge.kt` | `emitPause(meetingId, reason)` → `onProcessingPause`. |
| `android/.../data/AudioDb.kt` | `stageRate` / `setStageRate`. |
| `src/db/queries.ts` | `stageRates()`. |
| `src/screens/progress.ts` | `progressFor` takes `rates` and `fraction`. |
| `src/pipeline/PipelineController.ts` | `onPause(cb)`; `pausedReason(meetingId)`. |
| `src/screens/MeetingScreen.tsx` | Rates read; "14 of 40"; paused line, ETA hidden. |
| `src/screens/LibraryScreen.tsx` | Actions card + header icon; PAUSED badge. |
| Tests | `StageRatesTest.kt`, `ProcessingBudgetTest.kt`, `progress.test.ts`, `MeetingScreen.test.tsx`, `LibraryScreen.test.tsx`. |

---

### Task 1: StageRates — the learned rate, pure

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/StageRates.kt`
- Create: `android/app/src/test/java/com/innocorelabs/verbale/pipeline/StageRatesTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The rate a stage leaves behind for the next ETA. The defect it guards: an ETA priced from one
 * Pixel's constants on every phone, and — once rates are learned — one odd run (a hot phone, a
 * live-pass cache that skipped most of ASR, a 10-second test recording) owning the number.
 */
class StageRatesTest {
  @Test fun theFirstRunIsTakenAsIs() {
    assertEquals(0.40, StageRates.next(previous = null, measured = 0.40, audioMs = 300_000L)!!, 1e-9)
  }

  @Test fun aLaterRunIsBlendedTowardsTheNewNumber() {
    // 0.7 × 0.20 + 0.3 × 0.40 = 0.26
    assertEquals(0.26, StageRates.next(previous = 0.40, measured = 0.20, audioMs = 300_000L)!!, 1e-9)
  }

  @Test fun aRecordingUnderThirtySecondsTeachesNothing() {
    assertNull(StageRates.next(previous = 0.40, measured = 0.05, audioMs = 29_999L))
    assertEquals(0.40, StageRates.next(previous = null, measured = 0.40, audioMs = 30_000L)!!, 1e-9)
  }

  @Test fun aNonsenseMeasurementTeachesNothing() {
    assertNull(StageRates.next(previous = 0.40, measured = 0.0, audioMs = 300_000L))
    assertNull(StageRates.next(previous = 0.40, measured = Double.NaN, audioMs = 300_000L))
    assertNull(StageRates.next(previous = 0.40, measured = Double.POSITIVE_INFINITY, audioMs = 300_000L))
  }

  @Test fun aBrokenStoredValueIsReplacedNotBlended() {
    assertEquals(0.20, StageRates.next(previous = -1.0, measured = 0.20, audioMs = 300_000L)!!, 1e-9)
  }

  @Test fun theKeyIsNamespacedSoTheQueryCanFindEveryStageAtOnce() {
    assertEquals("rate.asr", StageRates.key("asr"))
  }
}
```

- [ ] **Step 2: Run it — expect compile failure**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*StageRatesTest*' -q 2>&1 | grep -E "^e:" | head -3`
Expected: `Unresolved reference 'StageRates'`.

- [ ] **Step 3: Implement**

```kotlin
package com.innocorelabs.verbale.pipeline

/**
 * What a finished stage teaches the ETA about this phone.
 *
 * The screen prices the wait from seconds-of-work per second-of-audio. Those numbers shipped as
 * one Pixel's measurements; here each phone learns its own, one stage at a time, in `settings`
 * under [key]. Blended rather than replaced so one odd run — a hot phone, a live-pass cache
 * that skipped most of ASR — moves the number rather than owning it.
 */
object StageRates {
  /** Under this, the stage was over before it could be timed. */
  const val MIN_AUDIO_MS = 30_000L

  /** How much of the new number survives the blend. */
  const val WEIGHT_NEW = 0.7

  fun key(stage: String): String = "rate.$stage"

  /**
   * The value to store, or null when this run says nothing worth keeping. [measured] is
   * stage milliseconds over audio milliseconds; [previous] is what `settings` holds, if anything.
   */
  fun next(previous: Double?, measured: Double, audioMs: Long): Double? {
    if (audioMs < MIN_AUDIO_MS) return null
    if (measured.isNaN() || measured.isInfinite() || measured <= 0.0) return null
    val usable = previous != null && !previous.isNaN() && !previous.isInfinite() && previous > 0.0
    return if (usable) WEIGHT_NEW * measured + (1.0 - WEIGHT_NEW) * previous!! else measured
  }
}
```

- [ ] **Step 4: Run — expect 6 passed**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*StageRatesTest*' 2>&1 | grep -E "FAILED|BUILD"`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Mutation-check** — change `WEIGHT_NEW` to `0.5`: `aLaterRunIsBlended…` fails. Change `MIN_AUDIO_MS` to `0`: `aRecordingUnderThirtySeconds…` fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/StageRates.kt android/app/src/test/java/com/innocorelabs/verbale/pipeline/StageRatesTest.kt
git commit -m "feat(eta): StageRates — what a finished stage teaches this phone"
```

---

### Task 2: Persist the rates from the engine; read them from JS

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt` (next to `putSetting`, ~line 545)
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt:80-85` (`stageDone`)
- Modify: `src/db/queries.ts` (next to `getSetting`, ~line 392)
- Test: `src/db/__tests__/schema.test.ts` is untouched — no schema change (`settings` exists).

- [ ] **Step 1: AudioDb accessors**

```kotlin
  /** The learned realtime rate for a stage, or null when this phone has not run it yet. */
  fun stageRate(stage: String): Double? = getSetting(StageRates.key(stage))?.toDoubleOrNull()

  fun setStageRate(stage: String, rate: Double) = putSetting(StageRates.key(stage), rate.toString())
```

(`StageRates` is in `com.innocorelabs.verbale.pipeline`; add the import.)

- [ ] **Step 2: Engine writes after each timed stage.** Replace `stageDone` in `ProcessingEngine.run()`:

```kotlin
      fun stageDone(stage: String, startedAt: Long) {
        val ms = System.currentTimeMillis() - startedAt
        val rt = if (audioMs > 0) ms.toDouble() / audioMs else 0.0
        Log.i(TAG, "stage=%s %dms (%.2fx realtime) audio=%ds %s"
          .format(stage, ms, rt, audioMs / 1000, meetingId))
        // What this phone learns for the next ETA. Never on a cancelled stage: a run cut short
        // measures the cut, not the stage.
        if (!cancelled) {
          StageRates.next(db.stageRate(stage), rt, audioMs)?.let { db.setStageRate(stage, it) }
        }
      }
```

`stageDone` is already called for `vad`, `asr`, `diarize`, `narrate`. Add one for minutes: wrap the minutes block — `val tMin = System.currentTimeMillis()` before `listener.onStage("minutes", 0, 1)` and `stageDone("minutes", tMin)` right after `retitleFromTranscript(meetingId, utts)`.

- [ ] **Step 3: JS reader.** In `src/db/queries.ts` after `setSetting`:

```ts
  /**
   * The realtime rates this phone has learned, keyed by stage ('vad' | 'asr' | …). Missing
   * stages have never run here; progress.ts falls back to the shipped constants for those.
   */
  stageRates: () =>
    run<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'rate.%'").then(
      rows => {
        const out: Record<string, number> = {};
        for (const r of rows) {
          const n = Number(r.value);
          if (Number.isFinite(n) && n > 0) out[r.key.slice('rate.'.length)] = n;
        }
        return out;
      },
    ),
```

- [ ] **Step 4: Type-check and Kotlin compile**

Run: `npx tsc --noEmit && (cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 | grep -E "^e:" | head -3)`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt src/db/queries.ts
git commit -m "feat(eta): each timed stage leaves its rate in settings; JS can read them"
```

---

### Task 3: progressFor — rates and fraction

**Files:**
- Modify: `src/screens/progress.ts`
- Test: `src/screens/__tests__/progress.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `progress.test.ts`)

```ts
describe('rates learned on this phone', () => {
  const base = { liveStage: 'asr', status: 'vad', audioSec: 600 };

  it('prices from the learned rate when there is one', () => {
    const shipped = progressFor({ ...base, rates: {}, fraction: 0 });
    const learned = progressFor({ ...base, rates: { asr: 0.1 }, fraction: 0 });
    // ASR at 0.1x instead of 0.34x on a 10-minute recording: 144 s less to wait.
    expect(shipped.etaSec - learned.etaSec).toBe(Math.round(0.24 * 600));
  });

  it('falls back to the shipped constant for a stage this phone has not run', () => {
    const shipped = progressFor({ ...base, rates: {}, fraction: 0 });
    const partial = progressFor({ ...base, rates: { narrate: 0.5 }, fraction: 0 });
    expect(partial.etaSec).toBeGreaterThan(shipped.etaSec); // only narrate moved
    expect(partial.etaSec - shipped.etaSec).toBe(Math.round((0.5 - 0.32) * 600));
  });
});

describe('progress inside the running stage', () => {
  const base = { liveStage: 'asr', status: 'vad', audioSec: 600, rates: {} };

  it('prices a stage that has reported counts by how far it is', () => {
    const start = progressFor({ ...base, fraction: 0 });
    const half = progressFor({ ...base, fraction: 0.5 });
    const done = progressFor({ ...base, fraction: 1 });
    expect(start.etaSec).toBeGreaterThan(half.etaSec);
    expect(half.etaSec).toBeGreaterThan(done.etaSec);
    // 40 of 40 windows: the stage is priced as finished, nothing of it remains.
    expect(done.etaSec).toBe(start.etaSec - Math.round(0.34 * 600));
    expect(done.pct).toBeGreaterThan(half.pct);
  });

  it('guesses 40% for a stage that has only said it started', () => {
    // undefined fraction = no counts yet; must equal the old behaviour exactly.
    const guessed = progressFor({ ...base, fraction: undefined });
    const explicit = progressFor({ ...base, fraction: 0.4 });
    expect(guessed).toEqual(explicit);
  });

  it('never claims 100% while a stage is still running', () => {
    expect(progressFor({ liveStage: 'narrate', status: 'diarized', audioSec: 600, rates: {}, fraction: 1 }).pct).toBeLessThanOrEqual(99);
  });
});
```

- [ ] **Step 2: Run — expect type errors** (`rates` / `fraction` not on `ProgressInput`)

Run: `npx jest src/screens/__tests__/progress.test.ts 2>&1 | grep -E "error TS|✕|Tests:" | head -5`

- [ ] **Step 3: Implement.** In `progress.ts`:

```ts
export interface ProgressInput {
  liveStage: string | null;
  status: string | null | undefined;
  audioSec: number;
  /**
   * Seconds of work per second of audio, as this phone has measured them (db.stageRates()).
   * A stage missing here falls back to the shipped constant, which is one Pixel's number.
   */
  rates?: Partial<Record<string, number>>;
  /**
   * How far the running stage is, 0..1, from its own counts (ASR windows, diarization chunks,
   * narrator steps). undefined when the stage has only said it started.
   */
  fraction?: number;
}

/** A stage's rate on this phone, or the shipped one. */
export function rateFor(stage: Stage, rates?: Partial<Record<string, number>>): number {
  const learned = rates?.[stage.key];
  return typeof learned === 'number' && Number.isFinite(learned) && learned > 0 ? learned : stage.rate;
}

/** A stage that reports only that it started is treated as 40% through. */
const RUNNING_GUESS = 0.4;

export function progressFor({ liveStage, status, audioSec, rates, fraction }: ProgressInput): Progress {
  const key = liveStage ?? stageFromStatus(status);
  const found = STAGES.findIndex(x => x.key === key);
  const index = found < 0 ? 0 : found;
  const through = typeof fraction === 'number' ? Math.min(1, Math.max(0, fraction)) : RUNNING_GUESS;

  const rate = (s: Stage) => rateFor(s, rates);
  const total = STAGES.reduce((a, x) => a + rate(x), 0);
  const doneRate = STAGES.slice(0, index).reduce((a, x) => a + rate(x), 0);
  const runningRate = rate(STAGES[index]);
  const pct = Math.min(99, Math.round(((doneRate + runningRate * through) / total) * 100));

  // Remaining work priced from the recording's own length rather than from elapsed time, which is
  // what made a transcript-only re-run promise a finish it was nowhere near.
  const remainingRate = STAGES.slice(index).reduce((a, x) => a + rate(x), 0) - runningRate * through;
  const etaSec = audioSec > 0 ? Math.max(1, Math.round(remainingRate * audioSec)) : 0;

  return { index, pct, etaSec };
}
```

Delete the old body's `TOTAL_RATE` constant and `RUNNING` local (both replaced above).

- [ ] **Step 4: Run — all of progress.test.ts passes** (`npx jest src/screens/__tests__/progress.test.ts`)

- [ ] **Step 5: Mutation-check** — make `rateFor` return `stage.rate` unconditionally: both "learned rate" tests fail. Make `through` ignore `fraction` (always `RUNNING_GUESS`): the counts test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/screens/progress.ts src/screens/__tests__/progress.test.ts
git commit -m "feat(eta): progressFor prices from this phone's rates and the running stage's own counts"
```

---

### Task 4: The screen — rates, counts, "14 of 40"

**Files:**
- Modify: `src/screens/MeetingScreen.tsx` (~85 state; ~245 `refresh`; ~322 progress listener; ~797 progressFor; ~870 stage row)
- Test: `src/screens/__tests__/MeetingScreen.test.tsx`

- [ ] **Step 0: Make native events drivable under jest.** `jest.setup.js` mocks `NativeEventEmitter` as a no-op (listeners are dropped), so no screen test can receive a pipeline event today. Replace the mock with one that keeps listeners and exposes an emitter:

```js
jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () => {
  // One registry for every instance: PipelineController's emitter is built at import time and
  // AudioPipeline.addListener callers build their own, and a test wants to reach all of them.
  const listeners = new Map();
  class MockNativeEventEmitter {
    addListener(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return { remove: () => listeners.get(name)?.delete(cb) };
    }
    removeAllListeners(name) { listeners.delete(name); }
    emit(name, payload) { for (const cb of listeners.get(name) ?? []) cb(payload); }
  }
  global.__TEST_EMIT__ = (name, payload) => new MockNativeEventEmitter().emit(name, payload);
  return { __esModule: true, default: MockNativeEventEmitter };
});
```

In the screen tests: `const emit = (name: string, payload: unknown) => (global as any).__TEST_EMIT__(name, payload);`. Run the whole jest suite once after this change — every existing test must still pass (they never relied on events arriving).

- [ ] **Step 1: Failing test** (append; the file's `render()` helper and mocks exist — add `(db.stageRates as jest.Mock).mockResolvedValue({})` to the `beforeEach` that sets up the other `db.*` mocks, and `stageRates` to the mocked-queries list if the auto-mock needs it)

```ts
describe('progress inside a stage', () => {
  it('shows the running stage\'s own counts and prices the wait from them', async () => {
    (db.getMeeting as jest.Mock).mockResolvedValue({ ...meeting, status: 'vad', durationMs: 600_000 });
    const tree = await render();
    const before = JSON.stringify(tree.toJSON());
    await act(async () => {
      emit('onStageProgress', { meetingId: 'm1', stage: 'asr', chunk: 14, total: 40 });
    });
    const after = JSON.stringify(tree.toJSON());
    expect(after).toContain('14 of 40');
    expect(after).not.toEqual(before);
  });
});
```


- [ ] **Step 2: Run — fails** (`14 of 40` absent).

- [ ] **Step 3: Implement**

State: replace `const [stage, setStage] = useState<string | null>(null);` with

```ts
  const [stage, setStage] = useState<string | null>(null);
  /** The running stage's own counts, when it reports them; null after a stage change. */
  const [counts, setCounts] = useState<{ done: number; total: number } | null>(null);
  const [rates, setRates] = useState<Partial<Record<string, number>>>({});
```

In the progress listener:

```ts
    const offProgress = PipelineController.onProgress(p => {
      if (p.meetingId !== meetingId) return;
      setStage(p.stage);
      // 0/1 and 1/1 are "started" and "finished", not counts; only a total above 1 is progress.
      setCounts(p.total > 1 ? { done: p.chunk, total: p.total } : null);
    });
```

In `refresh` (where `db.getMeeting` and the others are fetched in `Promise.all`), add `db.stageRates().catch(() => ({}))` and `setRates(...)` from its result.

Where `progressFor` is called:

```ts
    const { index: idx, pct, etaSec: eta } = progressFor({
      liveStage: stage,
      status: meeting?.status,
      audioSec: (meeting?.durationMs ?? 0) / 1000,
      rates,
      fraction: counts ? counts.done / counts.total : undefined,
    });
```

In the stage row's label `Txt`, after `{x.label}`:

```tsx
                          {x.label}
                          {state === 'active' && counts ? ` · ${counts.done} of ${counts.total}` : ''}
```

- [ ] **Step 4: Run the screen tests** — `npx jest src/screens/__tests__/MeetingScreen.test.tsx` passes; `npx tsc --noEmit` clean.

- [ ] **Step 5: Mutation-check** — drop `fraction:` from the `progressFor` call: the new test still passes on the label alone, so ALSO assert the ETA moved: capture the pct pill text before/after (`expect(after).not.toEqual(before)` covers it only if nothing else re-rendered — make the assertion specific: find the `Txt` whose children include `%` and compare its text). Restore.

- [ ] **Step 6: Commit**

```bash
git add src/screens/MeetingScreen.tsx src/screens/__tests__/MeetingScreen.test.tsx
git commit -m "feat(eta): the processing screen reads this phone's rates and the stage's own counts"
```

---

### Task 5: The native progress callback (ASR + diarization)

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt:118-133` and `:139-160`
- Modify: `cpp/jni/audionotes_jni.cpp` (`nativeTranscribe` ~309, `nativeDiarize` ~481)
- Modify: `cpp/diar/diarizer.h`, `cpp/diar/diarizer.cpp` (`Impl::diarize`, ~192)
- Modify: `cpp/pipeline/pipeline.cpp:177-188`
- Test: CLI run (the pipeline already prints `[stage] done/total`); device (Task 9).

- [ ] **Step 1: Kotlin side.** In `NativeBridge`:

```kotlin
  /**
   * Called on the native thread between units of work — after each ASR window, each diarization
   * chunk. Return false to abort (ASR honours it before the next window; sherpa's diarizer
   * ignores it, so a diarize abort lands at the stage boundary). The callback may block: that is
   * how a thermal pause holds the pipeline without losing the unit in flight.
   */
  fun interface StageProgress { fun onProgress(done: Int, total: Int): Boolean }
```

Add a trailing parameter to both externals: `progress: StageProgress? = null,` — last, after `cachedWindowsJson` on `nativeTranscribe` and after `windowMs` on `nativeDiarize`. Every existing caller compiles unchanged.

- [ ] **Step 2: JNI helper** (near the top of `audionotes_jni.cpp`, after `jstr`):

```cpp
// A Kotlin NativeBridge.StageProgress, callable from the thread that entered JNI. `env` is that
// thread's and stays valid for the whole synchronous call the callback rides inside.
struct JProgress {
  JNIEnv* env = nullptr;
  jobject obj = nullptr;
  jmethodID mid = nullptr;
  bool aborted = false;

  JProgress(JNIEnv* e, jobject o) : env(e), obj(o) {
    if (!obj) return;
    jclass cls = env->GetObjectClass(obj);
    mid = cls ? env->GetMethodID(cls, "onProgress", "(II)Z") : nullptr;
    if (cls) env->DeleteLocalRef(cls);
    if (!mid) { env->ExceptionClear(); obj = nullptr; }
  }
  // Reports, and remembers a request to stop. An exception thrown by the callback counts as one.
  void call(int done, int total) {
    if (!obj) return;
    const jboolean go = env->CallBooleanMethod(obj, mid, static_cast<jint>(done), static_cast<jint>(total));
    if (env->ExceptionCheck()) { env->ExceptionClear(); aborted = true; return; }
    if (!go) aborted = true;
  }
};
```

- [ ] **Step 3: nativeTranscribe.** Add `jobject jProgress` as the last parameter of the JNI function signature (after `jobjectArray jCachedJson`). Replace the `transcribe` call:

```cpp
    JProgress jp(env, jProgress);
    const audionotes::AsrProgressFn progress = [&jp](int done, int total) { jp.call(done, total); };
    const audionotes::AsrCancelFn cancel = [&jp]() { return jp.aborted; };
    audionotes::AsrRun run = asr->transcribe(pcm, segs, static_cast<int>(sampleRate),
                                             static_cast<int>(threads), progress, cancel);
```

(`run.utterances` after an abort holds what was decoded so far — the Kotlin side must not persist it; Task 6 Step 3.)

- [ ] **Step 4: Diarizer progress.** In `diarizer.h`, before `class Diarizer`:

```cpp
// done/total chunks, from inside sherpa's process call, on the calling thread.
using DiarProgressFn = std::function<void(int, int)>;
```

and a public method `void setProgress(DiarProgressFn fn);`. In `diarizer.cpp`, `Impl` gains `DiarProgressFn progress;` and a trampoline; `diarize()` becomes:

```cpp
  static int32_t onProgress(int32_t done, int32_t total, void* arg) {
    auto* self = static_cast<Impl*>(arg);
    if (self && self->progress) self->progress(static_cast<int>(done), static_cast<int>(total));
    return 0;  // ignored by sherpa; documented as such in c-api.h
  }

  std::vector<DiarSegment> diarize(const std::vector<float>& samples) {
    std::vector<DiarSegment> out;
    const SherpaOnnxOfflineSpeakerDiarizationResult* result =
        progress ? SherpaOnnxOfflineSpeakerDiarizationProcessWithCallback(
                       sd, samples.data(), static_cast<int32_t>(samples.size()), &Impl::onProgress, this)
                 : SherpaOnnxOfflineSpeakerDiarizationProcess(sd, samples.data(),
                                                              static_cast<int32_t>(samples.size()));
    // … the rest unchanged
```

`Diarizer::setProgress(DiarProgressFn fn) { impl_->progress = std::move(fn); }` (guard `impl_` null as the other methods do).

- [ ] **Step 5: nativeDiarize.** Add `jobject jProgress` last; after constructing `diar`:

```cpp
    JProgress jp(env, jProgress);
    diar.setProgress([&jp](int done, int total) { jp.call(done, total); });
```

- [ ] **Step 6: Pipeline (CLI proof).** In `pipeline.cpp` after the `Diarizer d(...)` construction: `d.setProgress([&report](int done, int total) { report("diarize", done, total); });` — the CLI's `[diarize] k/n` lines are the proof the sherpa callback fires per chunk.

- [ ] **Step 7: Build both sides**

Run: `CMAKE=$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake; $CMAKE --build cpp/cli/build -j 8 2>&1 | grep -E "error|warning: unused" | head; (cd cpp/cli/build && ./ctest --output-on-failure 2>&1 | tail -3)`
Expected: builds; all C++ tests still pass (the core's outputs did not change).

Run: `npm run -s apk 2>&1 | grep -E "^e:|error:|BUILD" | head -5`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 8: CLI proof** (models under the scratchpad `models/` dir from the earlier sessions):

Run: `cpp/cli/build/an_process <whisper.bin> <a 60 s wav> --vad <silero.onnx> --diar-seg <seg.onnx> --diar-emb <emb.onnx> 2>&1 | grep -E "^\[(asr|diarize)\]" | head`
Expected: `[asr] 1/2`, `[asr] 2/2`, `[diarize] k/n` lines with n > 1.

- [ ] **Step 9: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt cpp/jni/audionotes_jni.cpp cpp/diar/diarizer.h cpp/diar/diarizer.cpp cpp/pipeline/pipeline.cpp
git commit -m "feat(eta): ASR windows and diarization chunks report through JNI; ASR can abort between windows"
```

---

### Task 6: ProcessingBudget — the pause rule, pure

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingBudget.kt`
- Create: `android/app/src/test/java/com/innocorelabs/verbale/pipeline/ProcessingBudgetTest.kt`

- [ ] **Step 1: Failing test**

```kotlin
package com.innocorelabs.verbale.pipeline

import android.os.PowerManager
import com.innocorelabs.verbale.pipeline.ProcessingBudget.PauseReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * When post-hoc processing stops to let the phone recover, and when it may go on. The defects
 * it guards: pausing at MODERATE (the Pixel's ordinary state on a desk while charging — the
 * LiveBudget lesson), and a battery pause that flaps at the line.
 */
class ProcessingBudgetTest {
  private fun why(thermal: Int, battery: Int, charging: Boolean, paused: PauseReason? = null) =
    ProcessingBudget.reasonToPause(thermal, battery, charging, paused)

  @Test fun severeHeatPausesAndModerateDoesNot() {
    assertEquals(PauseReason.HEAT, why(PowerManager.THERMAL_STATUS_SEVERE, 80, true))
    assertNull(why(PowerManager.THERMAL_STATUS_MODERATE, 80, true))
    assertNull(why(PowerManager.THERMAL_STATUS_LIGHT, 80, false))
  }

  @Test fun aHeatPauseLiftsAtModerate() {
    assertEquals(PauseReason.HEAT, why(PowerManager.THERMAL_STATUS_SEVERE, 80, true, paused = PauseReason.HEAT))
    assertNull(why(PowerManager.THERMAL_STATUS_MODERATE, 80, true, paused = PauseReason.HEAT))
  }

  @Test fun aFlatBatteryPausesOnlyWhenUnplugged() {
    assertEquals(PauseReason.BATTERY, why(PowerManager.THERMAL_STATUS_NONE, 14, false))
    assertNull(why(PowerManager.THERMAL_STATUS_NONE, 14, true))
    assertNull(why(PowerManager.THERMAL_STATUS_NONE, 15, false))
  }

  @Test fun aBatteryPauseHoldsUntilTwentyPercentOrACharger() {
    assertEquals(PauseReason.BATTERY, why(PowerManager.THERMAL_STATUS_NONE, 17, false, paused = PauseReason.BATTERY))
    assertNull(why(PowerManager.THERMAL_STATUS_NONE, 20, false, paused = PauseReason.BATTERY))
    assertNull(why(PowerManager.THERMAL_STATUS_NONE, 17, true, paused = PauseReason.BATTERY))
  }

  @Test fun heatOutranksBattery() {
    assertEquals(PauseReason.HEAT, why(PowerManager.THERMAL_STATUS_CRITICAL, 5, false))
  }
}
```

- [ ] **Step 2: Run — `Unresolved reference 'ProcessingBudget'`.**

- [ ] **Step 3: Implement**

```kotlin
package com.innocorelabs.verbale.pipeline

import android.os.PowerManager

/**
 * Whether post-hoc processing should stop for a while.
 *
 * Sibling of [LiveBudget], which asks the same question of the live pass and answers "back off"
 * — a cache can be skipped. The post-hoc pipeline cannot: it pauses between units of work and
 * carries on when the phone has recovered. Every threshold is one phone's first guess; each
 * pause and resume is logged with its numbers (ProcessingEngine) so the next phone can argue.
 */
object ProcessingBudget {
  /** Unplugged and below this, stop; the phone needs what is left more than the notes do. */
  const val PAUSE_BATTERY_BELOW = 15
  /** …and do not start again until here, so the line is not crossed twice a minute. */
  const val RESUME_BATTERY_AT = 20
  /** How often a paused pipeline asks again. */
  const val POLL_MS = 5_000L

  enum class PauseReason { HEAT, BATTERY }

  /**
   * Why to be paused now, or null to run. [paused] is the reason currently in force, which is
   * what makes the battery band a band; heat has no band because SEVERE and MODERATE are
   * adjacent statuses. SEVERE, never MODERATE: a Pixel reads MODERATE on a desk while charging.
   */
  fun reasonToPause(thermal: Int, batteryPercent: Int, charging: Boolean, paused: PauseReason?): PauseReason? {
    if (thermal >= PowerManager.THERMAL_STATUS_SEVERE) return PauseReason.HEAT
    val floor = if (paused == PauseReason.BATTERY) RESUME_BATTERY_AT else PAUSE_BATTERY_BELOW
    if (!charging && batteryPercent < floor) return PauseReason.BATTERY
    return null
  }
}
```

- [ ] **Step 4: Run — 5 passed.** Mutation-check: `>= SEVERE` → `>= MODERATE`: the first test fails. Drop the `paused` branch (always `PAUSE_BATTERY_BELOW`): the hold test fails. Restore.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingBudget.kt android/app/src/test/java/com/innocorelabs/verbale/pipeline/ProcessingBudgetTest.kt
git commit -m "feat(thermal): ProcessingBudget — pause at SEVERE or a flat unplugged battery, with a band"
```

---

### Task 7: The engine pauses, forwards counts, and never persists an aborted ASR

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt`
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingService.kt:96-104`, `:207` (`stageLabel`)
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/AudioPipelineBridge.kt`

- [ ] **Step 1: Listener gains `onPause`** (default body, so nothing else must change):

```kotlin
  interface Listener {
    fun onStage(stage: String, done: Int, total: Int)
    fun onComplete(outcome: String, message: String? = null) // "done" | "cancelled" | "error"
    /** A pause began ([reason] non-null) or ended (null). Only ever sent on a change. */
    fun onPause(reason: ProcessingBudget.PauseReason?) {}
  }
```

- [ ] **Step 2: The wait and the callback** (private members of `ProcessingEngine`):

```kotlin
  /** Blocks while the phone is too hot or too flat, announcing the pause and the resume once each. */
  private fun awaitClearance() {
    var reason = reasonToPause(null) ?: return
    Log.i(TAG, "pause $reason: ${budgetLine()} $meetingId")
    listener.onPause(reason)
    while (!cancelled) {
      Thread.sleep(ProcessingBudget.POLL_MS)
      reason = reasonToPause(reason) ?: break
    }
    Log.i(TAG, "resume: ${budgetLine()} $meetingId")
    listener.onPause(null)
  }

  private fun reasonToPause(current: ProcessingBudget.PauseReason?) = ProcessingBudget.reasonToPause(
    LiveBudget.thermalStatus(ctx), LiveBudget.batteryPercent(ctx), LiveBudget.isCharging(ctx), current,
  )

  private fun budgetLine() =
    "thermal=${LiveBudget.thermalStatus(ctx)} battery=${LiveBudget.batteryPercent(ctx)} charging=${LiveBudget.isCharging(ctx)}"

  /** Between units of work inside a native stage: report, wait out a pause, say whether to go on. */
  private fun progressFor(stage: String) = NativeBridge.StageProgress { done, total ->
    listener.onStage(stage, done, total)
    awaitClearance()
    !cancelled
  }
```

- [ ] **Step 3: Wire it.**
  - `nativeTranscribe(..., cachedRanges, cachedJson, progressFor("asr"))`.
  - Immediately after `nativeTranscribe` returns, BEFORE `org.json.JSONObject(json)`:
    ```kotlin
          // An abort between windows returns the windows decoded so far. Persisting them would
          // leave `status = asr` over a partial transcript, and the next run's ResumePlan would
          // skip ASR and build minutes on half a meeting. Cancelled means nothing is written.
          if (checkCancelled()) return
    ```
  - `nativeDiarize(..., spans, windowMs, progressFor("diarize"))`.
  - The narrator's `Progress.onStage` override: `listener.onStage(stage, done, total); awaitClearance()`.
  - `awaitClearance()` as the first line inside each stage block: the `if (Stage.VAD in remaining …)` body, the ASR body, the diarize body, before `listener.onStage("minutes", 0, 1)`, and inside `if (Stage.NARRATE in remaining)`.

- [ ] **Step 4: Service and bridge.** In `AudioPipelineBridge`:

```kotlin
  fun emitPause(meetingId: String, reason: String?) {
    val m = Arguments.createMap().apply {
      putString("meetingId", meetingId); if (reason != null) putString("reason", reason) else putNull("reason")
    }
    emit("onProcessingPause", m)
  }
```

In `ProcessingService`'s listener object:

```kotlin
            override fun onPause(reason: ProcessingBudget.PauseReason?) {
              try { updateNotification(if (reason == null) LABEL_TRANSCRIBING else pauseLabel(reason)) } catch (_: Exception) {}
              AudioPipelineBridge.emitPause(id, reason?.name?.lowercase())
            }
```

and next to `stageLabel`:

```kotlin
  private fun pauseLabel(reason: ProcessingBudget.PauseReason) = when (reason) {
    ProcessingBudget.PauseReason.HEAT -> "Paused to let the phone cool — it resumes on its own."
    ProcessingBudget.PauseReason.BATTERY -> "Paused until the phone is charging or has more battery."
  }
```

- [ ] **Step 5: Compile** — `cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 | grep -E "^e:" | head -3` → none. Run the Kotlin unit tests: `./gradlew :app:testDebugUnitTest -q` → pass.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingService.kt android/app/src/main/java/com/innocorelabs/verbale/pipeline/AudioPipelineBridge.kt
git commit -m "feat(thermal): the engine pauses between units of work, says so, and never persists an aborted ASR"
```

---

### Task 8: The pause on screen — Meeting and Library

**Files:**
- Modify: `src/pipeline/PipelineController.ts` (~399, next to `onProgress`)
- Modify: `src/native/NativeAudioPipeline.ts` (events comment, ~76)
- Modify: `src/screens/MeetingScreen.tsx` (processing branch, ~797-833)
- Modify: `src/screens/LibraryScreen.tsx` (`statusOf` ~42; card badge)
- Test: `src/screens/__tests__/MeetingScreen.test.tsx`, `src/screens/__tests__/LibraryScreen.test.tsx`

- [ ] **Step 1: Controller.**

```ts
export type PauseReason = 'heat' | 'battery';

  /** Why processing is paused for a meeting right now, or undefined. Kept so a screen that
   *  mounts mid-pause can say so without waiting for the next event. */
  private paused = new Map<string, PauseReason>();

  pausedReason(meetingId: string): PauseReason | undefined { return this.paused.get(meetingId); }

  onPause(cb: (e: { meetingId: string; reason: PauseReason | null }) => void): () => void {
    const s = this.emitter.addListener('onProcessingPause', cb);
    this.subs.push(s);
    return () => s.remove();
  }
```

In the controller's constructor (where it already subscribes to its own events, or add one): `this.emitter.addListener('onProcessingPause', e => { if (e.reason) this.paused.set(e.meetingId, e.reason); else this.paused.delete(e.meetingId); });` and clear the entry in the existing `onStageComplete`/`onError` handling.

- [ ] **Step 2: Failing tests.** MeetingScreen:

```ts
  it('says why it is paused and hides the ETA until it resumes', async () => {
    (db.getMeeting as jest.Mock).mockResolvedValue({ ...meeting, status: 'vad', durationMs: 600_000 });
    const tree = await render();
    await act(async () => { emit('onProcessingPause', { meetingId: 'm1', reason: 'heat' }); });
    let text = JSON.stringify(tree.toJSON());
    expect(text).toContain('Paused to let the phone cool');
    expect(text).not.toContain('min left');
    await act(async () => { emit('onProcessingPause', { meetingId: 'm1', reason: null }); });
    text = JSON.stringify(tree.toJSON());
    expect(text).not.toContain('Paused');
    expect(text).toContain('min left');
  });
```

LibraryScreen (in its existing test file, using its existing render helper and meeting fixtures — one meeting with `status: 'vad'`):

```ts
  it('badges a paused meeting PAUSED and returns it to TRANSCRIBING on resume', async () => {
    const tree = await render();
    await act(async () => { emit('onProcessingPause', { meetingId: 'm1', reason: 'battery' }); });
    expect(JSON.stringify(tree.toJSON())).toContain('PAUSED');
    await act(async () => { emit('onProcessingPause', { meetingId: 'm1', reason: null }); });
    expect(JSON.stringify(tree.toJSON())).toContain('TRANSCRIBING');
  });
```

(`emit` = the `__TEST_EMIT__` helper from Task 4 Step 0.)

- [ ] **Step 3: MeetingScreen.** State `const [paused, setPaused] = useState<PauseReason | null>(PipelineController.pausedReason(meetingId) ?? null);`; subscribe next to `onProgress`:

```ts
    const offPause = PipelineController.onPause(e => { if (e.meetingId === meetingId) setPaused(e.reason); });
```

(and `offPause()` in the cleanup). In the processing branch:

```tsx
            <Txt variant="display" style={st.procTitle}>
              {paused ? 'Paused for a moment' : 'Writing your notes…'}
            </Txt>
            <Txt variant="sub" color={colors.inkDim} style={st.procBody}>
              {paused === 'heat'
                ? 'Paused to let the phone cool — it resumes on its own.'
                : paused === 'battery'
                  ? 'Paused until the phone is charging or has more battery.'
                  : 'All the thinking happens on your phone, so it takes a moment.'}
            </Txt>
            <View style={st.pctPill}>
              <Txt variant="metaBlack" color={colors.primary}>
                {pct}%{paused ? '' : etaLabel(eta)}
              </Txt>
            </View>
```

and the active row's `Spinner` renders only when `!paused` (a still `checkDot` in `colors.warningSoft` otherwise).

- [ ] **Step 4: LibraryScreen.** State `const [pausedIds, setPausedIds] = useState<Set<string>>(new Set());` subscribed in a `useEffect` to `PipelineController.onPause` (add/delete by reason). Where the card computes `statusOf(m.status, colors)`, wrap: `pausedIds.has(m.id) ? { label: 'PAUSED', color: colors.warning, soft: colors.warningSoft, live: true } : statusOf(m.status, colors)`.

- [ ] **Step 5: Run both test files; tsc clean. Mutation-check** — drop the `paused ? '' :` guard on the ETA: the Meeting test fails on `'min left'`. Drop the `pausedIds` wrap: the Library test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/PipelineController.ts src/native/NativeAudioPipeline.ts src/screens/MeetingScreen.tsx src/screens/LibraryScreen.tsx src/screens/__tests__/MeetingScreen.test.tsx src/screens/__tests__/LibraryScreen.test.tsx
git commit -m "feat(thermal): a paused meeting says why on the screen, the card and the notification"
```

---

### Task 9: The action tracker's front door

**Files:**
- Modify: `src/screens/LibraryScreen.tsx` (header row ~627; after the streak card ~700)
- Test: `src/screens/__tests__/LibraryScreen.test.tsx`

`work` (`{ total, open, meetings }`) is already computed on every focus (line ~243) and never rendered — the comment at line ~271 says so. `ActionsScreen` already opens a meeting on its Actions tab (line ~125), so the spec's §3 last paragraph is already true in code — but `ActionsScreen.test.tsx` has no test for it. Add one (Step 1b) so it stays true.

- [ ] **Step 1: Failing tests** (LibraryScreen.test.tsx; `loadActions` is imported from `../actionsData` — mock it):

```ts
jest.mock('../actionsData', () => ({
  ...jest.requireActual('../actionsData'),
  loadActions: jest.fn(),
}));
import { loadActions } from '../actionsData';

describe('the action tracker\'s front door', () => {
  it('shows a card with the open count and opens the tracker', async () => {
    (loadActions as jest.Mock).mockResolvedValue([
      { meetingId: 'a', id: '1', content: 'x', done: false, meetingTitle: 'A', createdAt: 1, source: 'rule' },
      { meetingId: 'b', id: '2', content: 'y', done: false, meetingTitle: 'B', createdAt: 1, source: 'rule' },
      { meetingId: 'b', id: '3', content: 'z', done: true, meetingTitle: 'B', createdAt: 1, source: 'rule' },
    ]);
    const tree = await render();
    const card = tree.root.findByProps({ accessibilityLabel: 'Open actions' });
    expect(JSON.stringify(card.props.children ?? tree.toJSON())).toContain('2 open actions');
    expect(JSON.stringify(tree.toJSON())).toContain('across 2 meetings');
    await act(async () => { card.props.onPress(); });
    expect(nav.navigate).toHaveBeenCalledWith('Actions');
  });

  it('shows no card when nothing is open', async () => {
    (loadActions as jest.Mock).mockResolvedValue([
      { meetingId: 'a', id: '1', content: 'x', done: true, meetingTitle: 'A', createdAt: 1, source: 'rule' },
    ]);
    const tree = await render();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Open actions' })).toHaveLength(0);
  });

  it('has the tracker one tap away in the header regardless', async () => {
    (loadActions as jest.Mock).mockResolvedValue([]);
    const tree = await render();
    const icon = tree.root.findByProps({ label: 'Actions' });
    await act(async () => { icon.props.onPress(); });
    expect(nav.navigate).toHaveBeenCalledWith('Actions');
  });
});
```

- [ ] **Step 1b: ActionsScreen — the title opens the meeting's Actions tab** (append to `ActionsScreen.test.tsx`, which has `nav`, `route`, `action` and `render()`):

```ts
  it('opens the meeting on its Actions tab from the meeting row', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([action]);
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set());
    const tree = await render();
    const row = tree.root.findAllByProps({ accessibilityRole: 'button' }, { deep: false })
      .find(n => JSON.stringify(n.props.children ?? '').includes('Standup') || n.props.accessibilityLabel?.includes('Standup'));
    expect(row).toBeTruthy();
    await act(async () => { row!.props.onPress(); });
    expect(nav.navigate).toHaveBeenCalledWith('Meeting', { meetingId: 'm1', tab: 'actions' });
  });
```

If the meeting row's `Pressable` has no `accessibilityRole`, give it `accessibilityRole="button"` and `accessibilityLabel={\`Open ${title}\`}` in `ActionsScreen.tsx` — that is the only production change this step may make. Run: passes. Mutation-check: change `tab: 'actions'` to `tab: 'summary'` — fails. Restore.

- [ ] **Step 2: Run — fail** (no such label / card).

- [ ] **Step 3: Implement.** Header, between Search and Settings:

```tsx
            <IconButton icon="list" label="Actions" onPress={() => navigation.navigate('Actions')} />
```

After the streak block (`{streak >= 2 ? (…) : null}`):

```tsx
        {work.open > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open actions"
            onPress={() => navigation.navigate('Actions')}
            style={st.actionsWrap}>
            <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={6}>
              <View style={st.actionsCard}>
                <View style={[st.actionsIcon, { backgroundColor: colors.primarySoft }]}>
                  <Icon name="list" size={s(20)} color={colors.primary} strokeWidth={2.4} />
                </View>
                <View style={st.flex}>
                  <Txt variant="bodyBlack">{work.open} open action{work.open === 1 ? '' : 's'}</Txt>
                  <Txt variant="chipSoft" color={colors.inkSoft}>
                    across {work.meetings} meeting{work.meetings === 1 ? '' : 's'}
                  </Txt>
                </View>
                <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} />
              </View>
            </Raised>
          </Pressable>
        ) : null}
```

Styles (in `makeStyles`): `actionsWrap: { marginTop: s(12) }`, `actionsCard: { flexDirection: 'row', alignItems: 'center', gap: s(12), padding: s(14) }`, `actionsIcon: { width: s(40), height: s(40), borderRadius: radius.ctl, alignItems: 'center', justifyContent: 'center' }`. Update the stale comment at ~271 (`work` IS on screen now).

- [ ] **Step 4: Run the Library tests; tsc. Mutation-check** — render the card when `work.open >= 0`: the "no card" test fails. Restore.

- [ ] **Step 5: Commit**

```bash
git add src/screens/LibraryScreen.tsx src/screens/__tests__/LibraryScreen.test.tsx
git commit -m "feat(actions): the tracker has a front door — a card with the open count, and a header icon"
```

---

### Task 10: Prove it on the Pixel

`export ANDROID_SERIAL=36091FDH30034G`; build `npm run apk`; force-stop the app before `adb install -r`.

- [x] **ETA and counts.** Record a ~5-minute meeting from the Mac's speakers (`meeting.sh` twice, 50 % volume); stop; open it while processing. Expect: "Words written down · k of n" counting up; the ETA falling as it counts; the "Speakers separated" row counting too. After it finishes, `adb logcat -d | grep "stage="` shows the measured rates; the next recording's first ETA differs from the shipped-constant ETA (compare the pct pill at the same stage on two consecutive meetings; a second meeting's ETA uses `rate.asr` from the first). Read the persisted values via the app's Settings → nothing shows them; use `logcat` (`stage=asr … (0.xx realtime)`) and the second run's ETA as the evidence.
- [x] **Pause.** Start another recording, stop, and while ASR is running: `adb shell cmd thermalservice override-status 3`. Within ~one window: `logcat` shows `pause HEAT: thermal=3 …`; the screen shows "Paused to let the phone cool — it resumes on its own." with no ETA; the notification says the same; the Library card (go back) reads PAUSED. Then `override-status 0`: `resume:` in the log, the screen returns to the stage list, the transcript completes in full (Script tab — every sentence of `meeting.sh` present).
- [x] **Cancel mid-ASR persists nothing.** (Landed in diarization instead — the live cache makes ASR 20 s — and found the same hazard there; fixed.) Start a recording, stop, open the meeting while ASR runs, ⋮ → Delete. Expect: `pipeline cancelled` in the log, no crash, the meeting gone. (The partial-transcript hazard is the one this guards.)
- [x] **Actions.** Library shows "N open actions · across M meetings" (the library has them); tap → tracker; header icon → tracker; tap a meeting title in the tracker → that meeting's Actions tab. Tick one in the tracker, go back: the card's count is one lower.
- [x] **Record the run** in the spec (`## Device verification`), tick this task, update `docs/NEXT.md` §2 (ETA item → shipped; add the thermal + actions lines), memory. Commit; push (the gate runs; `ANDROID_SERIAL` set so the device suite runs).
