# Track A — Headless-MOM Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three independent headless-MOM follow-ups — deep-link the "Notes ready" notification to its meeting, animate the missing "minutes" progress step, and stop "Regenerate minutes" from silently downgrading LLM-enhanced minutes to the rule floor.

**Architecture:** Task 1 is pure JS (a new `PipelineController.regenerateMinutes` + a one-line screen change), TDD with jest. Task 2 is one native emit + one type addition. Task 3 wires a native→JS deep-link using the existing `RCTDeviceEventEmitter` seam (`MainActivity.emitPipMode`/`usePipMode` pattern) plus a `Linking.getInitialURL`-style consumed-once getter for cold starts. Each task ends in its own commit.

**Tech Stack:** React Native 0.86 (New Arch, bridgeless), TypeScript, Kotlin, React Navigation native-stack, jest.

**Spec:** `docs/superpowers/specs/2026-08-11-headless-mom-polish-design.md`

**Branch:** `feat/headless-mom-polish` (already created off `main`; the spec is committed there).

---

## File Structure

- `src/pipeline/PipelineController.ts` — MODIFY: add `regenerateMinutes(meetingId)` (tier-preserving rebuild). `buildMinutes` stays as the rule-only primitive it calls.
- `src/screens/SpeakersScreen.tsx` — MODIFY: `regenerate()` calls `regenerateMinutes` instead of `buildMinutes`.
- `__tests__/sweep.test.ts` — MODIFY: add `minutes` to the db mock; add a `regenerateMinutes` describe block.
- `src/pipeline/types.ts` — MODIFY: add `'minutes'` to the `PipelineStage` union.
- `android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt` — MODIFY: bracket the minutes block with `onStage("minutes", …)`.
- `android/app/src/main/java/com/audionotes/MainActivity.kt` — MODIFY: add `DeepLink` holder, read the `openMeetingId` extra in `onCreate`, override `onNewIntent`.
- `android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt` — MODIFY: add `consumePendingMeetingId` `@ReactMethod`.
- `src/native/NativeAudioPipeline.ts` — MODIFY: add `consumePendingMeetingId()` to the Spec.
- `jest.setup.js` — MODIFY: add `consumePendingMeetingId` to the `AudioPipeline` mock.
- `src/navigation/RootNavigator.tsx` — MODIFY: attach a `navigationRef`, consume the cold-start id in `onReady`, subscribe to `onOpenMeeting` for warm taps.

---

## Task 1: #3 — `regenerateMinutes` preserves the LLM tier

**Files:**
- Modify: `src/pipeline/PipelineController.ts` (add method after `buildMinutes`, ~line 184)
- Modify: `src/screens/SpeakersScreen.tsx:45`
- Test: `__tests__/sweep.test.ts` (add `minutes` to mock; new describe block)

Background: `SpeakersScreen.regenerate()` calls `PipelineController.buildMinutes`, which unconditionally rewrites all minutes as `source:'rule'` (via `extractMinutes` + `db.replaceMinutes`). A meeting that had LLM-enhanced minutes (`source:'llm'`) is silently downgraded. `source` already round-trips through `db.minutes` (`queries.ts:88-93`) and `db.replaceMinutes` (`queries.ts:96-108`). `enhanceMinutes` (`PipelineController.ts:224-243`) is already gated on `Llm.available()/capable()/load()` and keeps the rule floor on any failure.

- [ ] **Step 1: Add `minutes` to the db mock**

In `__tests__/sweep.test.ts`, inside the `jest.mock('../src/db/queries', …)` factory (currently lines 10-24), add a `minutes` fn to the `db` object:

```ts
jest.mock('../src/db/queries', () => ({
  db: {
    pendingMeetings: jest.fn(),
    utterances: jest.fn(),
    speakers: jest.fn(),
    segments: jest.fn(async () => []),
    minutes: jest.fn(async () => []),
    replaceMinutes: jest.fn(async () => {}),
    setStatus: jest.fn(async () => {}),
    getMeeting: jest.fn(async () => undefined),
    setTitle: jest.fn(async () => {}),
    getSetting: jest.fn(async () => ''),
  },
}));
```

- [ ] **Step 2: Reference the Llm mock and write the failing tests**

In `__tests__/sweep.test.ts`, add this import near the top (after the existing imports, e.g. after line 27):

```ts
// NativeLlm's default export resolves to the jest.setup.js mock (available/capable/load default
// to false), so importing it here gives us the same jest.fn()s to assert against.
import Llm from '../src/native/NativeLlm';
const mockLlm = Llm as unknown as {
  available: jest.Mock; capable: jest.Mock; load: jest.Mock; generate: jest.Mock; unload: jest.Mock;
};
```

Add `mockDb.minutes.mockResolvedValue([]);` to the `beforeEach` block (alongside the other resets, ~line 66) so each test starts clean:

```ts
  mockDb.getSetting.mockResolvedValue('');
  mockDb.minutes.mockResolvedValue([]);
```

Then add this new describe block at the end of the file:

```ts
describe('PipelineController regenerateMinutes() — tier-preserving rebuild after a speaker merge', () => {
  it('re-runs LLM enhancement when the meeting currently has LLM-enhanced minutes', async () => {
    mockDb.minutes.mockResolvedValue([
      { id: 'm6:0', meetingId: 'm6', kind: 'summary', content: 'x', source: 'llm' },
    ]);
    mockDb.utterances.mockResolvedValue([utt('u1', 'm6')]);
    mockDb.speakers.mockResolvedValue([speaker('m6')]);

    await PipelineController.regenerateMinutes('m6');

    // Rule floor rebuilt (buildMinutes ran) AND the LLM enhancement was attempted — Llm.available
    // is enhanceMinutes' first gate, so its being called proves the tier-preserving branch ran.
    expect(mockDb.replaceMinutes).toHaveBeenCalled();
    expect(mockLlm.available).toHaveBeenCalled();
  });

  it('does NOT run LLM enhancement when the meeting only has rule-based minutes', async () => {
    mockDb.minutes.mockResolvedValue([
      { id: 'm7:0', meetingId: 'm7', kind: 'summary', content: 'x', source: 'rule' },
    ]);
    mockDb.utterances.mockResolvedValue([utt('u1', 'm7')]);
    mockDb.speakers.mockResolvedValue([speaker('m7')]);

    await PipelineController.regenerateMinutes('m7');

    expect(mockDb.replaceMinutes).toHaveBeenCalled();
    expect(mockLlm.available).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest __tests__/sweep.test.ts -t regenerateMinutes`
Expected: FAIL — `PipelineController.regenerateMinutes is not a function`.

- [ ] **Step 4: Implement `regenerateMinutes`**

In `src/pipeline/PipelineController.ts`, add this method immediately after `buildMinutes` (which ends at line 184, before `retitleFromTranscript`):

```ts
  /**
   * Rebuild a meeting's minutes after a speaker merge WITHOUT downgrading its tier.
   *
   * SpeakersScreen's "Regenerate" used to call buildMinutes directly, which always rewrites the
   * rule-based floor (source:'rule') — silently discarding any LLM-enhanced minutes the meeting
   * had. Here we detect whether the meeting currently holds LLM minutes and, if so, re-run the LLM
   * enhancement after the rule rebuild so the meeting keeps its enhanced tier. enhanceMinutes is
   * already gated on the model being available/capable and falls back to keeping the rule minutes
   * on any failure, so an LLM-less device degrades gracefully to the rebuilt rule floor.
   */
  async regenerateMinutes(meetingId: string): Promise<void> {
    const existing = await db.minutes(meetingId);
    const wasLlm = existing.some(m => m.source === 'llm');
    await this.buildMinutes(meetingId);
    if (wasLlm) await this.enhanceMinutes(meetingId);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest __tests__/sweep.test.ts -t regenerateMinutes`
Expected: PASS (2 passed).

- [ ] **Step 6: Point SpeakersScreen at the new method**

