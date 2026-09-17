# Phase 4 — Remembered voices (the brief)

*17 September 2026. Written for the session that builds it — a model with a 262k-token context,
so this brief is also a budget: it is built in TWO sessions (§0.8), each with a fixed stopping
point and a progress file, and every rule in §0.4 exists to keep tool output out of the context.
Sub-project 7 of the release plan (`docs/superpowers/plans/2026-09-17-release-phases.md`), from the
improvement report of 7 Sep ("optional voice profiles"). The C++ that touches the speaker model is
ALREADY DONE and measured (`41f5158`): `Diarizer::speakerVoices` and `test_voices_live`. Nothing in
this phase opens sherpa or a model file.*

---

## 0. How to work in this repository (read before anything else)

1. **Read first, in this order, and ONLY the ranges given:** this brief;
   `docs/superpowers/reports/phase-4-progress.md` if it exists (it says where the previous
   session stopped); `cpp/diar/diarizer.h` lines 72–88 (the `speakerVoices` contract — do not
   read `diarizer.cpp`); `cpp/jni/audionotes_jni.cpp` lines 530–580 (`nativeDiarize`, the JNI
   shape to mirror); `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt`
   lines 255–285 (the diarize stage) and 312–330 (`suggestTemplate`, the hook shape to mirror);
   `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt` lines 880–935
   (`assignSpeakers` — how speaker rows are keyed) and 2793–2862 (`ADDED_COLUMNS`);
   `android/app/src/main/java/com/innocorelabs/verbale/pipeline/VecCodec.kt` (whole, 47 lines);
   `src/screens/SpeakersScreen.tsx` lines 80–130; `src/screens/SettingsScreen.tsx` lines 300–340
   (how a setting is read and written) and 760–790 (a `Switch` row); `src/screens/meeting/SummaryTab.tsx`
   lines 215–245 (the review banner, the banner shape to mirror). Session B additionally reads
   `docs/superpowers/reports/2026-09-17-phase-3-thread-memory.md` §7 (a by-hand section done
   right). **Nothing else, unless a compile error names it.**
2. **Test-driven, every step.** Write the failing test, run it and watch it fail, write the
   smallest code that passes, run it green, then **mutation-check it**: break the implementation
   on purpose in one plausible way (flip a condition, drop a branch, return a constant), watch the
   test FAIL, restore, run green again. A test that survives its mutant is not finished. Record
   every mutant and its result in the progress file as you go, not from memory at the end.
3. **Judge what the phone shows, not what the code returns.** For every line this phase draws,
   one test uses the awkward fixture (three suggestions, a speaker with no voice, a person whose
   name differs only in case) and asserts the rendered text.
4. **Token discipline — the context is 262k and tool output is what fills it.**
   - Never print a whole file over 200 lines. Locate with `grep -n`, then `sed -n 'A,Bp'` for at
     most 60 lines at a time. `AudioDb.kt` is 2,800 lines: only ever the ranges named here.
   - Every build or test command ends in a filter. Gradle:
     `2>&1 | grep -E "BUILD|error:|FAILED|tests completed" | tail -20`, then read the XML counts
     with the python one-liner in §0.5. jest: `--silent 2>&1 | tail -15`. The gate:
     `> /tmp/gate.log 2>&1; grep -E "^==>|ok |FAIL|all clear" /tmp/gate.log`. device-verify:
     `> /tmp/dv.log 2>&1; grep -E "^==>|OK \(|FAILURES|test=|Failure" /tmp/dv.log | tail -30`.
     `adb logcat`: always `-d | grep <tag> | tail -20`, never streaming.
   - Do not re-read a file you just edited to check it; the edit tool reports success.
   - Do not paste large code into your own messages; commit it and name the file.
   - If you notice the context is more than two thirds used, finish the task you are on, commit,
     update the progress file, and stop — the next session resumes from it.
