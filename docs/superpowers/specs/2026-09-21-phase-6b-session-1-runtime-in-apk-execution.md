# Phase 6b — Session 1 execution sheet: the ONNX runtime rides in the APK

*21 September 2026, against `da0d252`. One session, nine steps, ~100 builder steps. The founder's
decision of 21 Sep (Phase 6a, option C): keep the `INTERNET` permission for launch and stop
downloading the ONNX Runtime — ship it inside the APK. Do not design anything; every edit below is
decided.*

**Why.** `libonnxruntime.so` (17.6 MB) is the one thing the app fetches that is not a model: it
comes from a GitHub release, is sha256-checked, and is `System.load()`ed by absolute path before the
core. It was kept out of the APK to keep the install small. The Gradle dependency that would ship it
is ALREADY declared (`com.microsoft.onnxruntime:onnxruntime-android:1.20.0`, 16 KB page aligned);
one `packaging.excludes` line keeps its `.so` out. Removing that line puts the runtime in every ABI's
`jniLibs`; the rest of this sheet deletes what only existed because it was downloaded. Net effect:
first-run download 114 → 96 MB, one fewer thing that can fail before a phone can transcribe, the
improvement report's "ONNX runtime packaged, not downloaded" item closed, and the 32-bit bench no
longer needs a hand-placed file. **The trap:** thirteen device tests `assumeTrue` that
`files/models/libonnxruntime.so` exists. After this change that file never exists on a fresh phone —
left in place, every device test would skip forever and `device-verify.sh` would print "passed".
Step 5 removes every one.

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. `grep -n` then `sed -n 'A,Bp'`,
  ≤ 60 lines at a time. Do not re-read a file after editing it. Do not paste code into messages.
- **No new tests.** This session deletes code and one catalog row; the proof is the existing device
  suite loading the runtime from the APK (Step 8). `npx tsc --noEmit` and the Kotlin compile check
  each step.
- **Commit after each step**, house style (`git log --oneline -6`). Never push. Never run
  `connectedDebugAndroidTest`. **`git status` clean before you stop. Indent like the surrounding file.**
- **Progress file.** First action: create `docs/superpowers/reports/phase-6b-progress.md` with the
  nine steps as checkboxes and *Notes*. Update and commit with every step. Retired in Step 9.
- **The device** (Step 8 only): the Galaxy Tab A. Every shell that runs `adb` or `device-verify.sh`
  first runs, verbatim:
  `export ANDROID_SERIAL=R52N611D8FE ADB=~/Library/Android/sdk/platform-tools/adb DEVICE_VERIFY_GRADLE_ARGS=-PreactNativeArchitectures=armeabi-v7a`
  Never `adb uninstall`, never `pm clear`, never touch `emulator-5554`.
- **Hand-over at 150 steps**: commit, progress file, stop. Stop also on a §6 condition.

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `android/app/build.gradle` | 20–80, 170–190 | Step 1: the excludes line and its comment; the AAR extraction (read only) |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt` | 1–40 | Step 2 |
| `android/app/src/main/java/com/innocorelabs/verbale/data/ModelCatalog.kt` | 136–152 | Step 3: the row to delete |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ModelManagerModule.kt` | 50–70, 92–104 | Step 4: the two 32-bit runtime special cases |
| the thirteen `androidTest` files named in Step 5 | the lines named there | Step 5 |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/DiarBudget.kt` | 145–156 | Step 4: `is64BitProcess` stays (ProcessingEngine uses it) — read only |
| `docs/ANDROID_TESTING.md` | 44–50, 148–152 | Step 6 |
| `docs/superpowers/specs/2026-09-15-improvement-report-scorecard.md` | 119–123 | Step 6: one cell |
| `docs/play-console.md` | 84–92 | Step 6: the permission row's wording |
| `scripts/device-verify.sh` | 1–30 (read only) | Step 8: how the filter works |

**Must not change:** `cpp/**` (the `dlopen("libonnxruntime.so", RTLD_GLOBAL)` in `util/ort_init.cpp`
resolves to the already-loaded copy by soname and needs nothing), `DeviceFit.kt`, `DiarBudget.kt`,
every screen, every jest test, `scripts/*`.

---

## 2. Steps

### Step 1 — the `.so` comes back into the APK

`android/app/build.gradle`, the `packaging { jniLibs { … } }` block (≈ 172–188). The line

```groovy
            excludes += ['**/libonnxruntime4j_jni.so', '**/libonnxruntime.so']
