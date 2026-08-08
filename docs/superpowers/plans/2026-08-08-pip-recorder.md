# PiP Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a recording is active, leaving the app (Home/app-switch/exit-back) drops into a native Android Picture-in-Picture window with a timer, waveform, and Pause/Stop buttons; in-app Back goes to the Library with a small recording bar. The legacy overlay bubble is retired.

**Architecture:** Native `MainActivity` enters PiP on `onUserLeaveHint`; a `BroadcastReceiver` routes PiP action buttons to `CaptureController`. React Native renders the compact PiP contents (driven by an `onPipModeChanged` event) and the in-app recording bar (driven by `recordingStore`). The `SYSTEM_ALERT_WINDOW` overlay bubble subsystem is deleted.

**Tech Stack:** Kotlin (Android, React Native New Arch/Fabric), TypeScript + React Native 0.86, Zustand, Jest.

**Spec:** `docs/superpowers/specs/2026-08-08-pip-recorder-design.md`

---

## File structure

**Create**
- `android/app/src/main/java/com/audionotes/pipeline/PipController.kt` — builds `PictureInPictureParams`, owns the enter-PiP decision and the action `RemoteAction`s.
- `android/app/src/main/java/com/audionotes/pipeline/PipActionReceiver.kt` — receives Pause/Resume/Stop broadcasts, calls `CaptureController`.
- `android/app/src/main/java/com/audionotes/pipeline/PipModule.kt` — `Pip` TurboModule (`isSupported`, event stubs).
- `src/native/NativePip.ts` — TurboModule spec for `Pip`.
- `src/hooks/usePipMode.ts` — subscribes to `onPipModeChanged`, returns `inPip`.
- `src/components/PipRecorder.tsx` — the compact recorder shown while in PiP.
- `src/components/RecordingBar.tsx` — the in-app "recording" bar.
- `android/app/src/main/res/drawable/ic_pip_pause.xml`, `ic_pip_resume.xml`, `ic_pip_stop.xml` — PiP action icons.

**Modify**
- `android/app/src/main/java/com/audionotes/MainActivity.kt` — PiP lifecycle hooks.
- `android/app/src/main/AndroidManifest.xml` — enable PiP; remove overlay perms/service.
- `android/app/src/main/java/com/audionotes/pipeline/AudioPipelineModule.kt` — emit `onPipModeChanged` helper (via existing emitter) is not needed; MainActivity emits directly. (No change unless noted in Task 5.)
- `android/app/src/main/java/com/audionotes/pipeline/AudioPipelinePackage.kt` — register `PipModule`, drop `OverlayModule`.
- `android/app/src/main/java/com/audionotes/MainApplication.kt` — drop `ForegroundTracker.register`.
- `android/app/src/main/java/com/audionotes/pipeline/CaptureController.kt` — drop `OverlayService` references (comment + any calls).
- `src/navigation/RootNavigator.tsx` — mount `PipRecorder` overlay.
- `src/screens/LibraryScreen.tsx` — mount `RecordingBar`.
- `src/screens/SettingsScreen.tsx` — remove the Floating-recorder toggle + permission flow.

**Delete**
- `android/app/src/main/java/com/audionotes/pipeline/OverlayService.kt`
- `android/app/src/main/java/com/audionotes/pipeline/OverlayModule.kt`
- `android/app/src/main/java/com/audionotes/pipeline/ForegroundTracker.kt`
- `android/app/src/main/java/com/audionotes/overlay/` (whole dir: `BubbleView.kt`, `DismissView.kt`, `PipDrawer.kt`, `BubbleAccessibilityHelper.kt`, `Scale.kt`, `Palette.kt`)
- `src/native/NativeOverlay.ts`

**Test**
- `__tests__/RecordingBar.test.tsx` — bar visibility keyed to recording state.
- `__tests__/usePipMode.test.tsx` — hook flips on `onPipModeChanged`.

---

## Environment note (every build/run step)

All gradle/adb commands assume this preamble (adb is not on PATH):

```bash
export ANDROID_HOME="/Users/akshayghosh/Android/Library/SDK"
export JAVA_HOME="/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home"
export PATH="$ANDROID_HOME/platform-tools:$JAVA_HOME/bin:$PATH"
```

Debug install/run for on-device checks: start Metro (`npx react-native start`), then
`adb reverse tcp:8081 tcp:8081 && npx react-native run-android --no-packager --active-arch-only`.

---

## Task 1: Enable PiP in the manifest

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml` (the `.MainActivity` `<activity>`, ~line 26)

- [ ] **Step 1: Add `supportsPictureInPicture` to MainActivity**

In the `<activity android:name=".MainActivity" ...>` element, add these two attributes (the required `configChanges` — `screenSize|smallestScreenSize|screenLayout|orientation` — are already present):

```xml
android:supportsPictureInPicture="true"
android:resizeableActivity="true"
```

- [ ] **Step 2: Verify it still assembles**

Run: `cd android && ./gradlew :app:processDebugMainManifest`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/AndroidManifest.xml
git commit -m "feat(pip): declare supportsPictureInPicture on MainActivity"
```

---

## Task 2: PiP params + action icons (PipController)

**Files:**
- Create: `android/app/src/main/java/com/audionotes/pipeline/PipController.kt`
- Create: `android/app/src/main/res/drawable/ic_pip_pause.xml`, `ic_pip_resume.xml`, `ic_pip_stop.xml`

- [ ] **Step 1: Add the three vector icons**

`ic_pip_stop.xml`:
```xml
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"
    android:tint="#FFFFFF">
  <path android:fillColor="#FFFFFF" android:pathData="M6,6h12v12h-12z"/>
</vector>
```
`ic_pip_pause.xml`:
```xml
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"
    android:tint="#FFFFFF">
  <path android:fillColor="#FFFFFF" android:pathData="M6,5h4v14h-4z M14,5h4v14h-4z"/>
</vector>
```
`ic_pip_resume.xml`:
```xml
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"
    android:tint="#FFFFFF">
  <path android:fillColor="#FFFFFF" android:pathData="M8,5v14l11,-7z"/>
</vector>
```

- [ ] **Step 2: Write PipController.kt**

```kotlin
package com.audionotes.pipeline

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import com.audionotes.R

/**
 * Owns everything about the Picture-in-Picture window: whether the device supports it, the
 * params (aspect ratio + action buttons), and entering it. Actions are native RemoteActions that
 * broadcast to PipActionReceiver, so they work at PiP size where a tapped RN view would not.
 */
object PipController {
  private const val REQ_PAUSE = 1
  private const val REQ_STOP = 2

  /** Phone PiP is effectively API 26+; guard so API 24-25 (minSdk) and PiP-disabled devices fall back. */
  fun isSupported(activity: Activity): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  fun buildParams(activity: Activity): PictureInPictureParams {
    val paused = CaptureController.paused
    val toggle = RemoteAction(
      Icon.createWithResource(activity, if (paused) R.drawable.ic_pip_resume else R.drawable.ic_pip_pause),
      if (paused) "Resume" else "Pause",
      if (paused) "Resume recording" else "Pause recording",
      pending(activity, REQ_PAUSE, if (paused) PipActionReceiver.ACTION_RESUME else PipActionReceiver.ACTION_PAUSE),
    )
    val stop = RemoteAction(
      Icon.createWithResource(activity, R.drawable.ic_pip_stop),
      "Stop", "Stop recording",
      pending(activity, REQ_STOP, PipActionReceiver.ACTION_STOP),
    )
    return PictureInPictureParams.Builder()
      .setAspectRatio(Rational(16, 9))
      .setActions(listOf(toggle, stop))
      .build()
  }

  /** Refresh the params (e.g. to swap the Pause<->Resume icon) while already in PiP. */
  fun updateParams(activity: Activity) {
    if (isSupported(activity)) activity.setPictureInPictureParams(buildParams(activity))
  }

  /** Enter PiP if a recording is running and the device supports it. Returns true if it did. */
  fun enterIfRecording(activity: Activity): Boolean {
    if (!CaptureController.isRecording || !isSupported(activity)) return false
    return try {
      activity.enterPictureInPictureMode(buildParams(activity))
    } catch (_: Exception) {
      false
    }
  }

  private fun pending(activity: Activity, req: Int, action: String): PendingIntent =
    PendingIntent.getBroadcast(
      activity, req,
      Intent(action).setPackage(activity.packageName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd android && ./gradlew :app:compileDebugKotlin`
