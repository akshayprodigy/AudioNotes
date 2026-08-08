# Picture-in-Picture recorder — design

**Date:** 2026-08-08
**Status:** Approved (design)
**Platform:** Android only
**Related code:** `MainActivity`, `CaptureController`, `RecordingService`, `RecordScreen.tsx`, `recordingStore.ts`, the `overlay/*` package (to be retired)

## Overview

When a recording is active and the user leaves the Record screen — by pressing Home,
switching apps, or backing out of the app — the app should drop into a native Android
**Picture-in-Picture (PiP)** window (the mechanism YouTube uses), so the recording stays
visible and controllable while the user does other things. Pressing **Back inside the app**
instead takes the user to their Library with a small in-app "recording" bar. The existing
custom overlay bubble (which required the "display over other apps" permission) is retired in
favour of PiP.

## Goals

- Leaving the app while recording shows a floating PiP window over other apps, with no special
  permission required.
- The PiP window shows recording state (timer, live level) and offers **Pause/Resume** and
  **Stop** as native PiP action buttons.
- In-app Back from the Record screen keeps the recording running and surfaces a compact
  "recording" bar on the Library so the user can return or stop.
- Remove the overlay-bubble subsystem and its permission friction.

## Non-goals (YAGNI)

- iOS PiP (Android only for this iteration).
- A floating control for a recording **started from the Quick Settings tile while the app is
  fully closed** — no Activity exists to enter PiP, so that case is controlled by the
  foreground-service **notification** until the user opens the app.
- Any PiP interaction beyond Pause/Resume and Stop (no scrubbing, no waveform interaction).

## Behaviour specification

While `CaptureController.isRecording` is true:

| Trigger | Result |
|---|---|
| Home button / switch to another app (`onUserLeaveHint`) | Enter PiP |
| System Back that would exit the app (app at root) | Enter PiP instead of exiting |
| In-app Back on Record screen (chevron) | Navigate to Library; recording continues; show in-app recording bar |
| Tap the PiP window | Reopen app on the Record screen; PiP closes |
| Pause/Resume PiP action | Toggle capture pause; swap the action icon |
| Stop (PiP action / mini bar / notification) | End recording; PiP closes; processing continues in background |

When **not** recording: no PiP is ever entered and the mini bar is hidden — behaviour is
unchanged from today.

### PiP window content

A minimal recorder rendered by React Native (not the full Record screen scaled down):

```
+---------------------------+
|  ● REC        00:42       |
|   ▁▃▅▇▅▃▁▃▅▇▅▃▁           |
|     [ ‖ Pause ] [ ■ Stop ]|   ← native PiP RemoteAction buttons
+---------------------------+
```

Aspect ratio ≈ 16:9. Timer and level come from `recordingStore`. The Pause/Stop controls are
native `RemoteAction`s (reliable at PiP size), not RN-drawn buttons.

## Architecture & components

### Native

1. **PiP entry — `MainActivity`**
   - Manifest: `android:supportsPictureInPicture="true"` (the required `configChanges` —
     `screenSize|smallestScreenSize|screenLayout|orientation` — are already present).
   - `onUserLeaveHint()`: if `CaptureController.isRecording` and PiP is supported/enabled →
     `enterPictureInPictureMode(buildParams())`.
   - Root Back handler: if recording and the back press would exit the app → enter PiP instead.
   - `onPictureInPictureModeChanged(isInPip, ...)`: emit `onPipModeChanged` (boolean) to JS.
   - `buildParams()`: set aspect ratio and `setActions(pauseOrResume, stop)`.

2. **PiP actions — `PipActionReceiver` (BroadcastReceiver)**
   - Registered for `com.audionotes.pip.PAUSE`, `.RESUME`, `.STOP`.
   - PAUSE/RESUME → `CaptureController.applyPause(...)`, then `setPictureInPictureParams(...)`
     to swap the Pause↔Resume `RemoteAction`.
   - STOP → `CaptureController.stop(...)`; the mode change to non-PiP follows from capture ending.
   - Actions carry `PendingIntent`s built with the `FLAG_IMMUTABLE` + broadcast pattern.

3. **`Pip` TurboModule** (`NativePip.ts` spec)
   - `isSupported(): Promise<boolean>` — device/OS PiP availability.
   - Event: `onPipModeChanged` `{ inPip: boolean }`.
   - (Entry is native via `onUserLeaveHint`; no JS-triggered `enter()` needed for v1.)

### React Native

4. **PiP compact view** — a top-level component (mounted in `App`/`RootNavigator`) that, when
   `inPip === true`, renders the minimal timer + waveform from `recordingStore`; otherwise
   renders nothing and the normal navigator shows.

5. **In-app recording bar** — a component shown on non-Record screens when
   `recordingStore.isRecording`: `● Recording 00:42` + `■` stop; tapping the bar navigates to
   the Record screen.

6. **Record screen back** — the existing chevron (`navigation.goBack()`) already returns to
   Library; the recording bar makes that state visible. No behavioural change beyond the bar.

### Removal (retiring the overlay bubble)

Delete or untangle:
- `android/.../overlay/*` — `BubbleView`, `DismissView`, `PipDrawer`, `BubbleAccessibilityHelper`,
  `Scale`, `Palette` (overlay).
- `OverlayService`, `OverlayModule`, and `ForegroundTracker` (its auto-show is what PiP replaces).
- `src/native/NativeOverlay.ts` and its usages.
- Settings: the **Float** toggle and the "display over other apps" permission prompt/section.
- Manifest: the `SYSTEM_ALERT_WINDOW` permission and `OverlayService` declaration.
- `CaptureController`: remove references to `OverlayService`.

Keep: `RecordTileService` (Quick Settings tile) — it still starts recording. The
`floatEnabled` setting is removed; a recording started from the tile with the app closed is
controlled by the notification.

## Data flow

`CaptureController` (native, source of truth) → capture-state events → `recordingStore` (JS) →
Record screen, in-app recording bar, and PiP compact view. PiP action taps → `PipActionReceiver`
→ `CaptureController` → the same state events flow back so every surface stays in sync.

## Edge cases & error handling

- **PiP unsupported / disabled by the user** in system settings: phone PiP is effectively
  Android 8 (API 26)+, and `minSdkVersion` is 24, so on API 24–25 (and any device where the
  user disabled PiP for the app) `Pip.isSupported()` returns false. `enterPictureInPictureMode`
  is guarded (support check + caught failure) → the app just backgrounds normally and the
  notification remains the control. No crash.
- **Recording stops while in PiP**: exit PiP.
- **Rotation / config change in PiP**: handled by existing `configChanges`.
- **Never enter PiP when not recording.**

## Testing

- **Native (instrumented):** `onUserLeaveHint` enters PiP only while recording; `PipActionReceiver`
  routes STOP/PAUSE/RESUME to `CaptureController`; the Pause↔Resume action icon swaps on toggle.
- **JS:** in-app recording bar visibility is keyed to recording state; the PiP compact view renders
  on `onPipModeChanged(true)` and unmounts on `false`.
- **Manual on device:** record → Home → PiP floats over another app; Pause/Stop from PiP; tap PiP
  to reopen; in-app Back → Library shows the recording bar; stop from the bar.

## Rollout note

PiP requires no runtime permission, so removing the "display over other apps" flow is a net
reduction in first-run friction. The APK-size / model-download work is unaffected.