In `src/screens/SpeakersScreen.tsx`, change the call inside `regenerate()` (line 45):

```ts
  const regenerate = async () => {
    setBusy(true);
    try {
      await PipelineController.regenerateMinutes(meetingId);
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 7: Run the full JS gate**

Run: `npx jest && npx tsc --noEmit -p tsconfig.json && npx eslint src/pipeline/PipelineController.ts src/screens/SpeakersScreen.tsx __tests__/sweep.test.ts`
Expected: jest all green (previous 23 + 2 new = 25), tsc clean, eslint clean.

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/PipelineController.ts src/screens/SpeakersScreen.tsx __tests__/sweep.test.ts
git commit -m "fix(minutes): regenerate preserves LLM tier instead of downgrading to rule floor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: #2 — emit the "minutes" progress stage

**Files:**
- Modify: `src/pipeline/types.ts:14`
- Modify: `android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt:151-159`

Background: `MeetingScreen` already renders a 4th step keyed `minutes` (`STAGES`, `MeetingScreen.tsx:36-41`) and animates whichever step the latest `onStageProgress` event names, but `ProcessingEngine` never emits an `onStage("minutes", …)`. `StageProgress.stage` is typed `PipelineStage`, which lacks `'minutes'`.

- [ ] **Step 1: Add `'minutes'` to the `PipelineStage` union**

In `src/pipeline/types.ts`, line 14:

```ts
export type PipelineStage = 'vad' | 'asr' | 'diarize' | 'minutes' | 'align' | 'structure';
```

- [ ] **Step 2: Verify types still compile**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean (no new errors).

- [ ] **Step 3: Bracket the minutes block with progress emits**

In `android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt`, wrap the minutes block (currently lines 151-159). Add `listener.onStage("minutes", 0, 1)` immediately before `val utts = db.utterances(meetingId)` and `listener.onStage("minutes", 1, 1)` immediately after `db.setStatus(meetingId, "done")`:

```kotlin
      // ---- Minutes / MOM (rule-based, native) + retitle + retention, then done ----
      // Gate only on utterances existing — NOT on `transcribed`/diarize success. Diarize can
      // legitimately produce no speakers (single-speaker meeting, or no diar models installed
      // yet) and the meeting still deserves a full MOM from whatever transcript it has.
      listener.onStage("minutes", 0, 1)
      val utts = db.utterances(meetingId)
      if (utts.isNotEmpty()) {
        val speakers = db.speakers(meetingId)
        val minutes = MinutesExtractor.extract(utts, speakers)
        db.replaceMinutes(meetingId, minutes)
        retitleFromTranscript(meetingId, utts)
        applyRetention(meetingId, utts.size)
        db.setStatus(meetingId, "done")
        listener.onStage("minutes", 1, 1)
        Log.i(TAG, "Minutes produced ${minutes.size} items for $meetingId")
      } else {
```

Note: the emit sits only on the success branch (after `done`). The empty-transcript branch below it ends terminally in `error`/pending and the UI leaves the run state via `onComplete`/`onError`, so no `minutes` emit is wanted there.

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/types.ts android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt
git commit -m "feat(pipeline): emit 'minutes' progress stage so the 4th step animates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Device verification of the animation happens in Task 4.)

---

## Task 3: #1 — deep-link "Notes ready" → the meeting

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/MainActivity.kt`
- Modify: `android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt`
- Modify: `src/native/NativeAudioPipeline.ts`
- Modify: `jest.setup.js`
- Modify: `src/navigation/RootNavigator.tsx`

Background: `ProcessingService.postNotesReady` already puts an `openMeetingId` extra on the launch `PendingIntent` (`ProcessingService.kt:203-208`). `MainActivity` is `singleTask` (AndroidManifest), so a tap on a running app arrives via `onNewIntent`; a tap that cold-starts arrives via `onCreate`'s intent. `MainActivity` already emits native→JS events through `reactInstanceManagerBridgeless().getJSModule(RCTDeviceEventEmitter)` (see `emitPipMode`, lines 68-78).

- [ ] **Step 1: Add the `DeepLink` holder + read the extra in `onCreate`**

In `android/app/src/main/java/com/audionotes/MainActivity.kt`, add the `Intent` import to the import block (after `import android.content.res.Configuration`):

```kotlin
import android.content.Intent
```

Add a top-level `DeepLink` object (place it just above `class MainActivity`):

```kotlin
/** Carries a "Notes ready" notification's target meetingId across a cold start until JS is ready
 *  to consume it (see AudioPipelineModule.consumePendingMeetingId). Warm taps use onOpenMeeting. */
object DeepLink {
  @Volatile var pendingMeetingId: String? = null
}
```

Update `onCreate` (lines 20-23) to stash a cold-start extra:

```kotlin
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    current = this
    intent?.getStringExtra("openMeetingId")?.let { DeepLink.pendingMeetingId = it }
  }
```

- [ ] **Step 2: Override `onNewIntent` for warm taps**

In `MainActivity`, add this override (e.g. immediately after `onCreate`):

```kotlin
  /**
   * A "Notes ready" tap while the app is already running (singleTask) lands here, not in onCreate.
   * Emit onOpenMeeting straight to JS when React is live; if it somehow isn't, fall back to the
   * same pending slot the cold-start path uses so the navigator still picks it up on mount.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    val id = intent.getStringExtra("openMeetingId") ?: return
    val ctx: ReactContext? = reactInstanceManagerBridgeless()
    if (ctx != null) {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("onOpenMeeting", com.facebook.react.bridge.Arguments.createMap().apply {
          putString("meetingId", id)
        })
    } else {
      DeepLink.pendingMeetingId = id
    }
  }
```

- [ ] **Step 3: Expose `consumePendingMeetingId` from the AudioPipeline module**

In `android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt`, add this `@ReactMethod` (e.g. just before `addListener`/`removeListeners` at line 275):

```kotlin
  /**
   * Hand JS the meetingId stashed by a cold-start "Notes ready" notification tap, exactly once.
   * MainActivity stores it in DeepLink.pendingMeetingId before React is ready (onCreate); the JS
   * navigator calls this on mount to deep-link to the meeting. Warm taps skip this and arrive as
   * the 'onOpenMeeting' device event instead. Resolves null when there is nothing pending.
   */
  @ReactMethod
  fun consumePendingMeetingId(promise: Promise) {
    val id = com.audionotes.DeepLink.pendingMeetingId
    com.audionotes.DeepLink.pendingMeetingId = null
    promise.resolve(id)
  }
```

- [ ] **Step 4: Add the method to the TurboModule spec**

In `src/native/NativeAudioPipeline.ts`, add to the `Spec` interface (e.g. after `discardAudio`, line 24):

```ts
  // Consume (and clear) a meetingId stashed by a cold-start "Notes ready" notification tap, so the
  // navigator can deep-link to it on mount. Resolves null when there is none. Warm taps arrive as
  // the 'onOpenMeeting' DeviceEventEmitter event instead.
  consumePendingMeetingId(): Promise<string | null>;
```

- [ ] **Step 5: Add the method to the jest mock**

In `jest.setup.js`, add to the `AudioPipeline` mock object (after `recoverOrphans`, line 21):

```js
    consumePendingMeetingId: jest.fn(async () => null),
```

- [ ] **Step 6: Wire the navigator to deep-link**

In `src/navigation/RootNavigator.tsx`:

Change the React import (line 1) to add `useCallback`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
```

Change the react-native import (line 2) to add `DeviceEventEmitter`:

```tsx
import { DeviceEventEmitter, StatusBar, View } from 'react-native';
```

Change the navigation import (line 3) to add `createNavigationContainerRef`:

```tsx
import { DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
```

Add an AudioPipeline import (after line 6, `import { db } from '../db/queries';`):

```tsx
import AudioPipeline from '../native/NativeAudioPipeline';
```

Add the ref just after `const Stack = createNativeStackNavigator<RootStackParamList>();` (line 28):

```tsx
// A container-level ref so a native "Notes ready" tap can navigate without a screen in scope.
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
```

Inside `RootNavigator`, add the handler + warm-tap listener (e.g. right after the existing onboarding `useEffect`, around line 43):

```tsx
  const openMeeting = useCallback((meetingId?: string | null) => {
    if (meetingId && navigationRef.isReady()) {
      navigationRef.navigate('Meeting', { meetingId });
    }
  }, []);

  // Warm tap: the app is already running, so MainActivity.onNewIntent emits onOpenMeeting.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('onOpenMeeting', (e: { meetingId?: string }) =>
      openMeeting(e?.meetingId),
    );
    return () => sub.remove();
  }, [openMeeting]);
```

Attach the ref and consume the cold-start id in `onReady` — change the `<NavigationContainer theme={navTheme}>` opening tag (line 85) to:

```tsx
      <NavigationContainer
        ref={navigationRef}
        theme={navTheme}
        onReady={() => {
          // Cold start: MainActivity stashed the id before React existed; consume it once the
          // navigator is mounted so navigate() has somewhere to go.
          AudioPipeline.consumePendingMeetingId().then(openMeeting).catch(() => {});
        }}>
```

- [ ] **Step 7: Run the full JS gate**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src/navigation/RootNavigator.tsx src/native/NativeAudioPipeline.ts && npx jest`
Expected: tsc clean, eslint clean, jest all green (25).

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/java/com/audionotes/MainActivity.kt \
        android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt \
        src/native/NativeAudioPipeline.ts jest.setup.js src/navigation/RootNavigator.tsx
git commit -m "feat(nav): deep-link 'Notes ready' notification to its meeting (cold + warm start)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Build + on-device verification

**Files:** none (verification only). Run by the orchestrator on device `36091FDH30034G` (debug build needs Metro + `adb reverse tcp:8081 tcp:8081`; see memory `android-build-run`).

- [ ] **Step 1: Build the debug APK**

Run: `cd android && ./gradlew :app:assembleDebug` (Codegen regenerates the TurboModule spec, picking up `consumePendingMeetingId`.)
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 2: Install + start Metro**

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
npx react-native start   # in a background shell
```

- [ ] **Step 3: Verify #2 (minutes step animates)**

Record a short in-app meeting with speech, stop, and watch the progress steps: the 4th step ("Pulling out the minutes") should briefly go active before the results view appears. Confirm via `adb logcat` showing `onStage("minutes"…)`/`Minutes produced N items`.

- [ ] **Step 4: Verify #1 warm-start deep-link**

With the app running (backgrounded), complete a background meeting so a "Notes ready" notification posts. Tap it → the app comes forward on the **Meeting** screen for that meeting; Back returns to Library.

- [ ] **Step 5: Verify #1 cold-start deep-link**

`adb shell am force-stop com.audionotes`, then tap a "Notes ready" notification → the app cold-starts and lands directly on the correct **Meeting** screen.

- [ ] **Step 6: Verify #3 (regenerate keeps LLM tier)** — only if an LLM-capable device with the Qwen model is available; otherwise rely on the jest coverage from Task 1. Open an LLM-enhanced meeting → Speakers → merge two speakers → Regenerate → minutes remain LLM-quality (not the rule floor).

---

## Self-Review Notes

- **Spec coverage:** #1 (Tasks 3, 4-Steps 4/5), #2 (Task 2, 4-Step 3), #3 (Task 1, 4-Step 6) — all three spec items map to tasks.
- **Type consistency:** `regenerateMinutes` / `consumePendingMeetingId` / `openMeeting` / `navigationRef` / `DeepLink.pendingMeetingId` / event name `onOpenMeeting` are used identically across every task that references them. `Minute.source` is `'rule' | 'llm'` per `types.ts:54`, matching the test fixtures and `wasLlm` check.
- **No placeholders:** every code step shows the exact code; every run step shows the command + expected result.