Expected: `BUILD SUCCESSFUL` (PipActionReceiver is referenced but created in Task 3; if this step is run in isolation it will fail on that reference — do Tasks 2 and 3 together before compiling, or stub the ACTION_* constants first).

- [ ] **Step 4: Commit** (after Task 3 compiles)

```bash
git add android/app/src/main/java/com/audionotes/pipeline/PipController.kt android/app/src/main/res/drawable/ic_pip_*.xml
git commit -m "feat(pip): PiP params + action icons"
```

---

## Task 3: PiP action receiver

**Files:**
- Create: `android/app/src/main/java/com/audionotes/pipeline/PipActionReceiver.kt`
- Modify: `android/app/src/main/AndroidManifest.xml` (register the receiver inside `<application>`)

- [ ] **Step 1: Write PipActionReceiver.kt**

```kotlin
package com.audionotes.pipeline

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Handles taps on the PiP window's Pause/Resume/Stop buttons. Routes them straight to
 * CaptureController (the capture source of truth), then refreshes the PiP params so the
 * Pause<->Resume icon reflects the new state.
 */
class PipActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      ACTION_PAUSE -> CaptureController.applyPause(true)
      ACTION_RESUME -> CaptureController.applyPause(false)
      ACTION_STOP -> {
        try { CaptureController.stop(context) } catch (e: Exception) { Log.e(TAG, "stop failed", e) }
      }
    }
    // Swap the icon (Pause<->Resume). STOP ends capture, which takes the activity out of PiP anyway.
    (context.applicationContext as? android.app.Application)?.let {
      MainActivity.current?.let { a -> PipController.updateParams(a) }
    }
  }

  companion object {
    private const val TAG = "PipActionReceiver"
    const val ACTION_PAUSE = "com.audionotes.pip.PAUSE"
    const val ACTION_RESUME = "com.audionotes.pip.RESUME"
    const val ACTION_STOP = "com.audionotes.pip.STOP"
  }
}
```

- [ ] **Step 2: Register the receiver in the manifest**

Inside `<application>` (near the other `<service>` entries), add:

```xml
<receiver
  android:name=".pipeline.PipActionReceiver"
  android:exported="false" />
```

