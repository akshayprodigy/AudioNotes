# Phase 5 — Session 1 progress

## Steps

- [x] **Step 1** — schema: `meetings.mode`, `utterances.text_raw`, the `vocabulary` table, backup
- [x] **Step 2** — `Vocabulary.kt`, the pure rule, with its golden
- [x] **Step 3** — JNI `nativeApplySpokenPunctuation`
- [x] **Step 4** — `AudioDb`: the reads and writes
- [x] **Step 5** — the three pipeline hooks and the mode at creation
- [x] **Step 6** — `StorageModule` + the TS spec + stubs + wrappers
- [ ] **Step 7** — device tests and the probe (phone required)

## Decisions

- **Step 2 golden c.8**: the spec's golden case `unicode letters count as letters` expected
  `"Ravié Ravi"`, but the spec's regex uses `\p{L}\p{N}` — a Unicode class — which (matching the
  test name) treats `é` as a word letter, so the inner `ravi` of `ravié` is NOT a whole-word match.
  The specified regex therefore produces `"ravié Ravi"`. The test *name* and the specified *regex*
  both agree on `"ravié Ravi"`; only the golden's expected value disagreed. Corrected the golden
  value to `"ravié Ravi"` so the oracle matches the specified implementation and its name. The
  regex (`Vocabulary.apply`) is left EXACTLY as specified.

## Mutants

- **Step 1**:
  - `remove mode from schema.ts` → jest: `meetings › has every column…` + `meetings › mode is a nullable TEXT` fail (2 failed, 34 passed). Restored.
  - `remove the text_raw Triple (ADDED_COLUMNS)` → Kotlin: `modeAndTextRawAreAddedColumns` fails. Restored.
  - `move "vocabulary" before "people" in BackupManager.TABLES` → Kotlin: `backupManagerTablesEndsWithVocabularyAfterPeople` fails. Restored.
- **Step 2** (regex left exact as spec; only mutants applied temporarily):
  - `drop sortedByDescending` → golden case "longest heard first" fails (`put it Innova there` vs `put it Innovathere`). Restored.
  - `drop IGNORE_CASE` → golden case "case-insensitive on heard" fails (`Prey` not replaced). Restored.
  - `use \b instead of the lookarounds` → did NOT kill in this JVM: Kotlin's `\b` is Unicode-aware
    here (treats `é` as a word char), so it agrees with `\p{L}\p{N}` on every case. Recorded as a
    surviving mutant; restored to the specified lookaround regex. (The spec expected `\b` ASCII;
    the runtime disagrees.)

### Step 7 — NOT RUN (phone absent)

Per §0/§6: `adb devices` lists no device (serial `36091FDH30034G` not attached); the
`grep -c` prints 0, so Step 7 is skipped, not done. Steps 1–6 are committed green. Steps 1–6
do NOT include the Step 7 test files — those require the device to drive TDD red→green→mutant.

**What Step 7 still needs (next session, with the phone):**
- `7a` `VocabularyDbTest.kt` (androidTest, new): borrow `grantTrial()`/`restoreTrial()` and `newMeeting`
  from `NativePipelineTest.kt`; tests `rules_apply_and_keep_the_raw_wording`,
  `dictation_applies_the_marks_and_keeps_raw`, `mode_round_trips`, `put_rejects_blank`.
- `7b` extend `VerificationProbeTest` to print `mode=` per meeting, the count + rows of `vocabulary`,
  and for the first 6 utterances whether `text_raw IS NOT NULL`.
- Add `com.innocorelabs.verbale.VocabularyDbTest` to `CLASSES` in `scripts/device-verify.sh` after
  `PeopleDbTest`.
- Run `scripts/device-verify.sh VocabularyDbTest` → `OK (4 tests)`; `… NativePipelineTest` → `OK (18)`.
- Device mutant: `text_raw=?` vs `COALESCE(text_raw, ?)` in `applyVocabularyToMeeting` → second-apply
  `text_raw` assertion fails; restore.
- Gate: `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh` → `all clear`.
- `git status` clean on stop.

## Notes for the next session

- Exact `db.*` names exposed to Session 2: `mode`, `setMode`, `vocabularyRules`, `vocabularyJson`,
  `putVocabulary`, `deleteVocabulary`, `applyVocabularyToMeeting`. JNI:
  `nativeApplySpokenPunctuation` (signature `(String)->String`, via `promptCall`). Storage:
  `vocabulary`, `putVocabulary`, `deleteVocabulary`, `applyVocabulary`. KT bridge:
  `CaptureController.start(ctx, tier, capMs, mode)`, `AudioPipeline.start({…, mode?:'dictation'})`.
- VocabularyDbTest needs the native lib rebuilt with the new `nativeApplySpokenPunctuation` JNI symbol
  (Step 3 added it to `cpp/jni/audionotes_jni.cpp`); the Step 7 APK/test build compiles it.
- Step 2 golden note: `vocabulary_apply.json` case "unicode letters count as letters" expects
  `"ravié Ravi"` (é is a `\p{L}` word letter → inner `ravi` not matched); the spec text read
  `"Ravié Ravi"`, which contradicts the regex + test name — corrected and recorded under Decisions.
