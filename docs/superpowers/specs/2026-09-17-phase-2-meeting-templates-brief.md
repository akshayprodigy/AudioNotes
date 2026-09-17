# Phase 2 — Meeting templates: the brief for the session that builds it

*17 September 2026. This is a self-contained prompt for a development session (any model). It
says what to build, how to work, exactly which tests must exist and pass, and what the final
report must contain. The founder reviews the report, then tests the phone by hand from the
report's own checklist. Phase 2 of `docs/superpowers/plans/2026-09-17-release-phases.md`.*

---

## 0. How to work in this repository (read before anything else)

1. **Read first, in this order:** this brief; `docs/superpowers/plans/2026-09-17-release-phases.md`;
   `docs/superpowers/specs/2026-09-16-evidence-record-and-review-design.md` §1 (how the narrator,
   the classifier and the C++ prompts fit together); `cpp/minutes/llm_prompts.cpp`;
   `android/app/src/main/java/com/innocorelabs/verbale/pipeline/Narrator.kt`;
   `src/screens/meeting/SummaryTab.tsx`. Do not read the whole repository — these are enough.
2. **Test-driven, every step.** Write the failing test, run it and watch it fail, write the
   smallest code that passes, run it green, then **mutation-check it**: break the implementation
   on purpose in one plausible way (flip a condition, drop a branch, return a constant), watch the
   test FAIL, restore, run green again. A test that survives its mutant is not finished. Do this
   in the foreground; never run a restore in the background. Record every mutant and its result
   in the report.
3. **Commands you will use** (from the repo root):
   - Kotlin unit tests: `cd android && ./gradlew :app:testDebugUnitTest --tests '*NameTest*'`
     then read `app/build/test-results/testDebugUnitTest/TEST-*.xml` — "BUILD SUCCESSFUL" alone
     is not proof a test ran; check `tests="N" failures="0"`.
   - jest: `npx jest src/path/to/file.test.tsx --forceExit`.
   - TypeScript: `npx tsc --noEmit`. Lint: `npx eslint <files>`.
   - C++ (Mac): `CMAKE=$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake; $CMAKE --build
     cpp/cli/build -j 8 && (cd cpp/cli/build && $(dirname $CMAKE)/ctest --output-on-failure)`.
     C++ tests use a `CHECK` macro, never `assert` (Release build compiles asserts away).
   - The gate, before every commit that touches more than one layer:
     `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh` — must end
     "gate: all clear". `scripts/check-prompt-fencing.py` runs inside it: every prompt is built in
     C++ and any transcript text enters a prompt only through `fenceTranscript()`.
   - Device: `export ANDROID_SERIAL=36091FDH30034G` (the Pixel 7 Pro; emulators are often
     attached too), then `scripts/device-verify.sh <ClassNameSubstring>`. It builds, installs both
     APKs (keeping app data) and runs the class. A new androidTest class must be added to the
     `CLASSES` list in that script or it never runs. Pro features need the trial:
     `adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationTrialTest
     com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner` starts a fresh one
     (3 narrations). `VerificationProbeTest` (same command shape) prints the newest meetings'
     database rows to logcat as `PROBE …` — read results without touching the screen. The debug
     build needs Metro: `npx react-native start` and `adb reverse tcp:8081 tcp:8081`.
   - Before driving the screen: `adb shell dumpsys window | grep mCurrentFocus`. Another
     session sometimes drives the same phone; if Verbale is not focused and you did not put
     another app there, wait.
4. **Commit after every green task** with a message that says what changed and why (the
   commit history shows the house style). Never push; the founder pushes `main`. Never run
   `connectedDebugAndroidTest` (it uninstalls the app and wipes the models and the database).
5. **Decisions.** The design below is decided. If something is genuinely unspecified, choose the
   simplest option that keeps every listed test meaningful, and record the choice in the report's
   "Decisions taken" section. Do not widen the scope: no features not listed here.
6. **When you are done** — every test in §5 exists and passes, the gate is clear, the device
   run in §5.6 is done — write the report (§7) and stop. If a device step cannot run (phone
   absent), say so in the report; do not mark it done.

---

## 1. What Phase 2 builds

A meeting has a **type** — stand-up, one-to-one, client call, interview, lecture, site walk, or
general — and the type changes what the written-up minutes (the Pro narrative) cover. The type
is suggested automatically from the transcript, shown on the Summary tab, can be changed by the
person, and is remembered per tag so the next "weekly" or "client-acme" meeting starts with the
right one.

The research behind it (`docs/PRODUCT_RESEARCH_2026-09.md` §2.4 #13): competitors sell
thousands of templates; on-device it is prompt text. This is the cheapest of the four moat
features and the founder named it among the most important.

**What a type changes, and what it does not.**
- Changes: the *sections* the narrative covers, as an instruction to the writer model. The
  narrative stays plain prose (the existing rules in `narrativePrompt` about no forms, no
  placeholders, no attendee lists all stand), but each section becomes its own short paragraph
  opening with the section's name and a colon — e.g. `Blockers: …`. The MOM tab already renders
  paragraphs; nothing changes there.
- Does not change: the transcript, the rule-based items, the summary paragraph, the classifier,
  exports' layout (the narrative is exported as it is written), the free tier (a free user sees
  the type chip and can change it, but no narrative is written for them — same gate as today).

**The seven types and their sections (final for v1):**

| id | label | sections, in order |
|---|---|---|
| `general` | General | *(none — today's narrative, unchanged)* |
| `standup` | Stand-up | Done since last time · Planned next · Blockers |
| `one_on_one` | One-to-one | Topics raised · Agreed · Follow-ups |
| `client` | Client call | What the client asked for · What we committed to · Risks and open points · Next steps |
| `interview` | Interview | Background · Questions and answers · Strengths · Concerns · Next step |
| `lecture` | Lecture | Key points · Definitions and terms · Questions raised · To read or do |
| `site_walk` | Site walk | Observations · Issues found · Actions agreed |

---

## 2. Decisions already taken — do not reopen

1. The type lives on the meeting: `meetings.template TEXT` (nullable; one of the seven ids)
   and `meetings.template_source TEXT` (`suggested` | `chosen`; nullable). Both are
   `ADDED_COLUMNS` in `AudioDb.kt` AND columns in `src/db/schema.ts`'s `meetings`; both schema
   tests' column lists grow by two (see §5.1).
2. **Suggestion is a rule, not the model** (`TemplateSuggester.kt`, pure, golden-tested): cue
   words per type counted over the transcript, normalised per hundred words; the top type wins
   when its score clears a threshold, else `general`. Diarization's speaker count is one more cue
   (two voices favours `one_on_one`; four or more disfavours it). A tag's remembered type beats
   the rule. Deterministic, so a golden table can pin it in Kotlin; there is no TS mirror of the
   suggester (TS only labels).
3. **Remembered per tag**: choosing a type on a meeting that has tags writes
   `template.tag.<tag>` = id into `settings` for each of its tags (`AudioDb.putSetting`). The
   suggester, given the meeting's tags, takes the first remembered type it finds (tags in
   alphabetical order) before running the rule. Removing the memory is out of scope.
4. **The prompt is C++.** `cpp/minutes/templates.{h,cpp}`: `kTemplateIds`, `sectionsFor(id)`,
   and `narrativePrompt(record, language, template_id)` gains its third parameter in
   `llm_prompts.cpp` (keep the two-argument overload delegating to `general` so nothing else
   changes). The section instruction is plain text after the RECORD block; it names the sections
   and says each is one short paragraph opening with the name and a colon, and that a section
   with nothing to say is left out entirely rather than written as "nothing was discussed".
   *Amended in review, 17 Sep:* the shape is also enforced as a rule — `foldSections(text,
   template_id)` in `templates.cpp`, run by `Narrator.clean` between `stripMarkdown` and
   `stripLabels`, because the writer sometimes leaves a section name alone on a line and
   `stripLabels` drops exactly that (see the report's §10).
   JNI: today `nativeLlmNarrativePrompt(record)` calls `narrativePrompt(s, "en")` through the
   `promptCall` helper in `audionotes_jni.cpp` (line ~1019); it gains a `jstring jTemplate`
   parameter and the Kotlin extern in `NativeBridge.kt` gains it too. Language stays "en".
5. **Where it runs**: `ProcessingEngine`, after the rule pass (`minutes`) and before narration:
   if `meetings.template_source` is not `chosen`, run the suggester and store the result as
   `suggested`. `Narrator.run` reads `meetings.template` (null → `general`) and passes it to the
   prompt. "Write it again" therefore rewrites with the current type.
6. **The screen**: on the Summary tab, a chip in the summary card's header row ("Stand-up",
   "General"…), tappable → a `Sheet` of the seven types with one-line hints → choosing writes
   `template` + `template_source = 'chosen'` (+ the tag memory) and, on Pro, triggers the
   existing "Write it again" path so the narrative is rewritten in the new shape; on free it
   just relabels. The chip's accessibility label is `Meeting type: <label>`.
7. Labels are one golden for both languages (`cpp/tests/golden/template_labels.json`), read by
   `TemplateLabelsTest.kt` and `templateLabels.test.ts`, like `record_labels.json` is today.
8. Free tier: unchanged narrative gate; the chip and the sheet work; choosing a type on free
   shows no paywall (it is a label until they buy).

---

## 3. Files

**Create**
- `cpp/minutes/templates.h`, `cpp/minutes/templates.cpp` — ids, labels, sections, the section
  instruction text. Add `minutes/templates.cpp` to `cpp/CMakeLists.txt` and to every test target
  in `cpp/cli/CMakeLists.txt` that links `llm_prompts.cpp`.
- `cpp/tests/test_templates.cpp` (register in `cpp/cli/CMakeLists.txt` like `test_ask`).
- `cpp/tests/golden/template_labels.json`, `cpp/tests/golden/template_suggest.json`.
- `android/app/src/main/java/com/innocorelabs/verbale/pipeline/TemplateSuggester.kt`,
  `TemplateLabels.kt`; tests `TemplateSuggesterTest.kt`, `TemplateLabelsTest.kt`.
- `src/screens/meeting/templateLabels.ts`; test `src/screens/__tests__/templateLabels.test.ts`.
- `android/app/src/androidTest/java/com/innocorelabs/verbale/TemplatesDbTest.kt` (add to
  `scripts/device-verify.sh` CLASSES).

**Modify**
- `cpp/minutes/llm_prompts.h/.cpp` (`narrativePrompt` third parameter), `cpp/jni/audionotes_jni.cpp`
  (`nativeLlmNarrativePrompt` gains `jstring jTemplate` — put any new helper use AFTER the
  `jstrArray`/`jlongVec` helpers, which are defined mid-file), `NativeBridge.kt`.
- `AudioDb.kt`: `ADDED_COLUMNS` (+2), `template(meetingId)`, `setTemplate(meetingId, id, source)`,
  `rememberTemplateForTags(meetingId, id)`, `rememberedTemplate(tags)`; add the two columns to
  the existing `companion object` — the class has exactly one.
- `src/db/schema.ts` (+2 columns), `src/db/__tests__/schema.test.ts` and
  `android/app/src/test/java/com/innocorelabs/verbale/SchemaTest.kt` (the meetings column lists:
  nineteen → twenty-one; rename the Kotlin test method accordingly).
- `ProcessingEngine.kt` (suggest before narrate), `Narrator.kt` (read the type, pass it).
- `src/pipeline/types.ts` `Meeting` gains `template: string | null`, `templateSource: string | null`;
  `src/db/queries.ts` `getMeeting` (line ~157) selects `template, template_source AS
  templateSource`; `setTemplate(meetingId, id)` runs `UPDATE meetings SET template=?,
  template_source='chosen' WHERE id=?` through `run(...)`, and `rememberTemplateForTags(meetingId,
  id)` writes `INSERT OR REPLACE INTO settings(key, value)` rows `template.tag.<tag>` for each
  of `tagsFor(meetingId)` — check the `settings` table's column names in `schema.ts` first.
- `src/screens/meeting/SummaryTab.tsx` (chip + sheet + rewrite), `src/screens/MeetingScreen.tsx`
  (pass the meeting's template and the rewrite callback), and the jest mocks in
  `src/screens/__tests__/MeetingScreen.test.tsx` and `ItemProvenance.test.tsx` for any new
  `db.*` call (24 tests fail otherwise).
- `android/app/src/main/java/com/innocorelabs/verbale/pipeline/FileExportModule.kt`: nothing —
  the narrative is exported as written. Confirm with the existing `ExportItemsTest` staying green.

---

## 4. The suggester's rule (so the golden is unambiguous)

Cues are lower-case whole words or short phrases matched in the joined transcript text:

- `standup`: yesterday, today i, blocker, blockers, blocked, stand-up, standup, "what did you do",
  "working on".
- `one_on_one`: "how are you", career, feedback, "one on one", 1:1, growth, "how do you feel".
- `client`: client, contract, proposal, pricing, quote, invoice, scope, deliverable, "your team".
- `interview`: candidate, interview, "tell me about", experience, role, hiring, résumé, resume,
  "why do you want".
- `lecture`: lecture, chapter, definition, theorem, homework, assignment, "for example", syllabus.
- `site_walk`: site, inspection, observed, floor, "on site", hazard, defect, snag, contractor.

Score(type) = cue hits × 100 / words in transcript. Speaker cue: `speakers == 2` adds 1.0 to
`one_on_one`; `speakers >= 4` subtracts 1.0 from it. Winner = highest score if ≥ 1.5, else
`general`. Ties → the type listed first in the table of §1. A remembered tag type wins over all
of this. Put the exact numbers in `TemplateSuggester.kt` as named constants and in the golden's
`note`.

---

## 5. Definition of done — the tests

Every test below must exist, pass, and have at least one recorded mutant that fails it.

**5.1 Schema**
- `schema.test.ts`: `meetings` has `template` and `template_source`, both `TEXT`, nullable, no
  default. `SchemaTest.kt`: the same two in `ADDED_COLUMNS`; the mirror list matches (twenty-one).
  *Mutant:* remove one column from `schema.ts` → the TS test fails; remove from `ADDED_COLUMNS`
  → the Kotlin test fails.

**5.2 C++**
- `test_templates`: `sectionsFor("standup")` is the three sections in order; `sectionsFor("general")`
  is empty; an unknown id behaves as `general`; `narrativePrompt(record, "en", "client")` contains
  every client section name and still contains the fence preamble (`RECORD OF A MEETING`); the
  two-argument `narrativePrompt` equals the three-argument one with `general`.
  *Mutants:* sections for the wrong type; fence removed (the `check-prompt-fencing.py` scan must
  also fail on that mutant — run it and record the output).

**5.3 Kotlin**
- `TemplateSuggesterTest` against `template_suggest.json`: at least nine cases — one clear
  transcript per type (six), a plain conversation → `general`, a two-speaker chat with no cues →
  `general` (the speaker cue alone must not decide), a tie broken by table order, a remembered
  tag beating a strong cue. *Mutants:* threshold 0; speaker cue sign flipped; tag memory ignored.
- `TemplateLabelsTest` against `template_labels.json`: every id → label; unknown → "General".
- `ItemClassifierTest` and every existing test stay green (`./gradlew :app:testDebugUnitTest`).

**5.4 TypeScript**
- `templateLabels.test.ts` reads the same golden.
- `SummaryTab.test.tsx` (extend the existing file; find how it is rendered there first):
  the chip shows the meeting's label ("Stand-up"); tapping it opens the sheet with seven rows;
  choosing "Client call" calls the new `onChangeTemplate('client')` prop. The tab does not
  know Pro itself — it learns `reason === 'locked'` from `Licence` (see the effect near line
  150 of `SummaryTab.tsx`); so: when the entitlement mock says paid, the choice also calls
  `onWrite` (the existing "Write it again" path); when it says not paid, it does not, and
  nothing navigates. `MeetingScreen` implements `onChangeTemplate` as `db.setTemplate` +
  `db.rememberTemplateForTags` + a refresh of the meeting. *Mutants:* `onWrite` called on
  free; the wrong id passed.
- `MeetingScreen.test.tsx` still green with the new mocks.

**5.5 Gate** — `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh` → "all
clear". Paste the stage summary into the report.

**5.6 Device (Pixel, `ANDROID_SERIAL=36091FDH30034G`)**
- `TemplatesDbTest` (write it; add to CLASSES): `setTemplate` then `template()` round-trips;
  `rememberTemplateForTags` writes one settings key per tag and `rememberedTemplate` reads it
  back in tag order; a meeting with `template_source='chosen'` is not overwritten by a second
  suggestion (call the engine's suggest step directly if it is a function, else the DB rule).
- `NativePipelineTest`: extend `narration_writes_a_summary_a_narrative_and_a_headline` or add a
  sibling: with `template='standup'` set on the meeting before narration, the narrative contains
  at least two of the three section names (case-insensitive). The jfk fixture is one sentence and
  will not narrate (too short); use the same multi-sentence path that test already uses, or the
  `processing_a_meeting_headlessly_leaves_it_narrated` fixture — read those tests first.
- By hand (record in the report with what you saw): start the trial; record a two-minute
  stand-up through the phone's mic (`say` on the Mac works: "Yesterday I finished the export
  screen. Today I am on the paywall. My blocker is the licence server."); after processing the
  Summary chip reads "Stand-up" and the MOM prose has paragraphs opening "Done since last time:",
  "Planned next:", "Blockers:"; tap the chip → choose "Client call" → the narrative is rewritten
  in the client shape; add the tag "weekly" to the meeting first and confirm a NEW meeting with
  tag "weekly" is suggested the chosen type (`VerificationProbeTest` prints `template=` if you
  add it to the probe's SELECT — do, it is a verification tool).

---

## 6. Traps in this codebase (each has bitten a previous session)

- JNI helpers `jstr`, `jstrArray`, `jlongVec` are defined mid-file in `audionotes_jni.cpp`; a new
  function using them must be placed after them.
- `AudioDb` has ONE `companion object`; add statics there.
- Android's `org.json` `optString` on a SQL NULL returns the string `"null"` — use `isNull` first.
- `Modal` in the jest mock renders nothing when `visible={false}`; a hidden sheet's rows are
  not findable, which is what you want.
- The custom font measures a few pixels short on Android: a short label at its intrinsic width
  wraps its last word and clips. Give chip labels `flexShrink: 0` or the row (`flex: 1`), and
  check a screenshot.
- Every prompt is built in C++; `check-prompt-fencing.py` scans names ending in `text`,
  `transcript`, `utterance`, `chunk`, `turn`, `record` — name transcript-carrying variables so it
  can see them, and pass them through `fenceTranscript`.
- A new `db.*` call from `MeetingScreen` needs stubs in two test files (§3).
- The 7-day trial is spent after three narrations; restart it with `VerificationTrialTest`.
- Reinstalling kills an in-progress recording; the queue restarts when the app is opened.

---

## 7. The report

Write `docs/superpowers/reports/2026-MM-DD-phase-2-meeting-templates.md` (create the folder)
with these sections, in this order, and nothing invented — if something was not run, say so:

1. **Status** — one line: done / done except (list).
2. **What was built** — files created and modified, one line each.
3. **Decisions taken** — anything this brief left open and what you chose, with the reason.
4. **Tests** — a table: test file · test names · result · mutants tried (what you changed) ·
   mutant result (must be "fails"). Include the Kotlin XML counts and the jest totals.
5. **Gate** — the stage summary lines from the run.
6. **Device** — each §5.6 item with what the phone showed; screenshots saved under
   `docs/superpowers/reports/phase-2/` are welcome but not required.
7. **For the founder to test by hand** — five to eight numbered steps on the phone, each with
   the exact thing to look for, so a person can confirm the phase without reading code.
8. **Known gaps and cosmetic leftovers.**
9. **Commits** — the hashes and subjects, oldest first.

Then update `docs/superpowers/plans/2026-09-17-release-phases.md` (Phase 2 → "Done <date>",
Phase 3 → "Next"), add one row to
`docs/superpowers/specs/2026-09-15-improvement-report-scorecard.md` ("Meeting templates" → ✅),
and commit. Do not push.

---

## 8. Out of scope for Phase 2

Custom user-defined templates; per-type item extraction rules; type-specific exports; the
narrator citing sections back to turns; suggesting the type during recording; removing a tag's
remembered type; anything in Phases 3–6.
