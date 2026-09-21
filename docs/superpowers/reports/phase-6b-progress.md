# Phase 6b — Session 1 progress

Execution sheet: `docs/superpowers/specs/2026-09-21-phase-6b-session-1-runtime-in-apk-execution.md`

- [x] Step 1 — the `.so` comes back into the APK (`build.gradle`)
  - Notes: excludes line dropped `libonnxruntime.so`; comment rewritten. `grep -c "libonnxruntime.so'"` → 0.
- [x] Step 2 — the core loads it by name (`NativeBridge.kt`)
  - Notes: `System.loadLibrary("onnxruntime")` then `"audionotes"`; File/ModelCatalog imports removed (unused). compileDebugKotlin clean.
- [x] Step 3 — the catalog forgets the download (`ModelCatalog.kt`)
  - Notes: `onnxruntime-lib` ModelSpec + comment deleted; silero-vad is now the first row. compileDebugKotlin clean.
- [x] Step 4 — the two 32-bit special cases go (`ModelManagerModule.kt`)
  - Notes: `installed` and `download()` special cases removed; no `DiarBudget` import existed (same package). compileDebugKotlin clean, `grep -c '"runtime"'` → 0.
- [x] Step 5 — thirteen device tests stop waiting for a download that will never come
  - Notes: all twelve table files edited (NativePipelineTest KDoc sentence appended; StorageSweepTest/StorageItemsTest three-line assumeTrue form removed; File/ModelCatalog imports dropped where unused). `grep -rln "libonnxruntime.so not downloaded"` → nothing; compileDebugAndroidTestKotlin clean.
- [x] Step 6 — the documents
  - Notes: ANDROID_TESTING.md 45–50 and 148–152 updated; scorecard row flipped to ✅; play-console.md line 87 confirmed unchanged.
- [ ] Step 7 — the comment sweep
  - Notes:
- [ ] Step 8 — the device proves the APK's copy is the one that loads
  - Notes:
- [ ] Step 9 — gate, report, hand-over
  - Notes:
