# Phase 5 — Session 1 progress

## Steps

- [x] **Step 1** — schema: `meetings.mode`, `utterances.text_raw`, the `vocabulary` table, backup
- [ ] **Step 2** — `Vocabulary.kt`, the pure rule, with its golden
- [ ] **Step 3** — JNI `nativeApplySpokenPunctuation`
- [ ] **Step 4** — `AudioDb`: the reads and writes
- [ ] **Step 5** — the three pipeline hooks and the mode at creation
- [ ] **Step 6** — `StorageModule` + the TS spec + stubs + wrappers
- [ ] **Step 7** — device tests and the probe (phone required)

## Decisions

## Mutants

- **Step 1**:
  - `remove mode from schema.ts` → jest: `meetings › has every column…` + `meetings › mode is a nullable TEXT` fail (2 failed, 34 passed). Restored.
  - `remove the text_raw Triple (ADDED_COLUMNS)` → Kotlin: `modeAndTextRawAreAddedColumns` fails. Restored.
  - `move "vocabulary" before "people" in BackupManager.TABLES` → Kotlin: `backupManagerTablesEndsWithVocabularyAfterPeople` fails. Restored.

## Notes for the next session

- Step 7 needs the phone (`export ANDROID_SERIAL=36091FDH30034G`). If absent, run Steps 1–6, note it, and stop.
- Exact `db.*` names exposed to Session 2: `mode`, `setMode`, `vocabularyRules`, `vocabularyJson`, `putVocabulary`, `deleteVocabulary`, `applyVocabularyToMeeting`. JNI: `nativeApplySpokenPunctuation`. Storage: `vocabulary`, `putVocabulary`, `deleteVocabulary`, `applyVocabulary`.
