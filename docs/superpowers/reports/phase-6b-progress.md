# Phase 6b — Session 1 progress

Execution sheet: `docs/superpowers/specs/2026-09-21-phase-6b-session-1-runtime-in-apk-execution.md`

- [x] Step 1 — the `.so` comes back into the APK (`build.gradle`)
  - Notes: excludes line dropped `libonnxruntime.so`; comment rewritten. `grep -c "libonnxruntime.so'"` → 0.
- [x] Step 2 — the core loads it by name (`NativeBridge.kt`)
  - Notes: `System.loadLibrary("onnxruntime")` then `"audionotes"`; File/ModelCatalog imports removed (unused). compileDebugKotlin clean.
- [ ] Step 3 — the catalog forgets the download (`ModelCatalog.kt`)
  - Notes:
- [ ] Step 4 — the two 32-bit special cases go (`ModelManagerModule.kt`)
  - Notes:
- [ ] Step 5 — thirteen device tests stop waiting for a download that will never come
  - Notes:
- [ ] Step 6 — the documents
  - Notes:
- [ ] Step 7 — the comment sweep
  - Notes:
- [ ] Step 8 — the device proves the APK's copy is the one that loads
  - Notes:
- [ ] Step 9 — gate, report, hand-over
  - Notes:
