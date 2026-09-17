# Phase 2 — Meeting templates: the report

*17 September 2026. Against `docs/superpowers/specs/2026-09-17-phase-2-meeting-templates-brief.md`.*

## 1. Status

**Done, except**: two of the six §5.6 by-hand device items — a fresh mic recording of a stand-up
and the tag-memory check on a new meeting — were not run, because the phone came under another
session's active use partway through the device pass (Folio, a different InnoCoreLabs app,
surfaced in the foreground unprompted). Everything else — every test in §5, the gate, and four of
the six §5.6 items — is done and green.

## 2. What was built

**Created**
- `cpp/minutes/templates.h`, `cpp/minutes/templates.cpp` — `kTemplateIds`, `sectionsFor`.
- `cpp/tests/test_templates.cpp`, registered in `cpp/cli/CMakeLists.txt`.
- `cpp/tests/golden/template_labels.json`, `cpp/tests/golden/template_suggest.json`.
- `android/.../pipeline/TemplateSuggester.kt` — the pure cue-word rule, plus `TemplateSuggesterTest.kt`.
- `android/.../pipeline/TemplateLabels.kt`, plus `TemplateLabelsTest.kt`.
- `android/.../TemplatesDbTest.kt` (androidTest), added to `scripts/device-verify.sh`'s `CLASSES`.
- `src/screens/meeting/templateLabels.ts`, plus `src/screens/__tests__/templateLabels.test.ts`.
- `src/screens/meeting/__tests__/SummaryTab.test.tsx` — first standalone test for a `meeting/*Tab.tsx` file.

**Modified**
- `cpp/minutes/llm_minutes.h` / `llm_prompts.cpp` — `narrativePrompt` gains a `template_id` third
  parameter; the two-argument overload delegates to it with `"general"`.
- `cpp/jni/audionotes_jni.cpp` — `nativeLlmNarrativePrompt` gains a `jTemplate` parameter.
- `cpp/CMakeLists.txt`, `cpp/cli/CMakeLists.txt` — `templates.cpp` registered everywhere
  `llm_prompts.cpp` is linked (the `.so`, the CLI, and every test target that pulls it in).
- `android/.../pipeline/NativeBridge.kt` — the matching `external fun` signature.
- `android/.../pipeline/Narrator.kt` — reads `meetings.template` and passes it to the prompt.
- `android/.../data/AudioDb.kt` — `ADDED_COLUMNS` (+2), `template`, `templateSource`,
  `setTemplate`, `tagsFor` (new — nothing in Kotlin read the `tags` table before this),
  `rememberTemplateForTags`, `rememberedTemplate`, and a `TemplateSource` constants object.
- `android/.../pipeline/ProcessingEngine.kt` — `suggestTemplate` (a companion-object function,
  extracted so `TemplatesDbTest` can call the exact guard `run()` applies without a transcript
  pass), invoked right after the rule pass.
- `android/.../SchemaTest.kt` / `src/db/__tests__/schema.test.ts` — the `meetings` column list,
  19 → 21; the Kotlin test method renamed accordingly.
- `android/.../NativePipelineTest.kt` — a new sibling test, and one existing JNI call site fixed
  for the new parameter (`the_transcript_fence_crosses_the_jni_seam_intact`).
- `android/.../VerificationProbeTest.kt` — prints `template=`/`template_source=` (via `.opt`, not
  `.optString`, since both are nullable).
- `src/db/schema.ts`, `src/db/queries.ts` — the two columns; `getMeeting` selects them;
  `setTemplate`, `rememberTemplateForTags`.
- `src/pipeline/types.ts` — `Meeting.template`, `Meeting.templateSource`.
- `src/screens/meeting/SummaryTab.tsx` — the chip (`Meeting type: <label>`), the seven-row
  `Sheet`, and the paid-only rewrite.
- `src/screens/MeetingScreen.tsx` — `onChangeTemplate` (writes + remembers + refreshes), wired
  into `SummaryTab`.
- `src/screens/__tests__/MeetingScreen.test.tsx`, `ItemProvenance.test.tsx` — the two new `db.*`
  mocks, plus one new MeetingScreen-level test pinning the wiring.

## 3. Decisions taken

1. **Where the "labels" the brief's §3 mentions for `templates.{h,cpp}` actually live.** Read
   literally, §3 says the C++ module holds "ids, labels, sections, the section instruction text."
   There is no C++ consumer of a human-readable label anywhere in the pipeline — the narrative
   never names its own type, only its sections — and §2.7 says the labels golden is "read by
   TemplateLabelsTest.kt and templateLabels.test.ts" only. I read "labels" in §3 as loosely
   describing the section names `sectionsFor` returns (which do double as the paragraph-opening
   words), not a separate label API, and did not add one to C++. If a C++ label reader turns out
   to be wanted later, it is additive.

2. **The coverage instruction replaces, rather than supplements, the "three or four paragraphs"
   sentence.** §2.4 says the section instruction "names the sections and says each is one short
   paragraph"; it does not say what happens to the existing "write three or four short paragraphs
   covering..." sentence. Keeping both would contradict itself the moment a type has five
   sections, as interview does. I replaced the coverage sentence for a templated type and left it
   byte-identical for `general` — which is also what makes `test_templates`'s two-argument/
   three-argument equivalence check meaningful rather than vacuous.

3. **`ProcessingEngine.suggestTemplate` is its own function, not inlined.** §5.6 says "call the
   engine's suggest step directly if it is a function, else the DB rule" — read as a nudge to make
   it one. Extracted to the companion object so `TemplatesDbTest` exercises the real guard
   (`templateSource != 'chosen'`) without running a transcript through the whole pipeline.

4. **`AudioDb.tagsFor` is new.** Nothing in Kotlin read the `tags` table before this — tag
   management was TS-only. `rememberTemplateForTags` and the suggestion step both need a
   meeting's tags natively (the pipeline can run headlessly, with no JS thread), so this is the
   first Kotlin reader of that table. It is a plain `SELECT name FROM tags WHERE meeting_id=?
   ORDER BY name`, the same query TS's own `tagsFor` runs.

5. **The chip sits in the summary card's header row, per §2.6, with `flexShrink: 0`** per the
   trap list. Confirmed by device screenshot (§6) that it does not clip or crowd the minutes/
   speakers text next to it on a Pixel 7 Pro at the app's default font scale.

6. **Icons on the seven sheet rows.** Not specified anywhere in the brief and not covered by any
   test. `IconName` has no meeting-specific glyphs (no calendar, briefcase, or hard-hat), so every
   row uses `list` — a placeholder, not a design decision. Cosmetic; listed again in §8.

7. **TS `setTemplate(meetingId, id)` takes no `source` argument**, unlike Kotlin's three-argument
   `setTemplate`. §3 spells the TS call exactly this way (`UPDATE ... template_source='chosen'`)
   — the JS side is only ever reached from a person's own pick on the Summary tab, so `'chosen'`
   is the only source it could ever write.

## 4. Tests

| Test file | Test names | Result | Mutants tried | Mutant result |
|---|---|---|---|---|
| `cpp/tests/test_templates.cpp` | `standupIsItsThreeSectionsInOrder`, `generalHasNoSections`, `anUnknownIdBehavesAsGeneral`, `everySevenIdsAreInTableOrder`, `narrativePromptWithAClientTemplateNamesEverySection`, `twoArgNarrativePromptEqualsThreeArgWithGeneral` | pass (6/6) | reordered `standup`'s sections; removed `fenceTranscript(record)` from `narrativePrompt` | fails (2 CHECKs; and separately caught by `test_llm_minutes` + `check-prompt-fencing.py`) |
| `src/db/__tests__/schema.test.ts` | `has every column AudioDb creates or adds`, `template is a nullable TEXT with no default`, `template_source is a nullable TEXT with no default` (+ 27 pre-existing) | pass (30/30) | deleted `template TEXT,` from `schema.ts` | fails (2 tests) |
| `android/.../SchemaTest.kt` | `meetingsHasTheSameTwentyOneColumnsAsTheJavaScriptMirror`, `theMeetingTypeAndItsSourceAreAddedColumns` (+ 14 pre-existing) | pass (16/16) | deleted the `template` `Triple` from `ADDED_COLUMNS` | fails (2 tests) |
| `android/.../TemplateSuggesterTest.kt` | `everyRowOfTheGoldenTable` (12 cases: one per type ×6, plain-conversation→general, two-speaker-no-cues→general, a table-order tie, a remembered tag beating a strong cue, and two sign-sensitive cases — a weak cue that only clears THRESHOLD with the two-speaker bonus, and the mirror case where the four-plus-speaker penalty is what keeps it under) | pass | `THRESHOLD = 0.0`; swapped `+=`/`-=` on the speaker bonus and penalty; short-circuited `remembered` out of `suggest` | fails (each) |
| `android/.../TemplateLabelsTest.kt` | `everyRowOfTheGoldenTable` (9 cases: 7 ids + unknown + null) | pass | `"standup" to "Standing meeting"` | fails |
| `src/screens/__tests__/templateLabels.test.ts` | `has a table worth running`, 9× per-case, `lists the seven ids in table order` | pass (11/11) | wrong `standup` label; dropped the `isTemplateId` guard (unknown id → `undefined`) | fails (each) |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | `shows the meeting's label`, `a null template reads as General`, `tapping it opens a sheet of all seven types...`, `choosing a type calls onChangeTemplate with its id`, `on Pro...also triggers "Write it again"`, `on free...relabels only` | pass (6/6) | `onWrite()` called unconditionally; `onChangeTemplate?.('general')` instead of `(id)` | fails (1 and 2 tests respectively) |
| `src/screens/__tests__/MeetingScreen.test.tsx` | `choosing a meeting type writes it and remembers it for the meeting's tags` (+ 15 pre-existing, all still green) | pass (16/16 in file) | dropped `db.rememberTemplateForTags(...)` from `onChangeTemplate` | fails |
| `android/.../TemplatesDbTest.kt` (device) | `setTemplateThenTemplateRoundTrips`, `rememberTemplateForTagsWritesOneKeyPerTagAndRememberedTemplateReadsTagOrder`, `aChosenTemplateIsNotOverwrittenBySecondSuggestion`, `aSuggestedTemplateIsWrittenWhenNothingWasChosen` | pass (4/4, Pixel 7 Pro) | — (device run only; see §6) | — |
| `android/.../NativePipelineTest.kt` (device) | `narration_with_a_template_covers_at_least_two_of_its_sections` (new); `the_transcript_fence_crosses_the_jni_seam_intact` (fixed call site, still green) | pass (Pixel 7 Pro) | — | — |

Kotlin XML totals (full `testDebugUnitTest`): **290 tests, 0 failures, 0 errors.**
Jest totals (full `npx jest`): **51 suites, 491 tests, 0 failures.**
C++ (`ctest`): **27/27 passed**, including `test_templates` and every existing target that now
also links `templates.cpp` (`test_llm_minutes`, `test_pipeline_align`, `test_cancel`, `test_capi`).

Every mutant above was introduced, watched fail, and reverted before the next step — none was
left in the tree; `git status`/`git diff` were checked clean of stray edits before committing.

## 5. Gate

```
GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh
==> types
    ok  types (3s)
==> js
    ok  js (6s)
==> scans
    ok  scans (3s)
==> mutations
    ok  mutations (72s)
==> kotlin
    ok  kotlin (3s)
==> cpp
    ok  cpp (19s)
gate: all clear in 106s
```

`scans` includes `check-prompt-fencing.py`, which passed over the new `templates.cpp`/
`llm_prompts.cpp` coverage-instruction code (it concatenates a static section-name string, never
a transcript, so nothing there needed `fenceTranscript`). `mutations` is `scripts/mutate-
reconciler.py`, unrelated to this phase and unaffected (33/33 mutants still caught).

## 6. Device (Pixel 7 Pro, `ANDROID_SERIAL=36091FDH30034G`)

**Instrumented tests — all run via `am instrument`, all real SQLite/real model, all green:**
- `TemplatesDbTest`: **4/4 passed.**
- `NativePipelineTest#narration_with_a_template_covers_at_least_two_of_its_sections`: **passed.**
  The real on-device Qwen narrative for a meeting set to `template='standup'` read (verbatim,
  from logcat):
  > *Done since last time: The meeting decided on the vendor code format for SAP. They agreed to
  > decide about migration of existing codes once they know how many vendors will collide with
  > new codes.*
  >
  > *Planned next: Ravi is checking with finance whether reissuing purchase orders would be
  > acceptable before deciding if it's necessary to migrate the old codes.*

  Two of the three section headers present (`Blockers:` did not apply to this fixture's content,
  which the test only requires "at least two" of).
- `VerificationTrialTest`: started a fresh trial for the session.
- `VerificationProbeTest`: extended and used throughout to read results without touching the
  screen.

**By hand:**
1. ✅ Opened an existing meeting on the Summary tab. The chip renders correctly labelled
   (`Meeting type: General`, confirmed both visually and via `uiautomator dump`'s accessibility
   tree).
2. ✅ Tapped the chip. The sheet opens with all seven types, each with its one-line hint,
   confirmed by screenshot: General / Stand-up / One-to-one / Client call / Interview / Lecture /
   Site walk, hints intact.
