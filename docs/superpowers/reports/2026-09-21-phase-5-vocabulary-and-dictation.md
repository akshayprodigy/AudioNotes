# Phase 5 — vocabulary and dictation: Session 2 report

## 1. Status

Session 2 (Steps 1–8, the screens: dictation on the Record screen, the labels, Settings ›
Vocabulary, the rule offer) is complete: all eight steps built, tested, mutation-tested and
committed to `main`; the gate is clear; nothing pushed.

Session 3 (device, 21 September 2026): VocabularyDbTest 4/4 on the Galaxy Tab A (32-bit),
NativePipelineTest OK (18 tests), the probe extended, the gate clear with its device stage.

## 2. What was built

**Session 1** (native and data, from `docs/superpowers/reports/phase-5-progress.md`):
- Step 1 — schema: `meetings.mode`, `utterances.text_raw`, the `vocabulary` table, backup.
- Step 2 — `Vocabulary.kt`, the pure substitution rule, with its golden.
- Step 3 — JNI `nativeApplySpokenPunctuation`.
- Step 4 — `AudioDb`: the reads and writes.
- Step 5 — the three pipeline hooks and the mode stamped at creation.
- Step 6 — `StorageModule` + the TS spec + stubs + wrappers.
- Step 7 — device tests and the probe: NOT RUN (phone absent on 18 and 21 Sep); moved to the
  device session (Session 3).

**Session 2** (this session, by step):
- Step 1 — `DICTATION_TEMPLATE`; a dictated note's Summary chip is disabled and reads "one voice"
  instead of a speaker count; the Kotlin label mirror gets the one new map entry.
- Step 2 — `listMeetings` now selects `mode`; the Library card and the meeting header both prefix
  "Dictation · " when the meeting is one.
- Step 3 — new `src/screens/recordMode.ts` (the words and the settings key); `mode` threads
  `recordingStore.start` → `PipelineController.startRecording` → native, present only for
  dictation (absent, not null, for a meeting).
- Step 4 — the Record screen gets the Meeting | Dictation segmented switch (dimmed and inert while
  recording), the dictation tip line, the mode-aware idle hint, and remembers the choice via the
  `record_mode` setting.
- Step 5 — new `VocabularyScreen.tsx` (Settings › Vocabulary): add, change and remove correction
  rules; wired into `RootNavigator`.
- Step 6 — the Settings row that opens it — "Words it should write", Pro-gated on the same
  entitlement flag Settings already holds for voices.
- Step 7 — "Correct the words" offers the one substitution it finds as a rule (`offerRule`, via
  `proposeRule`); Yes stores it as `learned` and re-runs the rules over the meeting; No and free
  store nothing.
- Step 8 — the gate, this report, hand-over (this document).

## 3. Decisions taken

- **Session 2, Step 1**: the sheet's `SummaryTab.tsx` meta line (`{mins} min ·{' '}` then a ternary
  as a separate JSX child) splits into a multi-item `children` array, so no node's `props.children`
  is ever the plain string `'one voice'` — the sheet's own 1e test (`findAll(n => typeof
  n.props.children === 'string')`) can never see it, on either branch, mutated or not. Collapsed
  the whole line into one interpolated template-literal string (`` {`${mins} min · ${...}`} ``) so
  it renders as a single string child; behaviour and copy are unchanged (still "`N min · one voice`"
  / "`N min · K speakers`"), only how many child nodes the JSX produces. Verified no other test in
  the suite reads that line's old multi-child shape.
- **Session 2, Step 4 copy check**: the sheet's `grep -c "idleHint(mode, capMs)\|{modeLabel(mode)}
  ·\|DICTATION_TIP" src/screens/RecordScreen.tsx` expects 3; the faithful implementation gives 4,
  because the `import { DICTATION_TIP, … } from './recordMode';` line itself contains the substring
  `DICTATION_TIP` and is a 4th matching line — grep counts matching lines, and an import that names
  the symbol it uses can never avoid matching its own usage pattern. The three call/usage sites
  (`{modeLabel(mode)} ·`, `{DICTATION_TIP}`, `idleHint(mode, capMs)`) are exactly the three the sheet
  intended; the count is an off-by-one in the sheet's arithmetic, not a defect in the screen.
- **Step 2 golden c.8** (Session 1): the spec's golden case `unicode letters count as letters`
  expected `"Ravié Ravi"`, but the spec's regex uses `\p{L}\p{N}` — a Unicode class — which
  (matching the test name) treats `é` as a word letter, so the inner `ravi` of `ravié` is NOT a
  whole-word match. The specified regex therefore produces `"ravié Ravi"`. The test *name* and the
  specified *regex* both agree on `"ravié Ravi"`; only the golden's expected value disagreed.
  Corrected the golden value to `"ravié Ravi"` so the oracle matches the specified implementation
  and its name. The regex (`Vocabulary.apply`) is left EXACTLY as specified.
- **Session 3**: a rule whose `meant` is changed does not re-correct lines a previous pass already
  corrected (rules run over the current text; `text_raw` is a record, not a source) — pinned by
  `rules_apply_and_keep_the_raw_wording`. ⚑ To make Change retroactive within a meeting,
  `applyVocabularyToMeeting` would apply rules to `COALESCE(text_raw, text)` instead.

## 4. Tests

| File | Tests | Result | Mutants tried | Result |
|---|---|---|---|---|
| `templateLabels.test.ts` + Kotlin `TemplateLabelsTest` | 12 (jest) | all passed | 1 (drop the `"dictation" to "Dictation"` map entry, Kotlin) | killed |
| `SummaryTab.test.tsx` | 16 | all passed | 2 (`disabled={false}`; `'one voice'` → `'1 speaker'`) | both killed |
| `LibraryScreen.test.tsx` | 16 | all passed | 1 of Step 2's 3 (Library prefix `'Dictation'` → `'Meeting'`) | killed |
| `MeetingScreen.test.tsx` (Step 2 state) | 20 | all passed | 2 of Step 2's 3 (drop `, mode` from `listMeetings`; drop the header prefix) | 1 killed (header prefix); dropping `, mode` killed nothing — expected, recorded as covered only by the by-hand run (§7 step 4) |
| `recordMode.test.ts` | 4 | all passed | 2 (case-insensitive `recordModeOf`; drop `'question mark'`) | both killed |
| `startRecording.test.ts` | 1 | all passed | 1 (pass `mode` unconditionally) | killed |
| — (`RecordScreen.tsx`, Step 4) | full suite: 575 (59 suites) | all passed | none (no test file for this screen; wiring is `tsc` + the by-hand run, §7) | n/a |
| `VocabularyScreen.test.tsx` | 6 | all passed | 4 (`onAdd`→`'learned'`; `onChange`→`'typed'`; drop the `!meant.trim()` guard; `remove` calls `deleteVocabulary` outside `onConfirm`) | all killed |
| `MeetingScreen.test.tsx` (Step 7, final) + `ItemProvenance.test.tsx` | 23 + 42 = 65 | all passed | 4 (store as `'typed'`; drop `if (!ent?.paid) return`; drop `applyVocabulary`; drop the `kind === 'utterance'` guard) | 3 killed, 1 SURVIVING (the guard drop — see §8) |

`npx tsc --noEmit` was run after every step (1–7): nothing, each time.

## 5. Gate

```
GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh
==> types
    ok  types (3s)
==> js
    ok  js (5s)
==> scans
    ok  scans (3s)
==> mutations
    ok  mutations (74s)
==> kotlin
    ok  kotlin (4s)
==> cpp
    ok  cpp (24s)
gate: all clear in 113s
```

## 6. Device

Session 3, 21 September 2026, on the Galaxy Tab A 10.1 (`R52N611D8FE`, SM-T515, 32-bit,
`-PreactNativeArchitectures=armeabi-v7a`) — a bench device with disposable data.

- **`VocabularyDbTest`** added to `device-verify.sh`'s `CLASSES` after `PeopleDbTest`. `OK (4 tests)`
  (`dictation_applies_the_marks_and_keeps_raw`, `mode_round_trips`,
  `rules_apply_and_keep_the_raw_wording`, `put_rejects_blank_and_unknown_source`); logcat confirms
  `run finished: 4 tests, 0 failed, 0 ignored`.
- **Device mutant** (`AudioDb.applyVocabularyToMeeting`: `text_raw=COALESCE(text_raw, ?)` →
  `text_raw=?`): the builder re-ran the class with the mutant in → **did not kill** — `OK (4 tests)`
  again, confirmed against a fresh build. The builder's finding: no assertion in the test rewrote a
  line that already carried `text_raw`. **Review (the brain, same day):** true, and the deeper cause
  was the sheet's own code — the Kotlin side bound `raw ?: text` as the parameter, so the existing
  `text_raw` was re-supplied by the binding and `COALESCE` was a second guard on the same invariant;
  with two guards the mutant was *equivalent* and no test could have killed it. Fixed in review:
  the loop no longer reads `text_raw` and binds the current `text`; `COALESCE` is the only guard.
  The test gained the missing assertion — a *different* rule (`sold` → `licensed`) rewrites the
  already-corrected line and `text_raw` must still be the wording before the first correction.
  Proved on the tablet: mutant in → `FAILURES!!! Tests run: 4, Failures: 1`
  (`expected:<(we licensed it to Zorp, we sold it to zorp co)> but was:<(…, we sold it to Zorp)>`);
  restored → `OK (4 tests)`, logcat `run finished: 4 tests, 0 failed, 0 ignored`.
- **`NativePipelineTest`**: `OK (18 tests)`; logcat `run finished: 18 tests, 0 failed, 0 ignored`
  with exactly ten `assumption failed` lines, the same named set predicted on 21 Sep
  (`a_recording_too_short_to_be_a_meeting_is_not_narrated`,
  `narration_writes_a_summary_a_narrative_and_a_headline`, `llm_loads_and_generates`,
  `speaker_voices_returns_one_row_per_speaker`,
  `diarization_runs_and_shares_the_onnx_runtime_with_vad`,
  `classifier_grammar_constrains_the_answer`, `processing_a_meeting_headlessly_leaves_it_narrated`,
  `embedding_is_a_unit_vector_and_near_beats_far`,
  `narration_with_a_template_covers_at_least_two_of_its_sections`,
  `narration_resumes_from_committed_digests`) — no code touched.
- **The probe.** `VerificationProbeTest` extended: `mode` in the meetings SELECT and its `println`;
  a `rewritten:` line per meeting (`text_raw IS NOT NULL` over the first 6 utterances); a
  `PROBE vocabulary (N): …` line. Ran clean (`OK (1 test)`, no exception in logcat). Printed:
  `PROBE vocabulary (0): []`. No `PROBE meeting` or `PROBE   rewritten` lines, because this tablet
  currently holds zero rows in `meetings` — no real recording has been made on it yet this session,
  and `VocabularyDbTest` deletes its own meetings in `@After`. The mechanism is confirmed correct
  (the same query path the vocabulary line used ran without error); the `mode=`/`rewritten:` lines
  are unexercised until a real meeting exists on this device — the founder's by-hand run (§7) or a
  future session will show them.
- **The gate**, with its device stage: seven stages `ok` (types, js, scans, mutations, kotlin, cpp,
  device), the device stage naming `R52N611D8FE`, `gate: all clear in 520s`. `VocabularyDbTest`
  showed `OK (4 tests)` inside this run too.

## 7. For the founder to test by hand

1. **Record › Dictation.** Open Record. Under the status pill a switch reads *Meeting | Dictation*.
   Tap *Dictation*: the top-right label reads *Dictation · <date>*, the clock's hint reads *Tap to
   dictate* (with *· up to 15 min on Free* on a free install), and a line under the switch lists the
   five marks. Kill the app, reopen Record: *Dictation* is still selected.
2. **A dictated note.** In Dictation, tap the mic and say, with the marks spoken: *"Note for Priya
   full stop we will not ship on Monday full stop new paragraph tell finance comma the invoice is late
   question mark"*. Stop. While recording, the switch was dimmed and did not respond.
3. **What it made.** When READY: the header's date line starts *Dictation ·*; the Summary card's chip
   reads *Dictation* and does not open the type sheet when tapped; the card says *one voice*; the
   Script has no speaker names; the transcript reads *Note for Priya. We will not ship on Monday.*
   then *Tell finance, the invoice is late?* (the marks are marks, the nouns are gone). On Pro the
   Summary is the note in your words, no "The note for Priya:" label, no invented cause.
4. **The library card** for that note reads *Dictation · <date> · 1 min*.
5. **A rule from a correction (Pro).** Open any meeting's Script, long-press a line, *Correct the
   words*, change exactly one word or short phrase (e.g. a name it mis-heard), Save. A dialog asks
   *Always write “<yours>” when it hears “<its>”?* Tap *Yes*: the line is corrected, and every other
   line in this meeting with the same mis-hearing is too.
6. **Settings › Vocabulary.** Settings has a *VOCABULARY* section with *Words it should write*. It
   opens a list with the learned rule (*Learned from a correction · used N times*). *Add* asks for two
   fields; add *in over* → *Innova*. *Change* on a row edits only the second word. *Remove* asks first.
7. **Free.** With no subscription and no trial: the Settings row reads *Words it should write (Pro)*
   and opens the paywall; correcting a transcript line never asks about a rule; dictation mode still
   works (the marks apply; the note itself is Pro, as every narrative is).
8. **A rewrite is not a rule.** Correct a line by retyping it entirely: no dialog.

## 8. Known gaps

- **Surviving mutant (Session 2, Step 7):** `onSaveEdit` calling `offerRule` for every edit `kind`
  instead of only `'utterance'` is not caught by `MeetingScreen.test.tsx` or `ItemProvenance.test.tsx`
  — every non-utterance edit those suites exercise is a rewrite that `proposeRule` itself rejects
  (`heard === meant`, or more than three words on a side), so `offerRule` still no-ops even when
  called for the wrong `kind`. The specified `if (kind === 'utterance')` guard is in place; the gap
  is in test coverage, not behaviour, and would need an item/summary/minutes edit shaped like a
  one-to-three-word substitution to close.
- **Untested by the mocked suites (Session 2, Step 2):** dropping `, mode` from `listMeetings`'s
  SELECT kills no jest test, because `LibraryScreen.test.tsx` and `MeetingScreen.test.tsx` mock
  `db.listMeetings` directly — the real SQL never runs under jest. Coverage for this line is the
  by-hand run (§7 step 4) and, eventually, a device test.
- **Surviving mutant (Session 1, Step 2):** using `\b` instead of the specified lookarounds in
  `Vocabulary.apply`'s regex does not kill any Kotlin golden case in this JVM (Java's `\b` is
  Unicode-aware before JDK 19, and Android's ICU regex agrees), so the two forms are behaviourally
  identical here. Not a product defect; recorded for whoever next touches that regex on a different
  runtime.
- No `RecordScreen` or `SettingsScreen` render test — the wiring for both is `npx tsc --noEmit` plus
  the by-hand run (§7).
- ~~Surviving mutant (Session 3, device): `text_raw=?` for `COALESCE(text_raw, ?)`~~ — **closed in
  review** (§6): it was equivalent because the Kotlin binding duplicated the guard; the duplicate is
  gone and the test now kills it on the tablet.
- **Unexercised by the device probe (Session 3):** `VerificationProbeTest`'s new `mode=` and
  `rewritten:` lines printed nothing on the Galaxy Tab A, because the tablet currently has zero rows
  in `meetings` (bench device, no real recording made on it this session). The query path is
  confirmed correct via the `PROBE vocabulary (0): []` line; the two new lines need a real meeting
  on the device to show anything — the founder's by-hand run (§7) will exercise them.

## 9. Commits

```
34831f8 feat(vocab): Correct the words offers the substitution as a rule — Yes learns it
0d25f22 feat(vocab): Settings › Vocabulary — the row, Pro
318ac75 feat(vocab): Settings › Vocabulary — the screen
3c9f8de feat(dictation): Meeting | Dictation on the Record screen, remembered
7c5c49e feat(dictation): the mode reaches native — store, controller, the Record screen's words
e4508e0 feat(dictation): Dictation on the library card and the meeting header
56c6dc9 feat(dictation): the Dictation label — chip fixed, one voice
0afef4c docs(phase5): Session 2 execution sheet — the screens; release plan row updated
```

Session 3 (device, 21 Sep):

```
419907e test(vocab): the probe prints mode, the vocabulary and which lines were rewritten
348d600 test(vocab): NativePipelineTest 18/18 on the Galaxy Tab A, ten assumption skips as predicted
1d7c2df test(vocab): VocabularyDbTest in device-verify CLASSES — 4/4 on the Galaxy Tab A
```

Review of Session 3 (the brain, 21 Sep):

```
6be5974 fix(vocab): COALESCE is the one guard on text_raw — the Kotlin binding duplicated it and made the device mutant equivalent
```
