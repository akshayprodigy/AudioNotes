# Phase 4 — Remembered voices — progress (Session A)

## Task list (§3.1)

### Session A — native and data
- [x] 1. Schema: the two `speakers` columns and the `people` table in both mirrors; `BackupManager.TABLES`; the schema tests (§5.1). Commit.
- [x] 2. `PeopleMatch.kt` (pure rule, §4) + `PeopleMatchTest` against `cpp/tests/golden/people_match.json`. Commit.
- [x] 3. JNI `nativeSpeakerVoices` + `NativeBridge` extern (mirror `nativeDiarize`; construct a `Diarizer(seg, emb, sampleRate, 0)`, rebuild the `DiarSegment` list from `tri`, call `speakerVoices`, flatten with `dim` first). Place the JNI **after** the `jstr` helper definitions. Commit.
- [x] 4. `AudioDb.setSpeakerVoices`, `suggestPeople`, `rememberVoice`, `answerSuggestion`,
    `forgetVoices`, `peopleCount` (for the probe); the hook in `ProcessingEngine`'s diarize stage. Commit.
- [x] 5. `StorageModule` methods `rememberVoice`, `answerSuggestion`, `forgetVoices` + `NativeStorage.ts` + the `jest.setup.js` stubs + `db.*` wrappers in `queries.ts`. Commit.
- [x] 6. Device: `PeopleDbTest` (§5.5) via `device-verify.sh PeopleDbTest`; `NativePipelineTest`'s new seam test; extend `VerificationProbeTest` to print each speaker's `voice IS NOT NULL`, `suggested_person` and `SELECT count(*) FROM people`. Commit. **Update the progress file and stop.**

### Session B — screens, by hand, report
- [x] 7. `db.speakers` SELECT + `Speaker` type gain `suggestedPerson`/`suggestedName`; `voiceCopy.ts` + `voiceCopy.test.ts`. Commit.
- [x] 8. `SpeakersScreen`: the suggestion line, Yes/No, the rename hook, the one-time card. Tests. Commit.
- [x] 9. `SummaryTab` banner + `MeetingScreen` wiring. Tests. Commit.
- [x] 10. `SettingsScreen` Voices section. Tests. Commit.
- [x] 11. The gate; then `device-verify.sh PeopleDbTest` and `NativePipelineTest` once more on the phone. Commit anything that moved.
- [ ] 12. The by-hand run (§5.6), the report (§7), the plan/scorecard rows. Commit.

## Decisions

- **Review of Session A (Opus, 18 Sep):** gate all clear; SchemaTest (19) and PeopleMatchTest (2)
  forced to execute; every §2 function read against the brief — faithful. One rule defect, the
  brief's own: "ties break to the first listed" contradicted the 0.10 margin, and the code made an
  equal runner-up invisible to the margin. Fixed: an equal runner-up is a runner-up, a tie refuses;
  golden case and brief §4 corrected (`PeopleMatch.kt`, `people_match.json`). Whitespace: the new
  `AudioDb` block was indented one space off; normalised (no code change, `git diff -w` empty).
  Environment: the builder tool left a git worktree at `.kilo/worktrees/glib-credit` inside the
  repo, which jest collected (suites 51 → 91); `.kilo/` is now ignored by jest, tsc and git — the
  founder removes the directory (`git worktree remove --force .kilo/worktrees/glib-credit`).

## Mutants

