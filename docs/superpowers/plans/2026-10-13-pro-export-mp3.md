# Pro-only export and MP3 export — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Every file export (MP3, SRT, PDF, Markdown, text) is Pro-only, enforced in the native export module; Copy/render/preview stay free; add an MP3 export of the original recording.

**Architecture:** A pure `ExportGate` (Kotlin, JVM-testable) decides refusals; `FileExportModule.share/shareWith/exportMp3` call it first with `LicenceStore.current(ctx).isPaid`. MP3: a pure chunked `Mp3Export.encode` loop over an `Mp3Encoder` interface (JVM-tested with a fake), backed on device by `LameEncoder` → JNI shim `libverbale_mp3.so` → LAME 3.100 vendored as its own SHARED `libmp3lame.so` (LGPL, replaceable). JS: Share screen turns `PRO_REQUIRED` into the existing Pro sheet (`Paywall` route), adds an MP3 row that is disabled when audio is gone.

**Tech Stack:** Kotlin, JNI/CMake (NDK 28, 4 ABIs), LAME 3.100 (vendored, sha256 ddfe36ca…da1e), React Native TS, jest, JUnit, `am instrument`.

**Decisions made while planning (not in the spec):**
- The "Pro sheet" in the spec is the existing `Paywall` route (`navigation.navigate('Paywall', { meetingId })`).
- "Audio gone" = `audio_retained = 0` **or** the file missing/empty (the column is only ever written 0; `Player.hasAudio` already looks at the file, so the Share screen reuses `Player.hasAudio` and no new `db.*` query is needed — MeetingScreen test stubs unaffected).
- The share sheet is asynchronous, so the MP3 cannot be deleted the instant `startActivity` returns without breaking the receiving app's read. Cleanup is: sweep `cache/exports/` at app start and before every new export. Reported as a deviation.
- `ShareAvailability.test.tsx` encoded the old "free for everyone" rule; it is rewritten to the new rule (the screen still imports nothing from billing; it only reads `e.code === 'PRO_REQUIRED'`).

---

### Task 1: ExportGate (gate logic + mutants)
**Files:** Create `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ExportGate.kt`, test `android/app/src/test/java/com/innocorelabs/verbale/pipeline/ExportGateTest.kt`, `scripts/mutate-export.py`; modify `scripts/gate.sh` (`stage_mutations`).
- [ ] Tests first: for each of `pdf md txt srt mp3`: Free → `PRO_REQUIRED`, Pro → allowed; ops `render`, `copy`, `preview` allowed for Free; unknown format is refused for Free (fail closed).
- [ ] Implement `object ExportGate { const val PRO_REQUIRED; val FILE_FORMATS; fun refusal(op: String, format: String, paid: Boolean): String? }`.
- [ ] `FileExportModule`: `share`, `shareWith`, `exportMp3` call `ExportGate.refusal(...)` first and `promise.reject(PRO_REQUIRED, ...)`; source-level test pins that all three call it before any work.
- [ ] `scripts/mutate-export.py` (clone of mutate-reconciler): mutants = gate removed (always null), inverted, `mp3` skipped, `srt` skipped, render gated, unknown-format allowed. All must be killed. Hook into `stage_mutations`.
- [ ] Commit.

### Task 2: Mp3Export core (audio-deleted path + chunked loop)
**Files:** Create `.../pipeline/Mp3Export.kt`, test `.../Mp3ExportTest.kt`.
- [ ] Tests first: `audioState(retainedFlag, file)` → `Missing` when flag 0, when file null/absent/empty; `Ok` otherwise; message constant is exactly "The recording for this meeting was deleted, so there is nothing to export."; `encode()` with a fake encoder reads in chunks ≤ `CHUNK_BYTES`, never holds the whole input (max single read asserted), reports monotonic progress ending at 1.0, stops and returns `Cancelled` when the flag flips, odd trailing byte dropped, the module-level sweep deletes everything in a dir.
- [ ] Implement `interface Mp3Encoder { fun encode(pcm: ShortArray, n: Int, out: ByteArray): Int; fun flush(out: ByteArray): Int }`, `Mp3Export.encode(input: InputStream, totalBytes: Long, enc, out: OutputStream, cancelled: () -> Boolean, onProgress: (Double) -> Unit): Result`, `audioState`, `sweep(dir)`, `safeName(title)`.
- [ ] Mutants (add to mutate-export.py): deleted-audio check removed, retained-flag ignored, file-empty ignored, cancel ignored, whole-file read (chunk size = MAX), progress never reaches 1. All killed.
- [ ] Commit.

### Task 3: LAME + JNI + LameEncoder + module
**Files:** Create `cpp/third_party/lame/**` (vendored, unmodified + our CMakeLists), `android/app/src/main/jni/mp3_jni.cpp`, `.../pipeline/LameEncoder.kt`; modify `android/app/src/main/jni/CMakeLists.txt`, `FileExportModule.kt` (`exportMp3`, `cancelMp3`, `addListener`, `removeListeners`), `MainApplication.kt` (sweep at start), `scripts/device-verify.sh` (CLASSES).
- [x] Vendor LAME (libmp3lame only, no mpglib/frontend), build `libmp3lame.so` as SHARED for arm64-v8a, armeabi-v7a, x86_64, x86 — done in planning, all four link.
- [ ] JNI shim: `lame_init`, `lame_set_in_samplerate(16000)`, `set_num_channels(1)`, `set_mode(MONO)`, `set_brate(64)`, `set_VBR(vbr_off)`, ID3 title + year + comment (recording date), `lame_init_params`, `lame_encode_buffer`, `lame_encode_flush`, `lame_close`; handle in a `jlong`.
- [ ] `exportMp3(meetingId, promise)`: gate → `audioState` → sweep → encode to `cache/exports/<title>.mp3` on a worker thread, emit `onMp3Progress {fraction}`, share via the same chooser path as other formats (`audio/mpeg`). Rejects with code `AUDIO_DELETED` and the message above; `cancelMp3` flips the flag and the partial file is deleted.
- [ ] Device test `Mp3EncoderTest` (androidTest): encode a 1000 Hz tone for 20 s, decode with `MediaExtractor`+`MediaCodec`, assert duration ±0.2 s and dominant frequency 1000 Hz ±20 (Goertzel scan); stream 1 h synthetic PCM from a generator `InputStream`, assert heap growth < 16 MB. Register in `device-verify.sh`.
- [ ] Commit (library + CMake separately from the module).

### Task 4: JS — spec, formats, Share screen
**Files:** `src/native/NativeFileExport.ts`, `src/share/formats.ts`, `src/share/SharePreviewScreen.tsx`, tests `src/share/__tests__/SharePreviewScreen.test.tsx`, `ShareAvailability.test.tsx` (rewritten), new `ShareProGate.test.tsx`.
- [ ] Spec: `exportMp3(meetingId): Promise<void>`, `cancelMp3()`, listener methods; `shareWith`/`share` formats unchanged.
- [ ] Tests first: `PRO_REQUIRED` rejection from `shareWith` → `navigation.navigate('Paywall', { meetingId })` and no "Could not share" alert; same for `exportMp3`; MP3 row present; with `Player.hasAudio → false` the MP3 option is disabled and shows the deleted-audio sentence; with audio, Share on MP3 calls `exportMp3` not `shareWith`; progress shown and Cancel calls `cancelMp3`; preview for MP3 does not call `FileExport.preview`.
- [ ] Implement. MP3 hint: "The original recording, 64 kbps — about 28 MB an hour."
- [ ] Mutants (JS, run by hand + recorded in report): remove PRO_REQUIRED branch; always enable MP3; use shareWith for mp3. Each must fail a test.
- [ ] Commit.

### Task 5: Wording and notices
**Files:** `src/screens/PaywallScreen.tsx` (+ test), `src/screens/MeetingScreen.tsx` (hint), `src/billing/recordingCap.ts` comment, `docs/play-console.md`, `server/app/landing.py` (+ its test if any), `scripts/build-notices.py`, `src/legal/notices.ts`.
- [ ] Pro sheet gets a row "Export: MP3, PDF, SRT, Markdown, text"; `FREE_FOREVER` drops "export"; the "Export stays free deliberately" comment is replaced.
- [ ] Export menu hint: "Pro. Share the minutes as PDF, Markdown, text or subtitles, or the original recording as MP3."
- [ ] play-console: remove the Free "Export as…" bullet; add to Pro list. landing: remove the Free export tick and the "export" claims in the two FAQs; add to Pro.
- [ ] Notices: LAME (LGPL-2.1) with licence text (from vendored `COPYING`) and link https://lame.sourceforge.io — generated by `build-notices.py` like the rest; existing Settings → Open-source notices screen already exists, so LAME is added there (nothing to fold in).
- [ ] Commit.

### Task 6: Gate, device check, report
- [ ] `scripts/gate.sh` full. Fix only failures this feature caused; stop and ask for anything else.
- [ ] Release APK size delta vs. main (stop if > ~1 MB).
- [ ] A07 (R9ZL402YH5A): focus check, install debug, Free refused → temporary FORCE_PRO_FOR_TESTING (never committed) → export a **synthetic** meeting (never the family's) → pull the MP3, verify with ffprobe. Never press POWER; never open real meeting contents.
- [ ] Report `docs/superpowers/reports/2026-10-13-pro-export-mp3.md`.
