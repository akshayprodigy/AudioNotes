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

## Notes for the next session

- Step 7 needs the phone (`export ANDROID_SERIAL=36091FDH30034G`). If absent, run Steps 1–6, note it, and stop.
- Exact `db.*` names exposed to Session 2: `mode`, `setMode`, `vocabularyRules`, `vocabularyJson`, `putVocabulary`, `deleteVocabulary`, `applyVocabularyToMeeting`. JNI: `nativeApplySpokenPunctuation`. Storage: `vocabulary`, `putVocabulary`, `deleteVocabulary`, `applyVocabulary`.