- [ ] **Step 3: Verify (with Task 2 + Task 4's MainActivity.current)**

`PipActionReceiver` references `MainActivity.current`, added in Task 4 Step 1. Implement Task 4 Step 1 before compiling. Then:
Run: `cd android && ./gradlew :app:compileDebugKotlin`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/audionotes/pipeline/PipActionReceiver.kt android/app/src/main/AndroidManifest.xml
git commit -m "feat(pip): action receiver for Pause/Resume/Stop"
```

---

## Task 4: MainActivity PiP lifecycle + event to JS

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/MainActivity.kt`

- [ ] **Step 1: Add PiP hooks and a static handle to MainActivity**

Replace the body of `MainActivity` with:

```kotlin
package com.audionotes

import android.content.res.Configuration
import android.os.Bundle
import com.audionotes.pipeline.PipController
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.ReactContext
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "AudioNotes"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    current = this
  }

  override fun onDestroy() {
    if (current === this) current = null
    super.onDestroy()
  }

  /** Home / recents while recording -> float into PiP instead of just backgrounding. */
  override fun onUserLeaveHint() {
    if (!PipController.enterIfRecording(this)) super.onUserLeaveHint()
  }

  override fun onPictureInPictureModeChanged(isInPip: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPip, newConfig)
    emitPipMode(isInPip)
  }

  private fun emitPipMode(inPip: Boolean) {
    val ctx: ReactContext? = reactInstanceManagerBridgeless()
    ctx?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      ?.emit("onPipModeChanged", com.facebook.react.bridge.Arguments.createMap().apply {
        putBoolean("inPip", inPip)
      })
  }

  /** The current React context under bridgeless New Arch. */
  private fun reactInstanceManagerBridgeless(): ReactContext? =
    (application as com.facebook.react.ReactApplication).reactHost.currentReactContext

  companion object {
    /** The live activity, so background receivers (PipActionReceiver) can refresh PiP params. */
    @Volatile var current: MainActivity? = null
  }
}
```

- [ ] **Step 2: Add exit-back-to-PiP (system Back that would exit the app)**

Add this override inside `MainActivity` (before the `companion object`). It intercepts a Back press that would finish the activity and enters PiP instead while recording:

```kotlin
  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (isTaskRoot && PipController.enterIfRecording(this)) return
    @Suppress("DEPRECATION") super.onBackPressed()
  }
```

Note: in-app Back on the Record screen is handled by React Navigation (it is not at the task root), so this only fires when Back would leave the app.

- [ ] **Step 3: Verify it compiles**

Run: `cd android && ./gradlew :app:compileDebugKotlin`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/audionotes/MainActivity.kt
git commit -m "feat(pip): enter PiP on leave/exit-back; emit onPipModeChanged"
```

---

## Task 5: Pip TurboModule (isSupported + event channel)

**Files:**
- Create: `src/native/NativePip.ts`
- Create: `android/app/src/main/java/com/audionotes/pipeline/PipModule.kt`
- Modify: `android/app/src/main/java/com/audionotes/pipeline/AudioPipelinePackage.kt`

- [ ] **Step 1: Write the TS spec `src/native/NativePip.ts`**

```ts
// TurboModule spec for native Picture-in-Picture. The window is entered natively on leave;
// JS only needs to know device support and when PiP mode toggles (event: onPipModeChanged).
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  isSupported(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Pip');
```

- [ ] **Step 2: Write `PipModule.kt`**

```kotlin
package com.audionotes.pipeline

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Pip — device PiP support + the event channel for onPipModeChanged. Entering PiP is done in
 * MainActivity on leave; this module exists so JS can gate UI on support and subscribe to the
 * mode event via NativeEventEmitter(NativeModules.Pip).
 */
class PipModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "Pip"

  @ReactMethod
  fun isSupported(promise: Promise) {
    val a = currentActivity
    promise.resolve(a != null && PipController.isSupported(a))
  }

  // Required so NativeEventEmitter(NativeModules.Pip) is valid. Events are delivered via the
  // global RCTDeviceEventEmitter from MainActivity.emitPipMode.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
}
```

- [ ] **Step 3: Register it and drop OverlayModule**

In `AudioPipelinePackage.kt`, change the `createNativeModules` list to add `PipModule(ctx)` and remove `OverlayModule(ctx)`:

```kotlin
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(
      AudioPipelineModule(ctx),
      StorageModule(ctx),
      ModelManagerModule(ctx),
      LlmModule(ctx),
      FileExportModule(ctx),
      PipModule(ctx),
    )
```

- [ ] **Step 4: Verify compile**

Run: `cd android && ./gradlew :app:compileDebugKotlin`
Expected: FAIL — `OverlayModule` is now unreferenced but still exists and `OverlayService` may reference removed code only after Task 7. If it fails on OverlayModule/OverlayService, that is expected until Task 7. To keep this task green, only remove `OverlayModule(ctx)` from the list here; leave the files for Task 7. Re-run — Expected now: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit**

```bash
git add src/native/NativePip.ts android/app/src/main/java/com/audionotes/pipeline/PipModule.kt android/app/src/main/java/com/audionotes/pipeline/AudioPipelinePackage.kt
git commit -m "feat(pip): Pip TurboModule; register it, unregister Overlay"
```

---

## Task 6: RN PiP compact recorder + hook

**Files:**
- Create: `src/hooks/usePipMode.ts`
- Create: `src/components/PipRecorder.tsx`
- Create: `__tests__/usePipMode.test.tsx`
- Modify: `src/navigation/RootNavigator.tsx`

- [ ] **Step 1: Write the failing hook test `__tests__/usePipMode.test.tsx`**

```tsx
import { renderHook, act } from '@testing-library/react-hooks';
import { DeviceEventEmitter } from 'react-native';
import { usePipMode } from '../src/hooks/usePipMode';

jest.mock('../src/native/NativePip', () => ({ __esModule: true, default: {} }));

test('usePipMode flips with onPipModeChanged events', () => {
  const { result } = renderHook(() => usePipMode());
  expect(result.current).toBe(false);
  act(() => { DeviceEventEmitter.emit('onPipModeChanged', { inPip: true }); });
  expect(result.current).toBe(true);
  act(() => { DeviceEventEmitter.emit('onPipModeChanged', { inPip: false }); });
  expect(result.current).toBe(false);
});
```

(If `@testing-library/react-hooks` is not installed, install it as a dev dep: `npm i -D @testing-library/react-hooks react-test-renderer@19.2.3` — react-test-renderer is already present.)

- [ ] **Step 2: Run it, expect failure**

Run: `npx jest usePipMode -i`
Expected: FAIL — cannot find `../src/hooks/usePipMode`.

- [ ] **Step 3: Write `src/hooks/usePipMode.ts`**

```ts
import { useEffect, useState } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';

/** True while the app is in the Android Picture-in-Picture window. Driven by onPipModeChanged. */
export function usePipMode(): boolean {
  const [inPip, setInPip] = useState(false);
  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.Pip);
    const sub = emitter.addListener('onPipModeChanged', (e: { inPip: boolean }) =>
      setInPip(!!e.inPip),
    );
    return () => sub.remove();
  }, []);
  return inPip;
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `npx jest usePipMode -i`
Expected: PASS. (`NativeEventEmitter` delivers `DeviceEventEmitter` events by name in the RN jest preset.)