- voiceCopy: `names.length - 2` mutated to `names.length - 1` → 3- and 5-name cases fail, restored, green.
- SpeakersScreen: swap true/false in Yes/No buttons → tests 2,3 fail, restored, green.
- SpeakersScreen: deleted the `rememberVoice` call in `rename` → tests 4,5,9 fail, restored, green.
- SpeakersScreen: dropped `if (!paid) return;` → test 9 fails, restored, green.
- SpeakersScreen: `prompted === '1'` changed to `=== '0'` → test 7 fails, restored, green.
- SummaryTab: dropped `paid &&` from the voice-banner guard → test 3 (free) fails, restored, green.
- SummaryTab: passed `voiceSuggestions.slice(1)` to `soundsLike` → tests 1,2 fail, restored, green.
- MeetingScreen: dropped the `filter` from `voiceSuggestions` → test expects ['Priya','Ravi'] but got ['Priya','Ravi',null], fails, restored, green.
- VoicesSection: inverted the `paid ?` label ternary → tests 1,2 fail, restored, green.
- VoicesSection: removed Forget's `onPress` → test 4 fails, restored, green.
- TS SchemaTest: removed `voice` from schema.ts speakers CREATE TABLE → 31 failures (cascading from freshDb), restored, green.
- Kotlin SchemaTest: removed `voice` from ADDED_COLUMNS → 1 failure (speakersHasVoiceAndSuggestedPersonColumns), restored, green.
- Kotlin SchemaTest: removed `people` from BackupManager.TABLES → 1 failure (backupManagerTablesEndsWithPeople), restored, green.
- Kotlin SchemaTest: removed `people` from SCHEMA → 1 failure (peopleTableIsInSchema), restored, green.
- Kotlin PeopleMatchTest: MATCH_COSINE set to 0.0f → 2 failures (constants + golden table), restored, green.
- Kotlin PeopleMatchTest: margin check removed (`if (false) return null` in place of margin guard) → 1 failure (the 0.80/0.75 margin case suggests instead of null), restored, green.
- Kotlin PeopleMatchTest: `>=` changed to `>=` via `<=` on cosine (`bestCos <= MATCH_COSINE`) → 1 failure (the exactly-0.65 case returns null instead of suggesting), restored, green.
- Kotlin PeopleMatchTest: default-name guard dropped → 1 failure (non-default displayName case suggests instead of null), restored, green.
- Task 4 (AudioDb functions): mutation-checked via device tests in Task 6 (§5.5). Verified: `voices_remember` gate returns "off" reason (temporarily mutated to return `{"remembered":true}` → would fail PeopleDbTest's "setting off → off" case, restored, green). Kotlin compiles clean for main and test source sets.
- Task 5 (StorageModule + NativeStorage + queries + jest.setup): no standalone unit test yet — tested via screen tests in Session B (Tasks 8-10). Kotlin main compiles clean; TS compiles and schema tests pass. Mutation checks deferred to Session B screen tests.
- Task 6 (device tests): PeopleDbTest — 3/3 pass on device (`device-verify.sh PeopleDbTest` → OK). NativePipelineTest seam test `speaker_voices_returns_one_row_per_speaker` — passes (models installed). VerificationProbeTest extended to print `has_voice`, `suggested_person`, `people count` per meeting — runs clean. Mutation: `foldVoice` normalization skipped → 1 failure (centroid unit-length assertion in PeopleDbTest), restored, green.
- Task 3 (JNI): no standalone mutation — nativeSpeakerVoices requires the diarizer models and is covered by test_voices_live (§5.3) and the NativePipelineTest seam (Task 6, §5.5). C++ builds clean, test_voices_live passes.

## Notes for the next session

- Session B is driven by `docs/superpowers/specs/2026-09-18-phase-4-session-b-execution.md`, a
  step-by-step execution sheet; the brief stays the reference for copy (§2.9) and the report (§7).
- The device tests of Task 6 (PeopleDbTest 3/3, the NativePipelineTest seam) were run by Session A;
  the phone was not attached during the review, so Task 11 re-runs them.

## Notes

- VoicesSection.test.tsx renders a `Switch`, whose mount animates `Animated.timing(useNativeDriver)`
  and crashes the test renderer without one — the codebase's established screen-test pattern
  (SearchScreen/MetingScreen/SpeakersScreen tests) is `jest.useFakeTimers()` + `afterEach(useRealTimers)`,
  so this file follows it. This is environment test-hygiene, not a change to the component under test.
- The SpeakersScreen "wrap each Yes/No button in a View" used an inline `style={{ flexShrink: 0 }}`
  per spec note §8, which trips `react-native/no-inline-styles`; replaced with a named `st.noShrink` so
  §10d eslint is clean with zero errors. SoftButton itself has no `flexShrink` guard, so the wrapper is kept.
- VoicesSection's consent copy is rewrapped (same words, brief §2.9 verbatim) so the substring
  "Nothing is uploaded and nothing leaves the phone." sits on one physical line, satisfying §5's
  `grep -c` == 1.
- Pre-existing: SettingsScreen.tsx:485 shadows the file-level `busy` (`@typescript-eslint/no-shadow`,
  WARNING) in the unrelated `models.map` download row. Left untouched — it predates Session A (present
  at 9750864), has no test coverage, and is outside Phase 4; eslint exits 0 (0 errors). All Phase 4 files
  are warning-free.

## Step 11 result

- Gate (`GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh`): `gate: all clear`
  in 107s — types ok, js 546 passed, scans ok, mutations ok, kotlin ok, cpp ok, exit 0.
- Phone: `adb` not on PATH and `adb devices | grep -c 36091FDH30034G` = 0 → device-verify (PeopleDbTest,
  NativePipelineTest) and the by-hand §5.6 run are not run — phone unavailable. Per §6, proceed to §12
  with those marked "not run — phone unavailable".