5. **Commands** (from the repo root):
   - Kotlin unit tests: `cd android && ./gradlew :app:testDebugUnitTest --tests '*NameTest*' -q
     2>&1 | grep -E "error:|FAILED|BUILD" | tail -10`, then
     `python3 -c "import glob,xml.etree.ElementTree as E;[print(f.split('/')[-1],E.parse(f).getroot().attrib.get('tests'),E.parse(f).getroot().attrib.get('failures')) for f in glob.glob('app/build/test-results/testDebugUnitTest/*NameTest*.xml')]"`.
     Add `--rerun` if a suite reports time 0.000 (served from cache).
   - jest: `npx jest src/path/to/file.test.tsx --forceExit --silent 2>&1 | tail -15`.
   - TypeScript: `npx tsc --noEmit 2>&1 | tail -10`. Lint: `npx eslint <files> 2>&1 | tail -10`.
   - C++ (Mac): `CMAKE=$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake; $CMAKE --build
     cpp/cli/build -j 8 2>&1 | grep -E "error" ; (cd cpp/cli/build && $(dirname $CMAKE)/ctest 2>&1
     | tail -3)`. Tests use `CHECK`, never `assert`. `test_voices_live` needs the three env vars
     `scripts/gate.sh` exports (lines 21–30); run it through the gate or export the same.
   - The gate before every commit that touches more than one layer:
     `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh` → must end
     "gate: all clear".
   - Device: `export ANDROID_SERIAL=36091FDH30034G`; `scripts/device-verify.sh <ClassSubstring>`
     builds, installs both APKs (keeping data) and runs the class; a new androidTest class must be
     added to `CLASSES` in that script. Pro features need the trial:
     `adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationTrialTest
     com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner` (3 narrations).
     `VerificationProbeTest` prints the newest meetings' rows to logcat as `PROBE …`. Metro for
     the debug build: `npx react-native start` and `adb reverse tcp:8081 tcp:8081`.
   - Before driving the screen: `adb shell dumpsys window | grep mCurrentFocus`. If Verbale is
     not focused and you did not put another app there, wait, and say so in the report.
6. **Commit after every green task**, message in the house style (`git log --oneline -8` shows
   it). Never push. Never run `connectedDebugAndroidTest` (wipes models and database).
7. **Decisions.** §2 is decided. If something is genuinely unspecified, choose the simplest option
   that keeps every listed test meaningful and record it in the progress file's "Decisions". No
   features not listed here; nothing generated by the language model.
8. **Two sessions, one progress file.** Create `docs/superpowers/reports/phase-4-progress.md` as
   your first action (Session A) with the task list of §3.1 as checkboxes and three headings:
   *Decisions*, *Mutants*, *Notes for the next session*. Update it after every commit (it is
   committed with the task). **Session A does Tasks 1–6 and stops** after committing Task 6 and
   the progress file, whatever context remains. **Session B does Tasks 7–12**, then the report
   (§7). Each session starts by reading the progress file; Session B trusts it and does not
   re-verify Session A's work beyond running the gate once.

---

## 1. What Phase 4 builds

Diarization already separates the voices in a meeting and calls them "Speaker 1", "Speaker 2".
People rename them. Today that name is forgotten the moment the meeting ends: next week the same
voice is "Speaker 2" again.

**Remembered voices**: when the user names a speaker, the app keeps a small numeric *voiceprint*
of that voice on the phone. In the next meeting, after diarization, each new speaker's voiceprint
is compared with the people it knows; when one is clearly the same voice the app asks —
**"Sounds like Priya?"** — and one tap names the speaker. It never names anyone without asking.

**Worked example.** Monday: a meeting with two voices. On the Speakers screen the user types
"Priya" over "Speaker 1". A card appears once, ever: *Remember this voice?* — they choose *Turn
on*. Priya's voiceprint is saved on the phone. Thursday: a new meeting with Priya and someone
new. When processing finishes, the Summary tab shows a line *Sounds like Priya — confirm?*; on
the Speakers screen "Speaker 1" carries *Sounds like Priya?* with **Yes** / **No**. Yes renames
it and sharpens Priya's voiceprint with this meeting's voice. "Speaker 2", a stranger, gets no
suggestion. In Settings, *Remember voices* can be turned off, and *Forget all voices* deletes
every voiceprint.

**Consent is part of the feature.** A voiceprint is personal data and in some jurisdictions
biometric data (GDPR Art. 9, Illinois BIPA). So: the feature is **off by default**, it is
explained before it is turned on, everything stays on the phone (nothing in this app uploads
anything), and there is a one-tap way to delete all of it. The exact copy is in §2.9; use it
verbatim.

**Pro only.** Voiceprints are computed, stored and matched only for a paid or trial user with the
setting on. The Settings row is visible on free as "Remember voices (Pro)" and opens the paywall.

---

## 2. Decisions already taken — do not reopen

1. **Data.** Two added columns on `speakers` — `voice BLOB` (the voiceprint, `VecCodec.encode`
   of the unit vector; NULL when none) and `suggested_person TEXT` (a `people.id`; NULL when no
   suggestion is pending) — in `AudioDb.ADDED_COLUMNS` AND `src/db/schema.ts`'s `speakers`. One
   new table in `SCHEMA` (both mirrors, same DDL):
   ```sql
   CREATE TABLE IF NOT EXISTS people (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     voice BLOB NOT NULL,          -- VecCodec-encoded unit vector, the running centroid
     dim INTEGER NOT NULL,
     samples INTEGER NOT NULL,     -- how many speaker voices have been folded in
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   ```
   `people` is appended to `BackupManager.TABLES` (last; it references nothing). Nothing else
   changes shape.
2. **Settings keys** (the `settings` table, `AudioDb.getSetting/putSetting`, `db.getSetting/
   setSetting`): `voices_remember` = `"1"` on, anything else off (absent = off);
   `voices_prompted` = `"1"` once the one-time card has been shown.