- [ ] **Step 5: Write `src/components/PipRecorder.tsx`**

```tsx
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { Txt } from './ui';
import LiveWaveform from './LiveWaveform';
import { useRecordingStore } from '../state/recordingStore';

/** Compact recorder shown while the app is in the PiP window. Buttons are native PiP actions. */
export default function PipRecorder() {
  const { colors } = useTheme();
  const { elapsedMs, paused } = useRecordingStore();
  const mm = String(Math.floor(elapsedMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, '0');
  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]}>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: paused ? colors.muted : colors.danger }]} />
        <Txt variant="h1">{`${mm}:${ss}`}</Txt>
      </View>
      <LiveWaveform />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
```

Note: reuse whatever the codebase actually exports — confirm `Txt` variants (`h1`), `LiveWaveform`'s props, and theme tokens (`colors.danger`, `colors.muted`) exist in `src/theme` and `src/components/ui.tsx`/`LiveWaveform.tsx`; adjust names to match. If `LiveWaveform` needs a level prop, pass `useRecordingStore(s => s...)` level or the existing `onCaptureLevel` subscription it already uses on the Record screen.

- [ ] **Step 6: Mount it in `RootNavigator.tsx`**

Wrap the returned tree so PiP content replaces the navigator while in PiP. Add `import { usePipMode } from '../hooks/usePipMode';` and `import PipRecorder from '../components/PipRecorder';`, then inside the component compute `const inPip = usePipMode();` and change the final `return (...)` to:

```tsx
  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor={colors.canvas} />
      {inPip ? (
        <PipRecorder />
      ) : (
        <NavigationContainer theme={navTheme}>
          {/* ...existing Stack.Navigator unchanged... */}
        </NavigationContainer>
      )}
    </>
  );
```

- [ ] **Step 7: Run JS tests**

Run: `npx jest usePipMode -i`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/usePipMode.ts src/components/PipRecorder.tsx __tests__/usePipMode.test.tsx src/navigation/RootNavigator.tsx
git commit -m "feat(pip): compact PiP recorder view driven by onPipModeChanged"
```

---

## Task 7: In-app recording bar

**Files:**
- Create: `src/components/RecordingBar.tsx`
- Create: `__tests__/RecordingBar.test.tsx`
- Modify: `src/screens/LibraryScreen.tsx`

- [ ] **Step 1: Write the failing test `__tests__/RecordingBar.test.tsx`**

```tsx
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { useRecordingStore } from '../src/state/recordingStore';
import RecordingBar from '../src/components/RecordingBar';

jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { card: '#111', ink: '#fff', danger: '#f00', primary: '#00f', canvas: '#000' } }),
  font: { bold: 'X' },
}));

const nav = { navigate: jest.fn() } as any;

test('hidden when not recording, shown when recording', () => {
  act(() => { useRecordingStore.setState({ isRecording: false }); });
  let tree = renderer.create(<RecordingBar navigation={nav} />);
  expect(tree.toJSON()).toBeNull();

  act(() => { useRecordingStore.setState({ isRecording: true, elapsedMs: 5000 }); });
  tree = renderer.create(<RecordingBar navigation={nav} />);
  expect(tree.toJSON()).not.toBeNull();
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx jest RecordingBar -i`
Expected: FAIL — cannot find `../src/components/RecordingBar`.

- [ ] **Step 3: Write `src/components/RecordingBar.tsx`**

```tsx
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { Txt } from './ui';
import { useRecordingStore } from '../state/recordingStore';

/** A slim bar shown on non-Record screens while a recording runs: tap to return, ■ to stop. */
export default function RecordingBar({ navigation }: { navigation: { navigate: (r: string) => void } }) {
  const { colors } = useTheme();
  const { isRecording, elapsedMs, stop } = useRecordingStore();
  if (!isRecording) return null;
  const mm = String(Math.floor(elapsedMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, '0');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Recording ${mm}:${ss}, tap to open the recorder`}
      onPress={() => navigation.navigate('Record')}
      style={[styles.bar, { backgroundColor: colors.card }]}>
      <View style={[styles.dot, { backgroundColor: colors.danger }]} />
      <Txt variant="bodyStrong" style={{ flex: 1 }}>{`Recording ${mm}:${ss}`}</Txt>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Stop recording"
        hitSlop={12}
        onPress={() => { stop(); }}
        style={[styles.stop, { backgroundColor: colors.danger }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, marginHorizontal: 16, marginBottom: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  stop: { width: 22, height: 22, borderRadius: 5 },
});
```

Confirm `Txt` variant names (`bodyStrong` is used in SettingsScreen) and theme tokens match `src/theme`.

- [ ] **Step 4: Run the test, expect pass**

Run: `npx jest RecordingBar -i`
Expected: PASS.

- [ ] **Step 5: Mount the bar on the Library**

In `LibraryScreen.tsx`, import it (`import RecordingBar from '../components/RecordingBar';`) and render `<RecordingBar navigation={navigation} />` just above the bottom Record dock (near the existing bottom actions around line 405-520). Place it so it sits above the Record button.

- [ ] **Step 6: Run JS tests**

Run: `npx jest RecordingBar -i`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/RecordingBar.tsx __tests__/RecordingBar.test.tsx src/screens/LibraryScreen.tsx
git commit -m "feat(pip): in-app recording bar on the Library"
```

---

## Task 8: Retire the overlay bubble

**Files:**
- Delete: `OverlayService.kt`, `OverlayModule.kt`, `ForegroundTracker.kt`, whole `android/app/src/main/java/com/audionotes/overlay/` dir, `src/native/NativeOverlay.ts`
- Modify: `MainApplication.kt`, `CaptureController.kt`, `AndroidManifest.xml`, `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Remove ForegroundTracker registration**

In `MainApplication.kt`, delete the `ForegroundTracker.register(this)` line and its comment in `onCreate`.

- [ ] **Step 2: Delete the native overlay files**

```bash
git rm android/app/src/main/java/com/audionotes/pipeline/OverlayService.kt \
       android/app/src/main/java/com/audionotes/pipeline/OverlayModule.kt \
       android/app/src/main/java/com/audionotes/pipeline/ForegroundTracker.kt \
       src/native/NativeOverlay.ts
git rm -r android/app/src/main/java/com/audionotes/overlay/
```

- [ ] **Step 3: Remove OverlayService references from CaptureController.kt**

Search and remove any `OverlayService` usage:
Run: `grep -n "OverlayService" android/app/src/main/java/com/audionotes/pipeline/CaptureController.kt`
Delete the referenced lines/calls (the class doc comment mentions it; and remove any `startService(... OverlayService ...)` calls). Re-run the grep — expect no matches.

- [ ] **Step 4: Manifest — remove overlay permission + service**

In `AndroidManifest.xml` delete:
- `<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />` (line ~10)
- the entire `<service android:name=".pipeline.OverlayService" ...>...</service>` block (~lines 80-90)
- the now-unused `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />` (only OverlayService used specialUse — confirm with `grep -rn "specialUse\|SPECIAL_USE" android/app/src/main`).

- [ ] **Step 5: Settings — remove the Floating-recorder toggle**

In `SettingsScreen.tsx` remove: the `import Overlay from '../native/NativeOverlay';` line; `floatOn` state; `syncFloat`; `onToggleFloat`; the `syncFloat()` calls in effects; and the "Floating recorder" settings row (~lines 259-280). Remove any now-unused imports (`Switch` if only used there).
Run: `grep -n "Overlay\|floatOn\|syncFloat\|floatEnabled" src/screens/SettingsScreen.tsx`
Expected: no matches.

- [ ] **Step 6: Verify nothing else references the removed pieces**

Run:
```bash
grep -rn "Overlay\|ForegroundTracker\|floatEnabled\|SYSTEM_ALERT_WINDOW" android/app/src/main src/ | grep -v "PipController\|PictureInPicture"
```
Expected: no matches (ignore PiP hits). Fix any stragglers.

- [ ] **Step 7: Compile both sides**

Run: `cd android && ./gradlew :app:compileDebugKotlin`
Expected: `BUILD SUCCESSFUL`.
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(pip): retire the overlay bubble in favour of native PiP"
```

---

## Task 9: Build, install, and verify on device

- [ ] **Step 1: Build + install debug**

```bash
npx react-native start &   # Metro
adb reverse tcp:8081 tcp:8081
npx react-native run-android --no-packager --active-arch-only
```
Expected: `BUILD SUCCESSFUL`, app launches.

- [ ] **Step 2: Verify PiP on background**

Start a recording, then press Home.
Expected: a PiP window appears with the timer, waveform, and Pause + Stop buttons. `adb shell dumpsys activity | grep -i pip` shows the activity in PiP.

- [ ] **Step 3: Verify PiP actions**

Tap Pause in the PiP window → the icon flips to Resume and `adb logcat | grep CaptureController` shows pause applied. Tap Stop → recording ends, PiP closes.

- [ ] **Step 4: Verify in-app Back**

Start a recording, press the in-app Back chevron on the Record screen.
Expected: Library shows, with the recording bar visible; tapping it returns to Record; ■ stops.

- [ ] **Step 5: Verify the bubble is gone**

Settings has no "Floating recorder" row; the app requests no "display over other apps" permission.

- [ ] **Step 6: Commit any fixups**

```bash
git add -A && git commit -m "test(pip): on-device verification fixups"
```

---

## Self-review notes

- **Spec coverage:** PiP on Home/app-switch (Task 4 onUserLeaveHint) ✓; exit-Back → PiP (Task 4 onBackPressed) ✓; in-app Back → Library + bar (Task 7) ✓; minimal PiP content + native Pause/Stop (Tasks 2,3,6) ✓; retire bubble incl. permission/manifest/settings (Task 8) ✓; unsupported-PiP fallback (PipController.isSupported guard) ✓; tests (Tasks 6,7 jest; Task 9 device) ✓.
- **Icon-swap consistency:** `PipController.updateParams` ↔ `PipActionReceiver` ↔ `MainActivity.current` names are consistent across tasks.
- **Assumption to confirm during implementation:** exact `Txt` variant names, `LiveWaveform` props, and theme tokens (`colors.danger`, `colors.muted`, `colors.card`) — verify against `src/components/ui.tsx`, `src/components/LiveWaveform.tsx`, `src/theme` and adjust the two RN components accordingly (they are the only place these are referenced).