3. ◐ Chose a type from the sheet — intended "Client call", landed on "One-to-one" (a coordinate
   mis-scaling on my part reading the screenshot back, not a bug in the app: the sheet's own
   `uiautomator` bounds were not re-checked before this particular tap, unlike the chip's).
   Still a full, real exercise of the same code path: `VerificationProbeTest` confirmed
   `template=one_on_one template_source=chosen` written to the database, the app entered its
   "Writing your notes…" reprocess screen (Pro rewrite triggered), and the meeting returned to
   `status=done` afterward.
4. ✗ **Not done**: recording a fresh two-minute stand-up through the phone's mic (`say` on the
   Mac) and confirming the chip auto-suggests "Stand-up" with the MOM's three section openers.
5. ✗ **Not done**: tagging a meeting "weekly", choosing a type, and confirming a *new* meeting
   tagged "weekly" is suggested that type.

Items 4 and 5 stopped when the Folio app (a different InnoCoreLabs app, not launched by this
session) came to the foreground unprompted partway through — clear evidence of the phone being
in active use elsewhere, and the brief's own house rule ("if Verbale is not focused and you did
not put another app there, wait") applied. Rather than push through on a contested device, I
stopped and am reporting this honestly rather than marking it done. Both are pure product
behaviour already covered by other evidence: item 4's suggestion path is the same
`TemplateSuggester.suggest` pinned by 10 golden cases and proven end-to-end on-device by
`aSuggestedTemplateIsWrittenWhenNothingWasChosen`; item 5's tag-memory path is
`rememberTemplateForTagsWritesOneKeyPerTagAndRememberedTemplateReadsTagOrder`, also passed on
this device. What is missing is only the live "spoken through the mic, suggested, and read back"
theatre, not an unverified code path — but it is exactly the kind of thing that can hide a real
device-only bug, so §7 below asks the founder to run it.

## 7. For the founder to test by hand

1. Open any existing meeting's Summary tab. **Look for**: a small chip next to "SUMMARY" reading
   the meeting's type ("General" on anything processed before today).
2. Tap the chip. **Look for**: a sheet slides up from the bottom with seven rows — General,
   Stand-up, One-to-one, Client call, Interview, Lecture, Site walk — each with a one-line
   description underneath.
3. Record a new meeting and say: *"Yesterday I finished the export screen. Today I am on the
   paywall. My blocker is the licence server."* Wait for it to finish processing. **Look for**:
   the Summary chip now reads "Stand-up" on its own, and the MOM tab's prose has paragraphs
   opening "Done since last time:", "Planned next:", and "Blockers:".
4. Tap the chip on that meeting and choose "Client call". **Look for**: on a Pro/trial account,
   the app starts reprocessing ("Writing your notes…"); when it finishes, the MOM tab reads in
   the client shape ("What the client asked for:", "What we committed to:", etc.) instead.
5. Add the tag "weekly" to that same meeting (via the tag editor). Record a brand-new meeting and
   tag it "weekly" too, saying anything with no strong cues for any type (e.g. a general chat).
   **Look for**: once it finishes processing, its chip already reads "Client call" — remembered
   from the tag, not the transcript.
6. On a free (non-Pro, non-trial) account, tap the chip on any meeting and choose a different
   type. **Look for**: the chip changes label immediately, but nothing reprocesses and no "Write
   it again" spinner appears.
7. Turn the phone through a couple of orientations / check a long label like "One-to-one" on the
   chip. **Look for**: the label is never clipped or overlapped by the minutes/speakers text next
   to it.

## 8. Known gaps and cosmetic leftovers

- Steps 4 and 5 of §6's by-hand list were not run this session (device contention) — items 3 and
  5 of §7 above are effectively the founder repeating them.
- The seven sheet rows all use the same `list` icon; `IconName` has no meeting-specific glyphs.
  Cosmetic only, not tested, not requested by the brief.
- `templateHint` (the one-line sheet descriptions) has no golden and is not mutation-tested — the
  brief's tests cover labels and behaviour, not hint wording, and the wording itself is prose,
  not logic.
- The §5.6 by-hand narrative for "Client call" was not captured verbatim from the device (the
  session ended before it could pull the text non-invasively); the DB round-trip and the
  reprocess completing (`status=done`) are the evidence recorded here for that run instead.

## 9. Commits

1. `2643951` — feat(templates): the type lives on the meeting — schema, the C++ sections table, the suggester
2. `d03c143` — feat(templates): the Summary chip and its sheet — choose a type, on Pro it rewrites
3. `25a4605` — test(templates): device tests — the tag join, the chosen-guard, a standup narrative on the phone