3. **When the voiceprint is computed: inside the diarize stage, right after `db.assignSpeakers`**
   (`ProcessingEngine.kt` line ~276), because retention deletes the audio after narration. Only
   when `LicenceStore.entitled(ctx)` and `voices_remember == "1"`; otherwise the stage is exactly
   as today. `NativeBridge.nativeSpeakerVoices(pcmPath, segModel, embModel, sampleRate, tri)`
   (new JNI; `tri` is the same `[start,end,speaker,…]` array `nativeDiarize` returned) returns a
   `FloatArray` `[dim, row0…, row1…, …]`, one row per speaker index 0..max, a row of zeros where
   `speakerVoices` returned empty. `AudioDb.setSpeakerVoices(meetingId, dim, floats)` writes
   `voice = VecCodec.encode(row)` on the row `cluster_label = "S$cl"` and NULL for an all-zero
   row. Then `AudioDb.suggestPeople(meetingId)` (§4) writes `suggested_person`. Both inside one
   `try { … } catch (Throwable) { Log.w(TAG, "voices failed for $meetingId", e) }` — a failure
   costs the suggestion, never the meeting (mirror `suggestTemplate`'s hook).
4. **Remembering happens on rename.** `StorageModule.rememberVoice(speakerId, name)` (new
   `@ReactMethod`; add to `src/native/NativeStorage.ts` and to the `Storage` mock in
   `jest.setup.js`) → `AudioDb.rememberVoice(speakerId, name): String` returning
   `{"remembered":true}` or `{"remembered":false,"reason":"off"|"not_pro"|"no_voice"|"default_name"|"blank"}`.
   Rules, in this order: setting off → `off`; not entitled → `not_pro`; name blank after trim →
   `blank`; name matches `^Speaker \d+$` → `default_name`; the speaker row has no `voice` →
   `no_voice`. Else: find `people` by `name` (`COLLATE NOCASE`, trimmed); none → insert with
   the speaker's voice, `samples = 1`; found → `voice = normalise(old × samples + new)`,
   `samples + 1`, `updated_at = now`. Then `suggested_person = NULL` on that speaker. TS calls it
   from `SpeakersScreen`'s `onEndEditing` **after** `db.renameSpeaker` — and ignores a `false`.
5. **Answering a suggestion.** `StorageModule.answerSuggestion(speakerId, accept: Boolean)` →
   `AudioDb.answerSuggestion`: accept → `display_name` = the person's name, then the same fold as
   §2.4 (the person's centroid learns this meeting's voice), then `suggested_person = NULL`;
   dismiss → `suggested_person = NULL` only. Returns `{"name": <display_name now>}`. A reprocess
   re-runs diarization, which recreates unprotected speaker rows and so may suggest again — that
   is accepted and documented, not prevented.
6. **The screen, three places.** (a) `SpeakersScreen` row: when `item.suggestedPerson` is set
   (extend `db.speakers`'s SELECT and the `Speaker` type with `suggestedPerson: string | null`
   and `suggestedName: string | null` — the JOIN to `people.name` is done in the query), under
   the name input a line `Sounds like ${suggestedName}?` with two `SoftButton`s "Yes" and "No"
   (accessibility labels `Yes, this is ${name}` / `No, not ${name}`) → `db.answerSuggestion` →
   refresh the list. (b) `SummaryTab`: a new optional prop `voiceSuggestions?: string[]` (the
   suggested names, in speaker order) and `onConfirmVoices?: () => void`; when non-empty a banner
   in the same `Raised` style as the review banner, text from `voiceCopy.ts`'s
   `soundsLike(names)` — one name → `Sounds like Priya — confirm?`, two → `Sounds like Priya and
   Ravi — confirm?`, three or more → `Sounds like Priya, Ravi and 1 more — confirm?` (`N more`
   pluralised) — tap → `navigation.navigate('Speakers', { meetingId })` (the route exists).
   `MeetingScreen` fills it from the speakers it already loads. (c) `SettingsScreen`: a section
   headed "Voices" with the row "Remember voices" + a `Switch` bound to `voices_remember`, the
   explanation text of §2.9 under it, and a `SoftButton` "Forget all voices" that confirms with
   an `Alert` ("Forget all voices?" / "This deletes every stored voiceprint on this phone. Names
   already given to speakers stay." / *Cancel* / *Forget*) and calls `db.forgetVoices()`
   (`StorageModule.forgetVoices` → `DELETE FROM people; UPDATE speakers SET voice=NULL,
   suggested_person=NULL`). On free the row reads "Remember voices (Pro)", draws no `Switch`,
   and tapping it navigates to `'Paywall'`; the forget button is still shown (a lapsed user can
   still delete).
7. **The one-time card.** In `SpeakersScreen`, when a rename ends with a non-default, non-blank
   name and the user is paid and `voices_remember` is unset and `voices_prompted` is unset: an
   `Alert` with the §2.9 short copy, buttons *Not now* (sets `voices_prompted=1`) and *Turn on*
   (sets `voices_remember=1`, `voices_prompted=1`, then calls `rememberVoice` for this speaker —
   which will answer `no_voice` for this first meeting unless the setting was on when it was
   processed; that is expected and the copy says "from your next meeting"). Never shown twice.
8. **No automatic naming, no enrolment flow, no per-person screen.** A person exists only
   because a speaker was named with the setting on. There is no list of people in the UI in this
   phase; "Forget all voices" is the only management.
9. **Copy, verbatim.**
   - Settings explanation (under the switch): *When you name a speaker, Verbale keeps a small
     numeric voiceprint of that voice on this phone and uses it to suggest the name next time.
     Nothing is uploaded and nothing leaves the phone. A voiceprint is personal data — in some
     places biometric data — so turn this on only if you are comfortable holding it, and tell
     the people you record where the law or your workplace requires it. "Forget all voices"
     deletes every voiceprint at any time.*
   - The one-time card: title *Remember this voice?*; body *Verbale can keep a voiceprint of
     each speaker you name — on this phone only, never uploaded — and suggest the name from your
     next meeting. Voiceprints are personal, sometimes biometric, data: tell the people you record
     where the law requires it. You can forget all voices any time in Settings.*; buttons *Not
     now* / *Turn on*.
   - Speakers row: `Sounds like {name}?` · Yes · No. Summary banner: `soundsLike(names)` above.
     Settings: "Voices", "Remember voices", "Remember voices (Pro)", "Forget all voices".

---

## 3. Tasks and files

**3.1 The task list (this is the progress file's checklist)**

*Session A — native and data*
1. Schema: the two `speakers` columns and the `people` table in both mirrors; `BackupManager.TABLES`;
   the schema tests (§5.1). Commit.
2. `VecCodec` already has `decode`; `PeopleMatch.kt` (pure rule, §4) + `PeopleMatchTest` against
   `cpp/tests/golden/people_match.json`. Commit.
3. JNI `nativeSpeakerVoices` + `NativeBridge` extern (mirror `nativeDiarize`; construct a
   `Diarizer(seg, emb, sampleRate, 0)`, rebuild the `DiarSegment` list from `tri`, call
   `speakerVoices`, flatten with `dim` first). Place the JNI **after** the `jstr` helper
   definitions (they are mid-file). Commit.
4. `AudioDb.setSpeakerVoices`, `suggestPeople`, `rememberVoice`, `answerSuggestion`,
   `forgetVoices`, `peopleCount` (for the probe); the hook in `ProcessingEngine`'s diarize stage.
   Commit.
5. `StorageModule` methods `rememberVoice`, `answerSuggestion`, `forgetVoices` + `NativeStorage.ts`
   + the `jest.setup.js` stubs + `db.*` wrappers in `queries.ts`. Commit.
6. Device: `PeopleDbTest` (§5.5) via `device-verify.sh PeopleDbTest`; `NativePipelineTest`'s new
   seam test; extend `VerificationProbeTest` to print each speaker's `voice IS NOT NULL`,
   `suggested_person` and `SELECT count(*) FROM people`. Commit. **Update the progress file and
   stop.**

*Session B — screens, by hand, report*
7. `db.speakers` SELECT + `Speaker` type gain `suggestedPerson`/`suggestedName`; `voiceCopy.ts` +
   `voiceCopy.test.ts`. Commit.
8. `SpeakersScreen`: the suggestion line, Yes/No, the rename hook, the one-time card. Tests.
   Commit.
9. `SummaryTab` banner + `MeetingScreen` wiring. Tests. Commit.
10. `SettingsScreen` Voices section. Tests. Commit.
11. The gate; then `device-verify.sh PeopleDbTest` and `NativePipelineTest` once more on the
    phone (Session A's code plus yours). Commit anything that moved.
12. The by-hand run (§5.6), the report (§7), the plan/scorecard rows. Commit.

**3.2 Files**

Create: `android/.../pipeline/PeopleMatch.kt`; `android/app/src/test/.../pipeline/PeopleMatchTest.kt`;
`cpp/tests/golden/people_match.json`; `android/app/src/androidTest/.../PeopleDbTest.kt`;
`src/screens/voiceCopy.ts`; `src/screens/__tests__/voiceCopy.test.ts`;
`src/screens/__tests__/SpeakersScreen.test.tsx` and `SettingsScreen.test.tsx` (neither exists
today; `LibraryScreen.test.tsx` shows the render-and-mock shape); `docs/superpowers/reports/phase-4-progress.md`.

Modify: `AudioDb.kt` (schema mirror, the six functions — one `companion object` only),
`BackupManager.kt`, `SchemaTest.kt`, `src/db/schema.ts`, `src/db/__tests__/schema.test.ts`,
`cpp/jni/audionotes_jni.cpp`, `NativeBridge.kt`, `ProcessingEngine.kt`, `StorageModule.kt`,
`src/native/NativeStorage.ts`, `jest.setup.js`, `src/db/queries.ts`, `src/pipeline/types.ts`,
`src/screens/SpeakersScreen.tsx`, `SettingsScreen.tsx`, `MeetingScreen.tsx`,
`src/screens/meeting/SummaryTab.tsx` and its test, `NativePipelineTest.kt`,
`VerificationProbeTest.kt`, `scripts/device-verify.sh` (CLASSES).

---

## 4. The match rule (so the golden is unambiguous)

`PeopleMatch.suggest(voice: FloatArray, people: List<Person>): String?` where `Person(id, name,
voice: FloatArray)`; all vectors unit length; `cosine = dot`. Score every person; let `best` be
the highest and `second` the next highest (or −1 when there is one person). Suggest `best.id`
when `best.cos >= MATCH_COSINE` (**0.65**) and `best.cos - second.cos >= MATCH_MARGIN`
(**0.10**); else `null`. Ties are broken by insertion order (first wins), which is `ORDER BY
created_at` in the query that loads people. A speaker whose `display_name` is not the default
`^Speaker \d+$` is never suggested for (someone already named them). A speaker with no voice is
skipped.

**Why these numbers — measured 17 Sep on the real model** (CAM++ via sherpa, the same extractor
the phone runs; `cpp/tests/test_voices_live.cpp`, ground-truth turns of the AMI fixtures):

| | cosine |
|---|---|
| the same person, ES2002a vs ES2002b (four people, one from only 26 s of speech) | **0.785 · 0.798 · 0.849 · 0.884** |
| different people, the same room (12 pairs) | 0.086 – 0.404 |
| different people, other rooms (64 pairs) | −0.05 – 0.498 |

Nobody else reaches 0.50; the same voice never falls below 0.78. 0.65 sits in the gap with margin
on both sides; the 0.10 margin refuses a suggestion when two known people are both near (a rare
case the data did not contain, so it is a guard, not a measurement). The live test pins the bars
0.70 / 0.65 on every gate run; do not move the constants to make a case pass.

---

## 5. Definition of done — the tests

Every test must exist, pass, and have at least one recorded mutant that fails it.

**5.1 Schema** — `schema.test.ts`: `speakers` has `voice BLOB` and `suggested_person TEXT`,
nullable, no default; `people` has exactly the seven columns above with their types and
`name … UNIQUE COLLATE NOCASE`. `SchemaTest.kt`: the two `speakers` entries in `ADDED_COLUMNS`;
`people` in `SCHEMA` and NOT in `ADDED_COLUMNS` (`newTablesAreNotInAddedColumns` already pins
the second half); `BackupManager.TABLES` ends with `people`. *Mutants:* a column removed from one
mirror → that mirror's test fails; `people` moved into `ADDED_COLUMNS` → fails.

**5.2 Kotlin (unit)** — `PeopleMatchTest` against `people_match.json` (the golden's `note` carries
the two constants; cases give the speaker's cosine to each person by name): one person at 0.80 →
suggested; one at 0.60 → null; two at 0.80 and 0.75 → null (margin); two at 0.80 and 0.60 →
the first; two tied at 0.80 → the one listed first; a non-default `display_name` → null even at
0.95; no people → null. *Mutants:* `MATCH_COSINE = 0`; margin dropped; `>=` made `>` on the
cosine (a case at exactly 0.65 must suggest); default-name guard dropped.
`VecCodecTest` stays green.

**5.3 C++** — `test_voices_live` stays green through the gate (it is the measurement; if it
fails, the model or fixtures changed — report, do not retune).

**5.4 TypeScript** — `voiceCopy.test.ts`: `soundsLike` for one, two, three and five names
(singular/plural "more"). `SpeakersScreen.test.tsx`: a speaker with `suggestedName: 'Priya'`
renders "Sounds like Priya?" with Yes and No; Yes calls `db.answerSuggestion(id, true)` and
re-reads; No calls it with `false`; a speaker without a suggestion renders no such line; ending
a rename with "Priya" calls `db.renameSpeaker` then `db.rememberVoice(id, 'Priya')`; the
one-time card: with paid and both settings unset it appears once and *Turn on* writes both keys
and calls `rememberVoice`; with `voices_prompted='1'` it never appears; on free it never
appears. `SummaryTab.test.tsx`: `voiceSuggestions=['Priya']` renders the banner and tapping
calls `onConfirmVoices`; `[]` renders none. `SettingsScreen.test.tsx`: paid → the switch reflects
`voices_remember` and flipping it writes `'1'`/`'0'`; free → "Remember voices (Pro)", no switch,
tap navigates to `Paywall`; *Forget all voices* → Alert → *Forget* calls `db.forgetVoices`.
`MeetingScreen.test.tsx`: with two suggested speakers, `SummaryTab` receives both names in
speaker order. *Mutants:* Yes and No swapped; `rememberVoice` not called; the card shown on
free; the switch writing the wrong key; names out of order.

**5.5 Gate** — all six stages clear; paste the summary.

**5.6 Device (Pixel, `ANDROID_SERIAL=36091FDH30034G`)**
- `PeopleDbTest` (grant/restore the trial as `NativePipelineTest.grantTrial` does; set
  `voices_remember` to `"1"` for the test and restore it): create a meeting with two speaker rows
  (`assignSpeakers` with two clusters over two utterances); `setSpeakerVoices` with two hand-made
  unit vectors → `voice` set on both, NULL for an all-zero row; `rememberVoice(sp1, "Priya")` →
  a `people` row, `samples=1`; again with a second meeting's near-parallel vector → `samples=2`
  and the centroid still unit length; `rememberVoice` with `"Speaker 3"` → `default_name`; with
  the setting off → `off`; `suggestPeople` on a fresh meeting whose speaker vector is 5° from
  Priya's → `suggested_person` = Priya, and a speaker 60° away → NULL; `answerSuggestion(accept)`
  → `display_name = "Priya"`, `samples=3`, suggestion cleared; `forgetVoices` → `people` empty,
  every `voice` NULL. `BackupManagerTest`: extend the existing round-trip so a `people` row
  travels (read that test's shape first — it is the pattern).
- `NativePipelineTest`: a sibling of `diarization_runs_and_shares_the_onnx_runtime_with_vad`:
  diarize the jfk fixture, feed the `tri` array to `nativeSpeakerVoices`, assert `dim > 0`, one
  row per speaker, and the first non-zero row has length 1.0 ± 1e-3.
- By hand (record what you saw): start the trial; in Settings turn *Remember voices* on (read the
  explanation on the screen and quote it in the report); record meeting 1 through the mic with
  `say -v Samantha "…"` for forty seconds of one voice; when processed, on the Speakers screen
  rename "Speaker 1" to "Sam" (the one-time card must NOT appear — the setting is already on;
  then, to see the card, turn the setting off in Settings, clear `voices_prompted` with the probe
  or a fresh install's data, and rename again on a second meeting; report both). Record meeting 2
  with the same `say -v Samantha` voice → after processing the Summary tab shows *Sounds like
  Sam — confirm?* and the Speakers row shows *Sounds like Sam?*; tap Yes → the row reads "Sam".
  Record meeting 3 with `say -v Daniel` → no suggestion. Settings → *Forget all voices* → Forget;
  record meeting 4 with Samantha → no suggestion. On a free/lapsed account: Settings shows
  "Remember voices (Pro)" and opens the paywall.

---

## 6. Traps in this codebase (each has bitten a previous session)

- **JNI helpers `jstr`/`jstrArray`/`jlongVec` are defined mid-file**; a JNI function placed above
  them does not compile. Put `nativeSpeakerVoices` right after `nativeDiarize`.
- A `Diarizer` is constructed per JNI call and loads both models each time (a second or two);
  acceptable here, and it must be — do not try to cache it across calls.
- `AudioDb.kt` has exactly one `companion object`. `org.json`'s `optString` on SQL NULL returns
  `"null"` — use `isNull`. SQLite has no booleans: `voice IS NOT NULL AS hasVoice` is 0/1.
- **Speaker rows are deleted and recreated on reprocess** (`assignSpeakers`), except rows a person
  has spoken for (`SpeakerRepair.protectedIds`). A voice on a recreated row is recomputed; a
  suggestion may reappear. Keys: `cluster_label = "S<index>"`, `display_name = "Speaker N"`.
- **Retention deletes the audio after narration.** The voiceprint must be computed in the diarize
  stage, never later; `audioPath` there is the PCM the diarizer just read.
- `kEmbedMinMs` is 1 s and `kEmbedMaxMs` 30 s in the C++; the jfk fixture (11 s, one voice) is
  enough for one voiceprint. `dim` is whatever the model says (read it from the array, never hard
  code it).
- The custom font measures short: a row line with two buttons needs `flexShrink: 0` on the
  buttons; check the Speakers row on the phone.
- RN's `Alert` in jest: `jest.spyOn(Alert, 'alert')`, then take the buttons array from
  `mock.calls[0][2]` and call the wanted button's `onPress` — no existing test does this yet, so
  write it once in `SpeakersScreen.test.tsx` and reuse the shape in `SettingsScreen.test.tsx`.
- `jest.mock('../../db/queries')` auto-mocks every export: every new `db.*` needs a
  `mockResolvedValue` in each test file that renders a caller.
- The trial is spent after three narrations; the by-hand run needs four meetings — start the trial
  fresh, and start it again before meeting 4 if needed (`VerificationTrialTest`).
- Another session sometimes drives the same phone. Check focus; wait; report.

---

## 7. The report (Session B)

Write `docs/superpowers/reports/2026-MM-DD-phase-4-remembered-voices.md` with these sections, in
this order, nothing invented — if something was not run, say so:

1. **Status** — one line: done / done except (list).
2. **What was built** — files created and modified, one line each.
3. **Decisions taken** — from the progress file, with reasons.
4. **Tests** — a table: test file · test names · result · mutants tried · mutant result (must be
   "fails"), from the progress file's *Mutants* heading; the Kotlin XML counts, jest totals,
   C++ count, and the four same-person / maximum different-person cosines `test_voices_live`
   printed.
5. **Gate** — the stage summary lines.
6. **Device** — each §5.6 item with what the phone showed; the probe's lines for the by-hand
   meetings.
7. **For the founder to test by hand** — six to eight numbered steps, each with the exact thing
   to look for; include the consent card, one free-account step, and *Forget all voices*.
8. **Known gaps and cosmetic leftovers.**
9. **Commits** — hashes and subjects, oldest first, both sessions.

Then update `docs/superpowers/plans/2026-09-17-release-phases.md` (Phase 4 → "Done <date>",
Phase 5 → "Next"), the scorecard row "Persistent voice profiles" (or add it) → ✅, delete the
progress file (its content now lives in the report), and commit. Do not push.

---

## 8. Out of scope for Phase 4

Naming a speaker automatically without asking; an enrolment flow ("read this sentence");
a People screen, renaming or deleting one person (only forget-all); matching during recording or
in the PiP window; voiceprints for free users; syncing voices between phones (they travel in a
backup, which is enough); tuning `kSpeakerMergeThreshold` or anything inside the diarizer;
Hindi or any other language work; any change to how speakers are merged or split.