```

becomes

```groovy
            excludes += ['**/libonnxruntime4j_jni.so']
```

and the comment's last paragraph (from `// libonnxruntime.so itself is ALSO kept out of the APK`
through `// … RTLD_GLOBAL dlopen in ort_init.cpp.`) is replaced by:

```groovy
            // libonnxruntime.so itself rides in the APK (Phase 6a, 21 Sep 2026 — the founder's
            // option C). It was a first-run download for 17 MB of install size; that was one more
            // thing that could fail before a phone could transcribe at all, and the improvement
            // report's open "runtime packaged, not downloaded" item. NativeBridge.ensureLoaded()
            // System.loadLibrary("onnxruntime")s it before libaudionotes.so, which satisfies that
            // library's DT_NEEDED and the RTLD_GLOBAL dlopen in ort_init.cpp.
```

Command: `grep -c "libonnxruntime.so'" android/app/build.gradle` → `0`.
Commit: `build(runtime): libonnxruntime.so ships in the APK — the AAR's copy, no longer excluded`.

### Step 2 — the core loads it by name

`NativeBridge.kt` `ensureLoaded` (≈ 22–36). The lines

```kotlin
    val ort = File(ModelCatalog.modelsDir(context), "libonnxruntime.so")
    check(ort.exists()) {
      "libonnxruntime.so not downloaded yet — ModelManager must fetch \"onnxruntime-lib\" first"
    }
    // Loading executable code from a writable file draws a W^X warning ("will throw on a future
    // Android version") — clear the write bit first so the loaded .so is read-only.
    if (ort.canWrite()) ort.setReadOnly()
    System.load(ort.absolutePath)
    System.loadLibrary("audionotes")
```

become

```kotlin
    // The runtime first, by name from the APK's jniLibs, so libaudionotes.so's DT_NEEDED and the
    // RTLD_GLOBAL dlopen in util/ort_init.cpp both resolve to this one loaded copy.
    System.loadLibrary("onnxruntime")
    System.loadLibrary("audionotes")
```

The KDoc above the function (the paragraph beginning `Load the native core. libonnxruntime.so is
NOT packaged in the APK`) becomes:

```kotlin
  /**
   * Load the native core: the ONNX runtime from the APK, then libaudionotes.so, whose DT_NEEDED on
   * libonnxruntime.so and whose RTLD_GLOBAL dlopen in util/ort_init.cpp both resolve to that one
   * loaded copy. Idempotent; every caller invokes it before its first native call. The `context`
   * stays in the signature for the processor check and for callers that pass it.
   */
```

If `File` and `ModelCatalog` are now unused in the file (`grep -c "File(\|ModelCatalog\." …` → `0`),
delete their imports. Command:
`cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 | grep -E "^e:"; cd ..` → nothing.
Commit: `feat(runtime): NativeBridge loads the ONNX runtime from the APK by name`.

### Step 3 — the catalog forgets the download

`ModelCatalog.kt` 138–150: delete the comment block beginning `// The ONNX Runtime shared library
is not a model` and the whole `ModelSpec("onnxruntime-lib", …)` entry that follows it (through its
closing `),`). `silero-vad` becomes the first row. Command:
`grep -c "onnxruntime-lib\|\"runtime\"" android/app/src/main/java/com/innocorelabs/verbale/data/ModelCatalog.kt` → `0`.
Commit: `feat(runtime): the catalog no longer lists the runtime as a download`.

### Step 4 — the two 32-bit special cases go

`ModelManagerModule.kt`. In `list()`, the `installed` expression (≈ 54–62) currently reads:

```kotlin
          .put("installed", spec.parts.all { p ->
            File(dir, p.filename).let {
              it.exists() &&
                // The catalog only knows the 64-bit runtime. A 32-bit bench build (the 2019
                // Galaxy Tab A) has the 32-bit one hand-placed at the same name and a different
                // size; reporting it "not installed" would make onboarding fetch the 64-bit one
                // over it and the pipeline could never load again. Existence is the whole test there.
                (it.length() == p.sizeBytes || (spec.kind == "runtime" && !DiarBudget.is64BitProcess()))
            }
          })
```

Restore its pre-bench shape:

```kotlin
          .put("installed", spec.parts.all { p ->
            File(dir, p.filename).let { it.exists() && it.length() == p.sizeBytes }
          })
```

In `download()`, delete the block

```kotlin
    // See list(): the download would replace the hand-placed 32-bit runtime with the 64-bit one.
    if (spec.kind == "runtime" && !DiarBudget.is64BitProcess()) {
      promise.reject("runtime_32bit", "The 32-bit runtime is placed by hand on this device; nothing to download.")
      return
    }
```

(the `DeviceFit.cpuReason()` block that followed it now comes directly after the `no_model` check).
If `DiarBudget` is no longer referenced in the file (`grep -c "DiarBudget" …` → `0`) delete its
import. Command: the Kotlin compile line → nothing; `grep -c '"runtime"' android/app/src/main/java/com/innocorelabs/verbale/pipeline/ModelManagerModule.kt` → `0`.
Commit: `refactor(runtime): ModelManager drops the hand-placed-runtime special cases`.

### Step 5 — thirteen device tests stop waiting for a download that will never come

In each file below, delete exactly the named lines (the `val ort = …` and its `assumeTrue(…)`, or
the three-line `assumeTrue(` form). Where a `// The core still cannot load without its downloaded
dependency…` comment sits directly above, delete those two comment lines too. Nothing else changes.

| File (`android/app/src/androidTest/java/com/innocorelabs/verbale/`) | Delete |
|---|---|
| `NativePipelineTest.kt` | 54–55 |
| `VocabularyDbTest.kt` | 109–110 |
| `BackfillTest.kt` | 64–65 |
| `BackfillEditsTest.kt` | 58–59 |
| `ItemSweepTest.kt` | 71–72 |
| `UserItemsMigrationTest.kt` | 68–69 |
| `PipelineBenchmark.kt` | 41–42 |
| `DiarEmbeddingBench.kt` | 43–44 |
| `MinutesParityTest.kt` | 46–48 (`val ort`, a blank or comment line if one sits between, `assumeTrue`) |
| `EvidenceParityTest.kt` | 50–52 (same shape) |
| `StorageSweepTest.kt` | 65–70 (the two comment lines and the three-line `assumeTrue(…)`) |
| `StorageItemsTest.kt` | 55–60 (same shape) |

