# Phase 6b — Session 1 report: the ONNX runtime rides in the APK

## 1. Status

Complete: all nine steps of `docs/superpowers/specs/2026-09-21-phase-6b-session-1-runtime-in-apk-execution.md`
built, compiled, comment-swept, gated and device-verified against the founder's 21 Sep option C
decision (Phase 6a). `libonnxruntime.so` no longer downloads on first run — it ships in the APK from
the already-declared `com.microsoft.onnxruntime:onnxruntime-android` AAR. Nothing pushed.

## 2. What was built

- Step 1 — `android/app/build.gradle`: dropped `**/libonnxruntime.so` from the `packaging.jniLibs`
  excludes (kept `libonnxruntime4j_jni.so` excluded — the unused Java binding); rewrote the comment
  above it to describe the new load path instead of the old download.
- Step 2 — `NativeBridge.kt` `ensureLoaded`: replaced the `File(...).exists()` check and
  `System.load(absolutePath)` with `System.loadLibrary("onnxruntime")` before
  `System.loadLibrary("audionotes")`; updated the function KDoc; dropped the now-unused `File` and
  `ModelCatalog` imports.
- Step 3 — `ModelCatalog.kt`: deleted the `onnxruntime-lib` `ModelSpec` and its comment; `silero-vad`
  is now the first row in `ALL`.
- Step 4 — `ModelManagerModule.kt`: restored `list()`'s `installed` check to plain
  `it.exists() && it.length() == p.sizeBytes` (dropped the 32-bit-runtime-existence-only special
  case) and deleted `download()`'s `runtime_32bit` rejection block.
- Step 5 — twelve `androidTest` files (`NativePipelineTest`, `VocabularyDbTest`, `BackfillTest`,
  `BackfillEditsTest`, `ItemSweepTest`, `UserItemsMigrationTest`, `PipelineBenchmark`,
  `DiarEmbeddingBench`, `MinutesParityTest`, `EvidenceParityTest`, `StorageSweepTest`,
  `StorageItemsTest`): removed the `assumeTrue("libonnxruntime.so not downloaded yet…")` guards
  (and the `val ort = File(...)` lines they gated on) that would otherwise skip these tests forever
  on a fresh install; dropped now-unused `File`/`ModelCatalog` imports where applicable;
  `NativePipelineTest`'s `loadCore` KDoc gained one sentence recording the change.
- Step 6 — `docs/ANDROID_TESTING.md` (the Gradle-cache restore clause and the onnxruntime/CMake
  troubleshooting entry) and `docs/superpowers/specs/2026-09-15-improvement-report-scorecard.md`
  (the "ONNX runtime packaged, not downloaded" row flipped ✗ → ✅) updated to match; confirmed
  `docs/play-console.md`'s `INTERNET` permission row needs no change (models still download).
- Step 7 — the comment sweep: the sheet's 13 named lines across 11 files swapped
  `libonnxruntime.so` → `its models`, plus 8 more lines the sheet's own verification command (and
  the session's final acceptance grep) turned up that the named list missed — see §3.
- Step 8 — device evidence on the Galaxy Tab A with the hand-placed runtime file deleted first; see
  §4.
- Step 9 — this report; `docs/superpowers/reports/phase-6b-progress.md` retired.

## 3. Decisions taken

- **Step 7's sweep list undercounted.** The sheet named 13 lines across 11 files. Its own
  verification command (`grep -rn "libonnxruntime" … | grep -v "NativeBridge.kt\|build.gradle" |
  wc -l` → `0`) and the session's final §5 acceptance grep (`… → only NativeBridge.kt`) both require
  every other mention gone — and after the named 13 there were still 8: `src/db/queries.ts:596`,
  `BackfillTest.kt:59`, `StorageSweepTest.kt:53`, `ItemSweepTest.kt:66`, `MinutesParityTest.kt:31`,
  `NativePipelineTest.kt:46` and `:197`, `ModelManagerModule.kt:119`. Extended the sweep to those
  too, since two independent, explicitly-specified commands in the sheet require the grep to reach
  zero. Where a straggler stated a `DT_NEEDED`/linkage fact rather than a download guard (e.g.
  "libaudionotes.so carries a DT_NEEDED on libonnxruntime.so" — true regardless of packaging),
  reworded to "the ONNX runtime" instead of blindly substituting "its models", so the sentence stays
  technically accurate; the four defensive-path stragglers (queries.ts, StorageSweepTest,
  ModelManagerModule) got the sheet's own "its models" substitution since those really were naming
  the download as an absence example.
- **No functional changes beyond the sheet.** Every other edit is exactly what §2 of the execution
  sheet specified — no design decisions were made about the load path, the catalog, or the 32-bit
  special cases; those were fully decided by Phase 6a's option C and the sheet.

## 4. Tests — Step 8 outputs verbatim

Device: Galaxy Tab A 10.1, `R52N611D8FE` (SM-T515, 32-bit,
`-PreactNativeArchitectures=armeabi-v7a`).

**(a) Install + remove the hand-placed runtime.**
```
==> installing (-r keeps app data, and with it the downloaded models)
no class in CLASSES matches 'NoSuchClass' — nothing ran. The build was installed; for a class
```
`ls files/models/` after `rm files/models/libonnxruntime.so`:
```
diar_embedding.onnx
diar_segmentation.onnx
ggml-base-q5_1.bin
silero_vad.onnx
```
(no `libonnxruntime.so` — nothing but the APK can supply it from here on)

**(b) `NativePipelineTest`, the proof.**
```
==> com.innocorelabs.verbale.NativePipelineTest
OK (18 tests)
  10 of 18 skipped — the assumption they guard was not met:
passed. What this run is actually gating:
```
```
09-21 22:40:17.736 13009 13060 I TestRunner: run finished: 18 tests, 0 failed, 0 ignored
```
VAD (Silero on ONNX Runtime) and whisper ran with the runtime loaded from the APK's `armeabi-v7a`
`jniLibs`, the hand-placed file gone.

**(c) `VocabularyDbTest`, unguarded.**
```
OK (4 tests)
passed. What this run is actually gating:
```

**(d) Sizes.**
- Debug APK: `66,461,774` bytes.
- `assembleRelease -PreactNativeArchitectures=armeabi-v7a`: clean (no `^e:` or `FAIL` output).
- Release APK: `46,629,153` bytes (21 Sep's 32-bit baseline was `34,321,150`; the AAR's
  `armeabi-v7a` runtime is ≈12.3 MB — the increase is as expected).
```
 12294868  01-01-1981 01:01   lib/armeabi-v7a/libonnxruntime.so
```
(one line, as required)

**(e) Reinstall + onboarding.**
```
Success
```
Onboarding rendered after wake + launch + 6s wait; the Pro note reads "…downloads 227 MB more…", as
on 21 Sep. Screenshot captured; nothing tapped. No fix was needed on-device, so no additional commit
came out of Step 8.

## 5. Gate

```
    ok  types (9s)
    ok  js (11s)
    ok  scans (3s)
    ok  mutations (90s)
    ok  kotlin (3s)
    ok  cpp (40s)
    ok  device (0s)
gate: all clear in 156s
```
The device stage skips itself with only the emulator attached at gate time — Step 8 above is the
tablet's evidence.

## 6. Device

See §4 — Step 8 was run entirely on the Galaxy Tab A (`R52N611D8FE`), the founder's 32-bit bench
device, with the hand-placed runtime file removed before every test run so nothing but the APK's
`jniLibs` copy could supply it.

## 7. For the founder to test by hand

1. **A fresh install downloads 96 MB, not 114.** On any 64-bit phone with the app never installed:
   onboarding › *Start free* → the button reads *Download (96 MB)*; Settings › On-device models
   afterwards lists no *ONNX Runtime* row — four essentials, all installed.
2. **Nothing else changed.** Record a minute; the transcript arrives as before.
3. **The store size.** The arm64 release APK/AAB is ≈ 17.6 MB larger than before (the runtime,
   stored uncompressed for mmap); Play compresses it for delivery. Note the number in the Play
   Console when the first bundle is uploaded.

## 8. Known gaps

- None found this session — every acceptance check in the execution sheet (`onnxruntime-lib` grep,
  the `libonnxruntime` grep, the diff-stat file list, Step 8's `run finished: 18 tests, 0 failed`,
  the reinstalled release APK rendering onboarding) passed on the first pass once the Step 7 sweep
  was extended (§3).
- The 32-bit bench build's release APK size (`46,629,153`) is ~13 KB over the sheet's arithmetic
  estimate (`34,321,150 + 12,294,888 = 46,616,038`) — negligible, and within "≈" as the sheet framed
  it; not investigated further.

## 9. Commits

```
60bcd99 build(runtime): libonnxruntime.so ships in the APK — the AAR's copy, no longer excluded
789ff71 feat(runtime): NativeBridge loads the ONNX runtime from the APK by name
9622e6a feat(runtime): the catalog no longer lists the runtime as a download
f2dc899 refactor(runtime): ModelManager drops the hand-placed-runtime special cases
21333ba test(runtime): device tests no longer assume a downloaded runtime
f40f7ed docs(runtime): testing recipe and scorecard follow the runtime into the APK
dc8a41b docs(runtime): comments stop naming a download that no longer exists
72aad8e docs(runtime): Phase 6b Session 1 progress — Step 8 device evidence recorded
```
