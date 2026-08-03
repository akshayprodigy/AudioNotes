# Onboarding, background recording & the floating recorder

Three capabilities added on top of the M1–M6 MVP.

## 1. Onboarding model download

- First launch shows **OnboardingScreen** (gated by an `onboarded` flag in the `settings` table).
  It downloads the two essentials — **Silero VAD** + **Whisper base** (~60 MB) — with a combined
  progress bar, and requests **battery-optimisation exemption** so background recordings survive.
- "Skip for now" is available; models can still be managed later in **Settings**.
- Once complete (or skipped), the flag is set and the app opens on the Library thereafter.

## 2. Background / screen-off recording (hardened)

Capture already ran in a mic-typed foreground service (survives backgrounding + screen off). Added:
- **Partial wake lock** in `RecordingService` (held while recording, 6 h safety cap) so the capture
  thread isn't frozen when the device idles.
- **`AudioPipeline.requestBatteryExemption()`** → the OS "ignore battery optimizations" prompt, so
  aggressive OEM battery managers don't kill long meetings. Offered during onboarding.
- Permissions added: `WAKE_LOCK`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

## 3. Floating recorder bubble (record over other apps, screen down)

Your primary use case: set the phone down, don't show the app, keep recording.

- **`OverlayService`** draws a small **draggable bubble** over other apps
  (`TYPE_APPLICATION_OVERLAY`). Tap = start/stop; drag = move. It shows a live timer while recording
  (red ring) and "REC" when idle (blue ring).
- **`CaptureController`** is a shared object so the bubble and the in-app Record button start/stop the
  *same* capture — one source of truth for "recording / which meeting / since when".
- **`Overlay` module** handles the "display over other apps" permission (`SYSTEM_ALERT_WINDOW`) and
  show/hide. Enable it from **Library → Float**.
- Having the overlay also grants the exemption to **start recording from the background**, which is
  what makes tap-to-record-from-the-bubble work while another app is in front.
- Meetings recorded via the bubble are saved as `captured`; on the next app open the Library runs
  **`processPending()`** to transcribe + summarise them (transcription/minutes are JS-orchestrated).

### Things to verify on-device (I can't test these from here)

- **Overlay permission flow**: Library → Float → "Open settings" → toggle on → return → Float again →
  bubble appears. Tap to record, open another app, confirm it keeps recording; lock the screen and
  confirm capture continues (check the meeting duration afterwards).
- **Bubble lifetime when idle**: the bubble is reliably alive while recording (the mic foreground
  service keeps the process up). If you want the idle bubble to survive low-memory kills, we should
  promote `OverlayService` to a foreground service — a small follow-up (needs an FGS type +
  notification; on Android 14+ that's `specialUse` with a Play Console justification).
- **Start-from-background**: starting a recording from the bubble while another app is foreground
  relies on the overlay exemption — verify on your Android version; if an OEM blocks it, we start a
  tiny FGS from a notification action instead.
- **Battery managers**: some OEMs (Xiaomi/Oppo/Samsung) need the app allow-listed manually beyond the
  standard exemption; note which devices need it.

### Play Store / consent note

Continuous background mic + overlay is sensitive. Keep the persistent recording notification and the
one-time consent gate (both already present), and add a prominent disclosure in the store listing.
Recording-consent laws vary by jurisdiction — keep the consent copy configurable.
