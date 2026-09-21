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

- **Session 2, Step 1**: the sheet's `SummaryTab.tsx` meta line (`{mins} min ·{' '}` then a ternary
  as a separate JSX child) splits into a multi-item `children` array, so no node's `props.children`
  is ever the plain string `'one voice'` — the sheet's own 1e test (`findAll(n => typeof
  n.props.children === 'string')`) can never see it, on either branch, mutated or not. Collapsed
  the whole line into one interpolated template-literal string (`` {`${mins} min · ${...}`} ``) so
  it renders as a single string child; behaviour and copy are unchanged (still "`N min · one voice`"
  / "`N min · K speakers`"), only how many child nodes the JSX produces. Verified no other test in
  the suite reads that line's old multi-child shape.
- **Session 2, Step 4 copy check**: the sheet's `grep -c "idleHint(mode, capMs)\|{modeLabel(mode)} ·\|DICTATION_TIP" src/screens/RecordScreen.tsx` expects 3, but the faithful implementation gives 4,
  because the `import { DICTATION_TIP, … } from './recordMode';` line itself contains the substring
  `DICTATION_TIP` and is a 4th matching line — grep counts matching lines, and an import that names
  the symbol it uses can never avoid matching its own usage pattern. The three call/usage sites
  (`{modeLabel(mode)} ·`, `{DICTATION_TIP}`, `idleHint(mode, capMs)`) are exactly the three the sheet
  intended; the count is an off-by-one in the sheet's arithmetic, not a defect in the screen.
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

### Session 2

- **Step 1**:
  - remove `"dictation" to "Dictation"` from `TemplateLabels.kt` → Kotlin `TemplateLabelsTest` fails
    (BUILD FAILED). Restored.
  - `disabled={template === DICTATION_TEMPLATE}` → `disabled={false}` → SummaryTab's new test fails
    on the `chip.props.disabled` assertion. Restored.
  - `'one voice'` → `'1 speaker'` → SummaryTab's new test fails on the `speakers` assertion (the
    string now contains neither `'one voice'` nor triggers the `speakers` branch). Restored.
- **Step 2**:
  - drop `, mode` from `listMeetings`' SELECT → no test fails, as the spec predicted (the screens
    under test mock `db.listMeetings` directly, so the real SQL never runs). Recorded per the sheet
    as covered only by the by-hand run, §7 step 4. Restored.
  - Library card prefix `'Dictation'` → `'Meeting'` → the new `LibraryScreen.test.tsx` card test
    fails (`toContain('Dictation · ')`). Restored.
  - drop the `meeting?.mode === 'dictation' ? 'Dictation · ' : ''` prefix from the `MeetingScreen.tsx`
    header → the new header test fails (`startsWith('Dictation · ')`). Restored.
- **Step 3**:
  - `recordModeOf` compares case-insensitively (`stored?.toLowerCase() === 'dictation'`) →
    `recordModeOf('Dictation')` test fails (expects `'meeting'`). Restored.
  - `PipelineController.startRecording` passes `mode` unconditionally instead of only when set →
    the `not.toHaveProperty('mode')` assertion on the no-mode call fails. Restored.
  - drop `'question mark'` from `DICTATION_TIP` → the five-marks test fails. Restored.
- **Step 5**:
  - `onAdd` stores `'learned'` instead of `'typed'` → the Add test's `toHaveBeenCalledWith(…, 'typed')`
    fails. Restored.
  - `onChange` stores `'typed'` instead of `r.source` → the Change test's `toHaveBeenCalledWith(…,
    'learned')` fails. Restored.
  - drop the `!meant.trim()` guard in `onAdd` → the both-are-needed test's `not.toHaveBeenCalled()`
    fails. Restored.
  - `remove` calls `db.deleteVocabulary(r.id)` directly instead of only inside `onConfirm` → the
    Remove test's `not.toHaveBeenCalled()` (before tapping the Alert's Remove button) fails. Restored.
- **Step 7**:
  - `offerRule` stores the rule as `'typed'` instead of `'learned'` → test 1
    (`toHaveBeenCalledWith(…, 'learned')`) fails. Restored.
  - drop `if (!ent?.paid) return;` → test 3 ("does not ask on free") fails: `Alert.alert` is called.
    Restored.
  - drop `.then(() => db.applyVocabulary(meetingId))` → test 1 fails on the `applyVocabulary`
    assertion. Restored.
  - `onSaveEdit` calls `offerRule` for every `kind`, not just `'utterance'` (drop `kind ===
    'utterance'`) → SURVIVING MUTANT, exactly as the sheet predicted: neither `MeetingScreen.test.tsx`
    nor `ItemProvenance.test.tsx` fails (65/65 still green), because every non-utterance edit exercised
    by those suites is a rewrite that `proposeRule` itself rejects (`heard === meant` or too many
    words), so `offerRule` still no-ops even when called. Restored to the specified `if (kind ===
    'utterance')` guard.

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

## Review of Session 1 (Opus, 21 Sep)

Gate re-run with the Kotlin suites forced (`--rerun-tasks`): 298 Kotlin tests / 0 failures,
jest 549 / 0, types, scans, mutations, cpp all ok. `git diff --stat 9f05928..HEAD` names only
the §5 files (minus Step 7's, plus the two doc commits that predate the builder). Every diff read
against the sheet — faithful, including the c.8 golden correction (right: `é` is `\p{L}`).

Findings, all the sheet's fault, fixed in the review commit:
- **`Vocabulary.apply` double-escaped `meant`.** The sheet wrote
  `re.replace(out) { Regex.escapeReplacement(r.meant) }`; Kotlin's lambda-form `replace` appends
  the lambda's result literally, so a `meant` of `$Co\Ltd` came back `\$Co\\Ltd`. Now
  `{ r.meant }`; golden c.9 (`meant is written as typed, even with a dollar or a backslash`) pins it
  — it failed before the fix, passes after. VocabularyTest 2/0 over 9 cases.
- `applyVocabularyToMeeting` carried an unused `usesById` map (sheet's code) — removed.
- Indentation drift: Phase 4 left `SchemaTest`, `BackupManager.TABLES`, `jest.setup.js`'s
  `Storage` block and `schema.test.ts`'s `freshDb` one space over; this session matched and
  compounded it (4/6). All normalised to the house two spaces; `schema.ts`'s meetings/utterances
  DDL lines put back to their statement's own 5/3 so the diff is additive.
- The stale Kilo worktree `.kilo/worktrees/few-chipmunk` (clean, at `5ff0f5b`) removed and pruned.
- The `\b` mutant surviving is a JVM quirk (Java's `\b` is Unicode-aware before JDK 19; Android's
  ICU regex likewise) — the product behaviour is the specified lookaround either way. Not a defect.

Step 7 (device tests + probe) moves to the device session's sheet — it is device work and the
phone was absent on 18 and 21 Sep.

## Review of Session 2 (Opus, 21 Sep)

Gate re-run with the Kotlin suites forced: 298 Kotlin / 0, jest 584 / 0 (the +35 over Session 1 is
exactly the new tests), types, scans, mutations, cpp ok. `git diff --stat 09d8037..HEAD` names only
the §5 files. `VocabularyScreen.tsx` and its test are byte-for-byte the sheet's listings; every
other diff read against the sheet — faithful. No stale worktree this time.

Both decisions the builder took were the SHEET's defects, and both were handled right:
- The SummaryTab meta line: my JSX made a multi-child `Txt`, so my own 1e test could never have seen
  `'one voice'` as a string child. Collapsing it to one template string is the correct fix.
- The Step 4 copy grep expected 3 and matches 4 because the import line names `DICTATION_TIP`.
  Arithmetic error in the sheet.

One hygiene fix in the review commit: the 133-character `recordMode` import in `RecordScreen.tsx`
wrapped one name per line, as the file's other long imports are. Nothing else to change.

Not covered by any test and to be watched on the phone: the `, mode` in `listMeetings` (mocked in
jest), and a dictated meeting's Script with no speaker rows at all (the no-diar-models path renders
it; never exercised with `mode='dictation'`).

## Notes for the next session

- Step 1 Kotlin `SchemaTest`: 21 tests, 0 failures (spec §4 said "22"). The file at `9f05928` had
  19 `@Test`; the spec adds 2 (rename-only tests don't count) → 21. No test was lost; the spec's
  "22" is off by one. The JS `schema.test.ts` side gained +3 (36 total) and is green.
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
- **Session 2 → Session 3 (device session), the names it needs:**
  - `record_mode` — the settings key (`RECORD_MODE_KEY` in `src/screens/recordMode.ts`), values
    `'meeting'` | `'dictation'`; read once on Record's mount alongside the consent flag, written on
    every switch change. Native reads the *meeting's* `mode` column, never this setting directly —
    it is only how the Record screen remembers what to pass at start.
  - `DICTATION_TEMPLATE` — `'dictation'` — exported from `src/screens/meeting/templateLabels.ts`;
    the fixed, unlisted template id a dictated note's Summary chip carries (disabled chip, "one
    voice" instead of a speaker count).
  - The screen route `Vocabulary` (no params) — `RootStackParamList['Vocabulary']` in
    `RootNavigator.tsx`, opened from Settings' "Words it should write" row (`voicesPaid` gates it;
    free opens `Paywall` instead).
  - The Alert title `offerRule` shows: `` `Always write "${rule.meant}" when it hears "${rule.heard}"?` ``
    (curly quotes), buttons `No` (cancel) / `Yes` (writes `db.putVocabulary(…, 'learned')` then
    `db.applyVocabulary(meetingId)`) — in `MeetingScreen.tsx`, fired from `onSaveEdit` only when
    `kind === 'utterance'`.
  - Session 2's full report is `docs/superpowers/reports/2026-09-21-phase-5-vocabulary-and-dictation.md`;
    §8 there lists the two surviving/uncovered mutants Session 3 could pick up on-device, and §7 is
    the founder's by-hand script, most of which needs the phone.

## Session 2

Against `09d8037`. Two runs: 2A = Steps 1–4, 2B = Steps 5–8.

### Steps

- [x] **Step 1** — "Dictation" is a label, and a dictated note's chip is not a choice
- [x] **Step 2** — where a dictated note says so: the Library card and the meeting header
- [x] **Step 3** — the mode reaches native: store, controller, and a pure helper for the Record screen's words
- [x] **Step 4** — the Record screen: Meeting | Dictation
- [x] **Step 5** — Settings › Vocabulary: the screen
- [x] **Step 6** — Settings › Vocabulary: the row
- [x] **Step 7** — "Correct the words" offers a rule
- [x] **Step 8** — gate, report, hand-over

## Session 3 (device: Galaxy Tab A 10.1, R52N611D8FE, 32-bit)

Against `e66b407`.

### Steps

- [x] **Step 1** — `VocabularyDbTest` in `device-verify.sh` CLASSES, run on the tablet's real database
- [ ] **Step 2** — the seam test Session 1 wrote (`NativePipelineTest`)
- [ ] **Step 3** — the probe prints the mode, the rules and the raw lines
- [ ] **Step 4** — the gate with its device stage, the report, the hand-over

### Step 1 results

- `scripts/device-verify.sh VocabularyDbTest` → `OK (4 tests)`; logcat confirms
  `run finished: 4 tests, 0 failed, 0 ignored`.
- Device mutant (`AudioDb.applyVocabularyToMeeting`, `text_raw=COALESCE(text_raw, ?)` →
  `text_raw=?`): re-ran the class → **did NOT kill** — `OK (4 tests)` again, logcat
  `run finished: 4 tests, 0 failed, 0 ignored`. Confirmed this was not a stale/cached build: the
  edited `AudioDb.kt` (mtime 15:27:08) predates the rebuilt `app-debug.apk` (mtime 15:27:18), so the
  mutant was genuinely installed and exercised.
  - Why: in both "second pass" assertions in `rules_apply_and_keep_the_raw_wording` and in
    `dictation_applies_the_marks_and_keeps_raw`, the row's text after the first pass no longer
    matches the rule/punctuation input (the correction already applied), so
    `Vocabulary.apply`/`punctuate` returns the same string on the second call, `next == text`, and
    the loop's `if (next == text) continue` skips the `UPDATE` entirely — the `COALESCE` on a row
    whose `text_raw` is already non-null is never executed by this test. The mutant is structurally
    unreachable from this test class, not a defect in `AudioDb.kt`.
  - Restored the line (`git diff --stat` on `AudioDb.kt` clean); re-ran → `OK (4 tests)`, logcat
    `run finished: 4 tests, 0 failed, 0 ignored`.
