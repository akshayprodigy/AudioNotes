# Pro-only export and MP3 export — report

*13 October 2026. Spec: `docs/superpowers/specs/2026-10-13-pro-export-mp3-design.md`. Plan: `docs/superpowers/plans/2026-10-13-pro-export-mp3.md`. Nothing pushed, deployed, version-bumped or built into an AAB.*

## Verdict

Built and unit/mutation-verified. **Not verified on the Galaxy A07**: it was not attached (only the founder's personal Nothing A069, which I did not touch, and an arm64 emulator). The encoder device test passed on the emulator; the full `device` gate stage did not complete because the emulator died mid-run. Everything else in `scripts/gate.sh` is green. The A07 steps in "For you to test" are still to do.

## What was built

| Spec item | Where |
|---|---|
| Every file export is Pro; Copy/render/preview free | `ExportGate.kt` (pure) + `FileExportModule.refuseFree` called first in `shareWith` and `exportMp3` (`share` delegates to `shareWith`). Pro = `LicenceStore.current(ctx).isPaid`. Typed rejection `PRO_REQUIRED`. |
| Share screen → Pro sheet | `SharePreviewScreen.tsx`: `PRO_REQUIRED` → `navigation.navigate('Paywall', { meetingId })` (the existing Pro sheet); no error alert. Free users still see the screen and the preview. |
| MP3 of the original recording | `Mp3Export.kt` (rules + bounded chunk loop), `LameEncoder.kt` + `android/app/src/main/mp3/mp3_jni.cpp` (JNI shim), `FileExportModule.exportMp3/cancelMp3`. Source `audio.pcm`; 64 kbps CBR mono, 16 kHz; 64 KiB chunks (no whole-file buffer); `onMp3Progress` events; cancel; ID3v2 title + year + "Recorded <date>"; written to `cache/exports`. |
| LAME as a separate shared library | `cpp/third_party/lame` (3.100, libmp3lame only, unmodified; sha256 `ddfe36ca…da1e`) built as `libmp3lame.so`; the shim `libverbale_mp3.so` links it dynamically. Builds for **all four ABIs** (arm64-v8a, armeabi-v7a, x86_64, x86); packaged in the arm64 debug APK. |
| Deleted audio | `Mp3Export.audioState(retained, file)`: `audio_retained = 0`, no path, missing or empty file → `AUDIO_DELETED` with the exact sentence. Share screen disables the MP3 row and shows the sentence (via `Player.hasAudio`, so no new `db.*` query and no stub changes); also handles the native `AUDIO_DELETED`. |
| Open-source notices | The Settings → Open-source notices screen already existed and is generated; LAME added to `scripts/build-notices.py` with the full LGPL-2 text from the vendored `COPYING`, the project link, and "it is a separate library inside the app (libmp3lame.so), so it can be replaced". Nothing else needed folding in. |
| Wording | Pro sheet row "Export: MP3, PDF, SRT, Markdown, text"; Free line dropped from the Pro sheet's free-forever text; Export menu hint now starts "Pro."; `docs/play-console.md` and `server/app/landing.py` no longer call export free and list it under Pro (nothing deployed); stale comment in `recordingCap.ts` and the FOUNDER_TODO line fixed. |

## Tests and gate

- **ExportGateTest** (JVM): Free refused / Pro allowed for pdf, md, txt, srt, mp3 across share, shareWith, exportMp3; render/copy/preview free for every format; unknown format refused for Free; source-level checks that `shareWith` and `exportMp3` ask the gate before any work or thread and that `share` cannot go round it.
- **Mp3ExportTest** (JVM): deleted-audio rule (flag off / no path / missing / empty), the exact message, bounded reads (absolute bound, not self-referential), progress ends at exactly 1.0, cancel stops and does not flush, odd trailing byte, little-endian signed samples, sweep, safe filename, and the module checking audio before it encodes.
- **Mutants** — `scripts/mutate-export.py` (28, now in the gate's `mutations` stage): gate removed, gate inverted, each of mp3/srt/pdf/md/txt skipped, shareWith/exportMp3 un-gated, render gated, module never asks / asks with `paid=true`, deleted-audio checks removed (flag, empty, missing path), message changed, module skips audio check, bare error, cancel ignored, whole-file chunk, odd byte, big-endian, no flush, progress never 1 / overshoots, sweep no-op, empty title. **All 28 killed.** One self-referential assertion was found by this and fixed (`maxRead <= CHUNK_BYTES` quoted the constant back at itself).
- **JS** — `ShareProGate.test.tsx` (7 tests) + `scripts/mutate-share-screen.sh` (7 mutants, all killed): `PRO_REQUIRED` → Paywall, MP3 → Paywall, non-gate error still alerts, MP3 offered and routed to `exportMp3` (not `shareWith`, no preview), disabled with the sentence when audio is gone, native `AUDIO_DELETED` handled, progress shown and Cancel quiet. `ShareAvailability.test.tsx` reworded to the new rule (it still proves the screen/ShareDocument import no licence code). `lameNotice.test.ts` pins the LAME entry and licence text.
- **Device test** `Mp3EncoderTest` (registered in `device-verify.sh` CLASSES), run on the arm64 emulator: 440 Hz and 1000 Hz tones of 20 s decode (platform MP3 decoder) to the right duration (±0.3 s) and dominant frequency (±20 Hz), mono, ~8000 B/s; ID3 title and year present; **one hour of synthetic audio** (115 MB of PCM) stays under a 24 MB Java-heap and 24 MB native-heap bound and produces ~28.8 MB. Mutant: sample rate forced to 8000 Hz in the shim → 2 of 3 device tests fail (duration 40.2 s instead of 20; size 57.6 MB instead of 28.8). Source restored.
- **Gate (`ANDROID_SERIAL=emulator-5580 ./scripts/gate.sh`)**: types ✓, js ✓ (125 suites, 1270 tests), scans ✓, mutations ✓ (33 reconciler + 28 export), kotlin ✓, cpp ✓ (31/31), **device ✗** — see below.
- One full-suite run showed a single `MeetingScreen.test.tsx` failure that did not reproduce (42/42 alone; 1270/1270 in the gate run). I believe it was a timeout under load but did not catch it in the act.

## What I could not verify

1. **The Galaxy A07 was not attached.** None of the A07 steps were done: Free refused on a real Free install, Pro export on the real phone, the MP3 opening in a player, the share sheet round-trip, the deleted-audio path on a real meeting. No `FORCE_PRO_FOR_TESTING` was written or committed.
2. **Gate `device` stage did not complete.** On the emulator (arm64, slow: the app hit "failed to complete startup" ANRs earlier) the first class, `NativePipelineTest`, lost its adb shell and the emulator then died. That is outside this feature, and the only other device is the founder's personal phone, so I stopped there rather than run suites on it. The device classes were green on the A07 on 22 Sep; this change touches none of their code, but they have not been re-run since.
3. **The share sheet and the Paywall navigation were never exercised end to end** — only through mocks (JS) and the source-level checks (Kotlin). `FileExportModule` cannot be built in a JVM test.
4. **Release build / size.** I did not build the release AAB (out of scope). Measured: `libmp3lame.so` 245 KB + shim 40 KB stored in the arm64 debug APK; stripped+gzip of LAME is 101–123 KB per ABI. A release with arm64 + armeabi-v7a (+ x86_64) adds well under 1 MB (≈0.6–0.85 MB uncompressed worst case, ≈0.3 MB compressed). Not measured on an actual release APK.
5. 32-bit (armeabi-v7a) was only *compiled* (LAME standalone); the shim and the encoder test were not built or run for it.

## Deviations and decisions to look at

- **Cleanup of the shared file.** Spec: "shared, then deleted". The share sheet is asynchronous; deleting when `startActivity` returns would break the receiving app. Implemented instead: sweep `cache/exports/` at app start (`MainApplication`) and before every export (MP3 and documents). A shared file can therefore live until the next export or app start.
- **"Pro sheet" = the `Paywall` screen** (the only upsell surface; passes `meetingId`).
- **Backup is not gated.** Settings → Back up (`Backup.exportAndShare`) also puts a file in the share sheet. The spec names the five export formats and not backup, so I left it alone; the landing page still says "you can export or delete everything", which is true because of it. Your call if "all exports" should include it.
- **`FileExport.share`** (no-attribution variant, unused by the screens) is gated through `shareWith`.
- Server tests were not run (`server/.venv` has no pytest installed); `landing.py` compiles and no test references the changed lines.
- The A07's family meetings were never opened; nothing was written to either physical phone.

## For you to test (A07, ~10 minutes)

1. Install a debug build (`device-verify.sh` signs it with the upload key so data survives). Make a **new** test meeting (record a few seconds, or import a clip) — not the family's.
2. Free: open it → Export → Share screen shows the preview → tap Share → the Pro sheet opens, no share dialog. Tap MP3 (original recording) → Share → Pro sheet again.
3. Make it Pro (temporary `FORCE_PRO_FOR_TESTING` in `LicenceStore.current`, never committed) → Share PDF/Markdown/Text/Subtitles → the share dialog. MP3 → progress → share dialog → save/open the MP3 in a player: it should be the meeting's audio, ~0.5 MB/min.
4. Delete that test meeting's audio (or an old meeting with expired retention) → the MP3 row is greyed with "The recording for this meeting was deleted, so there is nothing to export."
5. Settings → Open-source notices → LAME 3.100 with the link and the LGPL text.