Confirm line numbers with `grep -n "libonnxruntime" <file>` before each deletion — deleting earlier
lines in a file shifts nothing here because each file is edited once. In `NativePipelineTest.kt`,
append one sentence to the `loadCore` KDoc's last paragraph: `Since 21 Sep 2026 the runtime rides in
the APK, so the download guard that lived here is gone.` Then `File` and `ModelCatalog` imports may be
unused in some of these files — check each with `grep -c "File(\|ModelCatalog\." <file>` and delete
the import only when the count is `0`.

Command: `grep -rln "libonnxruntime.so not downloaded" android/app/src/androidTest` → nothing;
`cd android && ./gradlew :app:compileDebugAndroidTestKotlin -q 2>&1 | grep -E "^e:"; cd ..` → nothing.
Commit: `test(runtime): device tests no longer assume a downloaded runtime`.

### Step 6 — the documents

- `docs/ANDROID_TESTING.md` 45–50: in the "Restoring the models" paragraph, delete the clause
  `and \`libonnxruntime.so\` is in the Gradle cache under \`onnxruntime-android-1.20.0/jni/arm64-v8a/\``
  (and fix the sentence's punctuation). Lines 148–152: replace `The \`.so\` is still supplied by the
  … AAR (packaged into the APK), so keep that dependency; no prefab config is needed.` with
  `The \`.so\` ships in the APK from the … AAR since 21 Sep 2026 (it was a first-run download before);
  keep that dependency; no prefab config is needed.`
- `docs/superpowers/specs/2026-09-15-improvement-report-scorecard.md` line 121: `| ONNX runtime
  packaged, not downloaded | ✗ | still a separate download, hash-checked |` → `| ONNX runtime
  packaged, not downloaded | ✅ | in the APK since 21 Sep (Phase 6b Session 1) |`.
- `docs/play-console.md` line 87: `| \`INTERNET\` | Downloading models on first run; the subscription check |`
  — unchanged (models still download).

Commit: `docs(runtime): testing recipe and scorecard follow the runtime into the APK`.

### Step 7 — the comment sweep

These comments explain defensive paths by naming the runtime download. The paths stay (models can
still be absent); only the example changes. In each, replace the words `libonnxruntime.so` with
`its models` — one line each, nothing else on the line changes:

`android/.../data/AudioDb.kt:2495` · `android/.../pipeline/StorageModule.kt:80` and `:103` ·
`android/.../pipeline/FileExportModule.kt:442` · `android/.../pipeline/LiveTranscriber.kt:104` ·
`android/.../pipeline/LlmModule.kt:46` · `android/.../pipeline/ProcessingEngine.kt:38` ·
`src/state/libraryStore.ts:238` · `src/screens/MeetingScreen.tsx:228` · `src/screens/meeting/shared.tsx:195` ·
`src/state/__tests__/libraryStore.test.ts:160` · `android/app/src/test/.../pipeline/ExportItemsTest.kt:377` ·
`android/app/src/androidTest/.../UserItemsMigrationTest.kt:560` and `:606`.

Confirm each line with `grep -n "libonnxruntime" <file>` first (line numbers may have moved by
Step 5 in the test files). Command: `grep -rn "libonnxruntime" src android/app/src --include='*.kt' --include='*.ts' --include='*.tsx' | grep -v "NativeBridge.kt\|build.gradle" | wc -l` → `0`;
`npx tsc --noEmit 2>&1 | grep -c error` → `0`; `npx jest src/state 2>&1 | grep -E "Tests:"` → all passed.
Commit: `docs(runtime): comments stop naming a download that no longer exists`.

### Step 8 — the device proves the APK's copy is the one that loads

(the `export` line first)

(a) Install the new debug build and remove the hand-placed copy so nothing but the APK can supply
the runtime: `scripts/device-verify.sh NoSuchClass 2>&1 | grep -E "installing|no class"` → the
install line, then the no-match message (expected: it installed and ran nothing). Then
`$ADB shell run-as com.innocorelabs.verbale rm files/models/libonnxruntime.so; $ADB shell run-as com.innocorelabs.verbale ls files/models/`
→ a listing WITHOUT `libonnxruntime.so`.

(b) `scripts/device-verify.sh NativePipelineTest 2>&1 | grep -E "^==>|OK \(|FAILURES|skipped|passed|FAILED"`
→ `OK (18 tests)`, `10 of 18 skipped` (the same ten model-absence skips as 21 Sep), `passed`.
Then `$ADB logcat -d | grep "TestRunner: run finished" | tail -1` → `run finished: 18 tests, 0 failed, 0 ignored`.
This is the proof: VAD (Silero on ONNX Runtime) and whisper ran with the runtime loaded from the
APK's `armeabi-v7a` `jniLibs`, the hand-placed file gone. ~8 minutes on this tablet.

(c) `scripts/device-verify.sh VocabularyDbTest 2>&1 | grep -E "OK \(|FAILURES|passed"` → `OK (4 tests)` —
the dictation test now runs unguarded.

(d) Sizes: `ls -la android/app/build/outputs/apk/debug/app-debug.apk | awk '{print $5}'` → note it;
then the release: `cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=armeabi-v7a -q 2>&1 | grep -E "^e:|FAIL"; cd ..`
→ nothing; `ls -la android/app/build/outputs/apk/release/app-release.apk | awk '{print $5}'` → note it
(expected ≈ 18 MB more than 21 Sep's 34,321,150 for the 32-bit release). `unzip -l android/app/build/outputs/apk/release/app-release.apk | grep libonnxruntime` → one line, `lib/armeabi-v7a/libonnxruntime.so`.

(e) `$ADB shell am force-stop com.innocorelabs.verbale; $ADB install -r android/app/build/outputs/apk/release/app-release.apk 2>&1 | tail -1` → `Success`.
Wake the tablet (`$ADB shell input keyevent KEYCODE_WAKEUP; $ADB shell input keyevent KEYCODE_MENU`), launch
(`$ADB shell monkey -p com.innocorelabs.verbale -c android.intent.category.LAUNCHER 1`), wait 6 s,
`$ADB exec-out screencap -p > /tmp/onb.png` — the onboarding screen must render (the Pro note reading
`…downloads 227 MB more…` as on 21 Sep). Record "rendered" in the progress file; do not tap anything.

Commit nothing new here unless a fix was needed; record every number in the progress file.

### Step 9 — gate, report, hand-over

`scripts/gate.sh 2>&1 | grep -E "^\s+(ok|FAIL)|gate:"` → every stage `ok`, `gate: all clear` (its
device stage skips itself with the emulator attached — Step 8 is the device evidence). Write
`docs/superpowers/reports/2026-09-21-phase-6b-session-1-runtime-in-apk.md` with the Phase 5 report's
sections (status · built · decisions · tests — the Step 8 outputs verbatim · gate · device · for the
founder to test by hand (§7 below) · known gaps · commits). `git rm docs/superpowers/reports/phase-6b-progress.md`.
Commit: `docs(runtime): Phase 6b Session 1 report; progress file retired`. `git status` → clean. Stop.

---

## 3. Expected interfaces after this session

- `ModelManager.list()` no longer returns an `onnxruntime-lib` row; `REQUIRED` = silero-vad,
  whisper-base, diar-seg, diar-emb (96,309,226 bytes).
- `NativeBridge.ensureLoaded(context)`: same signature; loads `onnxruntime` then `audionotes` by name.
- No JS, screen, settings-key or C++ change.

## 4. Exact tests and commands

| Step | Command | Must print |
|---|---|---|
| 2, 4 | `cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 \| grep -E "^e:"; cd ..` | nothing |
| 5 | `cd android && ./gradlew :app:compileDebugAndroidTestKotlin -q 2>&1 \| grep -E "^e:"; cd ..` | nothing |
| 7 | `npx tsc --noEmit 2>&1 \| grep -c error` | `0` |
| 8b | `scripts/device-verify.sh NativePipelineTest …` | `OK (18 tests)`, 10 skipped, `passed` |
| 8c | `scripts/device-verify.sh VocabularyDbTest …` | `OK (4 tests)` |
| 8d | `unzip -l …/app-release.apk \| grep libonnxruntime` | `lib/armeabi-v7a/libonnxruntime.so` |
| 9 | `scripts/gate.sh …` | all `ok`, `gate: all clear` |

## 5. Acceptance

- `grep -rn "onnxruntime-lib" android/app/src src docs/ANDROID_TESTING.md` → nothing.
- `grep -rn "libonnxruntime" android/app/src src --include='*.kt' --include='*.ts' --include='*.tsx'` →
  only `NativeBridge.kt` (its KDoc and the `loadLibrary` comment).
- `git diff --stat da0d252..HEAD` names: `build.gradle`, `NativeBridge.kt`, `ModelCatalog.kt`,
  `ModelManagerModule.kt`, the twelve androidTest files of Step 5 (+ `UserItemsMigrationTest.kt`'s
  comment lines), the Step 7 files, the three docs of Step 6, the report; the progress file's creation
  and removal. Nothing else.
- Step 8's `run finished: 18 tests, 0 failed` with the hand-placed runtime deleted first.
- The release APK reinstalled and rendering onboarding.

## 6. Stop conditions

- The Kotlin or androidTest compile fails twice on one error → stop, record.
- Step 8(b) fails or the runtime is not in the APK listing → stop, record the exact output; do NOT
  restore the hand-placed file — the fix belongs in the build, not on the device.
- The tablet is absent → do Steps 1–7 and 9 with §6 of the report saying "device: not run", stop.
- 150 steps → commit, progress file, stop.

## 7. For the founder to test by hand (copied into the report)

1. **A fresh install downloads 96 MB, not 114.** On any 64-bit phone with the app never installed:
   onboarding › *Start free* → the button reads *Download (96 MB)*; Settings › On-device models
   afterwards lists no *ONNX Runtime* row — four essentials, all installed.
2. **Nothing else changed.** Record a minute; the transcript arrives as before.
3. **The store size.** The arm64 release APK/AAB is ≈ 18 MB larger than before (the runtime, stored
   uncompressed for mmap); Play compresses it for delivery. Note the number in the Play Console when
   the first bundle is uploaded.
