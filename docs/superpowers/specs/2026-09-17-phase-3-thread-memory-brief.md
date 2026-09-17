# Phase 3 — Thread memory: decision history and preparation (the brief)

*17 September 2026. Written for the session that builds it. Sub-project 6b of the release plan
(`docs/superpowers/plans/2026-09-17-release-phases.md`), from the improvement report of 7 Sep
("Decision history — they can see how a decision changed"; "Meeting preparation — they can
revisit unfinished actions before recording again"). Founder's decisions of 17 Sep are in §2.
Everything you need to decide is decided; everything you need to build is listed; the tests in
§5 are the definition of done.*

---

## 0. How to work in this repository (read before anything else)

1. **Read first, in this order:** this brief; `docs/superpowers/plans/2026-09-17-release-phases.md`;
   `docs/superpowers/reports/2026-09-17-phase-2-meeting-templates.md` (the previous phase's
   report — §10 shows what a review looks for); `src/screens/ActionsScreen.tsx` and
   `src/screens/actionsData.ts` (the cross-meeting worklist this phase filters by tag);
   `src/screens/LibraryScreen.tsx` lines 640–680 (the tag chips and the Search/Actions buttons);
   `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt` lines 83–160
   (`searchJson`, `keywordHits`, `meaningHits` — how vectors are read and scored);
   `android/app/src/main/java/com/innocorelabs/verbale/pipeline/VecCodec.kt`;
   `android/app/src/main/java/com/innocorelabs/verbale/pipeline/Asker.kt` lines 25–50 (the
   Pro refusal shape); `src/screens/AskScreen.tsx` lines 70–95 (how a refusal becomes the
   paywall). Do not read the whole repository — these are enough.
2. **Test-driven, every step.** Write the failing test, run it and watch it fail, write the
   smallest code that passes, run it green, then **mutation-check it**: break the implementation
   on purpose in one plausible way (flip a condition, drop a branch, return a constant), watch the
   test FAIL, restore, run green again. A test that survives its mutant is not finished. Do this
   in the foreground; never run a restore in the background. Record every mutant and its result
   in the report.
3. **Judge what the phone shows, not what the code returns.** Phase 2's one defect was a test
   whose fixture could not provoke the failure: the model wrote section names on their own line
   and the phone's cleaner dropped them, while the device test's discussion-shaped fixture never
   did. For every list this phase renders, write one test whose fixture is the *awkward* case
   (an item ticked in one meeting, a decision with no vector, a meeting with two tags, a tag on
   an archived meeting) and assert the rendered text.
4. **Commands you will use** (from the repo root):
   - Kotlin unit tests: `cd android && ./gradlew :app:testDebugUnitTest --tests '*NameTest*'`
     then read `app/build/test-results/testDebugUnitTest/TEST-*.xml` — "BUILD SUCCESSFUL" alone
     is not proof a test ran; check `tests="N" failures="0"`, and add `--rerun` if the time is
     0.000 (Gradle served it from cache).
   - jest: `npx jest src/path/to/file.test.tsx --forceExit`.
   - TypeScript: `npx tsc --noEmit`. Lint: `npx eslint <files>`.
   - C++ (Mac): `CMAKE=$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake; $CMAKE --build
     cpp/cli/build -j 8 && (cd cpp/cli/build && $(dirname $CMAKE)/ctest --output-on-failure)`.
     C++ tests use a `CHECK` macro, never `assert` (Release build compiles asserts away). The
     live-model tests skip themselves without `VERBALE_EMBED_GGUF` / `VERBALE_LLM_GGUF`; the gate
     exports both (`scripts/gate.sh` lines 21–24), so run them through the gate or export the
     same paths.
   - The gate, before every commit that touches more than one layer:
     `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh` — must end
     "gate: all clear".
   - Device: `export ANDROID_SERIAL=36091FDH30034G` (the Pixel 7 Pro; an emulator is often
     attached too), then `scripts/device-verify.sh <ClassNameSubstring>`. It builds, installs both
     APKs (keeping app data) and runs the class. A new androidTest class must be added to the
     `CLASSES` list in that script or it never runs. Pro features need the trial:
     `adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationTrialTest
     com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner` starts a fresh one
     (3 narrations; "Write it again" counts). `VerificationProbeTest` (same command shape) prints
     the newest meetings' rows to logcat as `PROBE …` — read results without touching the screen;
     extend its SELECTs when you need to see more (it is a verification tool). The debug build
     needs Metro: `npx react-native start` and `adb reverse tcp:8081 tcp:8081`.
   - Before driving the screen: `adb shell dumpsys window | grep mCurrentFocus`. Another
     session sometimes drives the same phone; if Verbale is not focused and you did not put
     another app there, wait, and say so in the report rather than pushing through.
5. **Commit after every green task** with a message that says what changed and why (the
   commit history shows the house style). Never push; the founder pushes `main`. Never run
   `connectedDebugAndroidTest` (it uninstalls the app and wipes the models and the database).
6. **Decisions.** The design below is decided. If something is genuinely unspecified, choose the
   simplest option that keeps every listed test meaningful, and record the choice in the report's
   "Decisions taken" section. Do not widen the scope: no features not listed here, and nothing
   generated by the language model.
7. **When you are done** — every test in §5 exists and passes, the gate is clear, the device
   run in §5.6 is done — write the report (§7) and stop. If a device step cannot run, say so in
   the report; do not mark it done.

---

## 1. What Phase 3 builds

Today every meeting is an island. To know what was left unfinished last week, a person opens
last week's meeting and scrolls. This phase makes the app remember across the meetings that
belong together.

**A thread is the meetings that share a tag.** Tags already exist (`tags` table, the chip row in
the library, the tag editor on a meeting). A meeting with two tags is in two threads. Nothing
new is stored: a thread is a query.

**The thread screen** (Pro) shows, for one tag:

1. **Still open** — the action items from every meeting in the thread that nobody has ticked
   off, newest meeting first, each with its owner and due date when known and the meeting it
   came from. This is the "preparation" item: what to chase before recording the next one.
2. **Decisions so far** — the decision items from every meeting in the thread, oldest first,
   and when a later decision is the same decision changed ("we ship Monday" → "shipping moved
   to Thursday"), the later one says *changes: …* and names the earlier one. This is "decision
   history".
3. **Meetings** — the thread's meetings, newest first, tap to open.

**Two doors into it**, both Pro: an "Open thread" button in the library's filter row when a tag
chip is selected, and one line under the summary card on a tagged meeting's Summary tab
("weekly: 2 open · 3 decisions"). On free both doors carry "(Pro)" and open the paywall, the way
the library's Search button already does. Free keeps tagging and tag filtering exactly as today.

**Worked example.** Tag `ops-weekly`. 3 Sep: decided "vendor codes will be six digits"; action
"Ravi to check with finance about reissuing purchase orders (by Friday)". 10 Sep: decided
"existing vendors keep their old codes"; action "Priya to draft the mapping table (by
tomorrow)". Before the 17 Sep meeting the thread screen reads:

> **Still open** — Priya: draft the mapping table · due 11 Sep · *Ops weekly, 10 Sep*
> **Decisions so far** — Vendor codes will be six digits · *3 Sep* — Existing vendors keep their
> old codes · *10 Sep* · changes: "Vendor codes will be six digits" (3 Sep)
> **Meetings** — Ops weekly · 10 Sep — Ops weekly · 3 Sep

Nothing here is written by the language model. Every line is a row the app already holds, and
the one clever part — "changes: …" — is a rule over the vectors the meaning search already
computes (§4).

---

## 2. Decisions already taken — do not reopen

1. **Thread = tag.** No person-threads (remembered voices are Phase 4); no automatic threads;
   no thread table. The screen takes a tag name and queries.
2. **Pro only, the founder's word (17 Sep): "free can tag the meetings; we do not give them
   search or the to-do list, otherwise why buy Pro."** The thread screen, both doors and the
   native query are gated on `LicenceStore.entitled(ctx)` (Kotlin) and `entitlement().paid`
   (TS). Free sees the doors labelled "(Pro)" and lands on the paywall (`navigation.navigate('Paywall')`
   — its params are optional, see `RootNavigator.tsx` line 49), never the data.
   **The same word makes the cross-meeting Actions worklist Pro.** Today `ActionsScreen` is
   free (`LibraryScreen.tsx` line 651 and the outstanding card near line 727 navigate to it
   unconditionally). Change: the header button reads "Actions (Pro)" on free and navigates to
   `'Paywall'`; the outstanding-count card is not drawn on free; `ActionsScreen` itself, like
   `AskScreen`, sends a free user to the paywall on mount. The meeting's own Actions tab (one
   meeting, inside `MeetingScreen`) stays free — that is the meeting's own notes, not memory
   across meetings. *This is the one decision here the founder did not spell out to the letter;
   it is recorded in the review notes as the consistent reading of "no to-do list on free". If
   the founder overrules it, delete this paragraph and the tests in §5.4 that mention Actions.*
3. **One native query, one JSON.** `StorageModule.thread(tag)` (a new `@ReactMethod` on the
   existing legacy module in `pipeline/StorageModule.kt`; add the line to the TS spec in
   `src/native/NativeStorage.ts` and the stub in `jest.setup.js`'s `Storage` mock) returns
   either `{"refusal":"NOT_PRO"}` or
   `{"tag":…, "meetings":[…], "open":[…], "decisions":[…]}` built by
   `AudioDb.threadJson(ctx, tag)`. Both lists are SQL in Kotlin (the device test in §5.6 runs
   the real SQL against real rows, which the TS layer cannot); the link rule is Kotlin too, next
   to `VecCodec`. TS only renders. The shapes:
   - `meetings`: `{id, title, createdAt, template}` — every meeting with the tag whose
     `archived_at IS NULL`, newest first.
   - `open`: `{itemId, meetingId, meetingTitle, meetingAt, content, itemType, status, dateNorm}`
     — `items` rows with `kind='action'`, `review <> 'rejected'`, in a thread meeting, with no
     `item_done` row (`LEFT JOIN item_done d ON d.meeting_id=i.meeting_id AND d.item_id=i.id
     WHERE d.item_id IS NULL`), ordered by meeting `created_at DESC, anchor_start_ms ASC`. Hand-typed
     items (`gen_version = 'user'`) are included; they are the person's own. `content` carries
     the " — Owner (due …)" suffix the rule pass writes; TS splits it with the existing
     `splitAction` (`src/screens/meeting/shared.tsx` line 422) and adds the typed-record labels
     with `labelsFor` (`src/screens/meeting/recordLabels.ts`) when `itemType` is set.
   - `decisions`: `{itemId, meetingId, meetingTitle, meetingAt, content, itemType, status,
     changes: {itemId, content, meetingAt} | null}` — `items` rows with `kind='decision'`,
     `review <> 'rejected'`, in a thread meeting, ordered by meeting `created_at ASC,
     anchor_start_ms ASC`; `changes` set by the rule in §4, at most one per decision, always an
     earlier meeting's decision. A decision with no vector in `search_vec` (free, model absent,
     backfill not reached) simply has `changes: null`; no error, no note.
4. **Threads read, never write.** No schema change, no new table, no new column, no settings
   key. Ticking an action stays where it is (the Actions tab / worklist); the thread screen shows
   the current state each time it is focused (`useFocusEffect`, as `ActionsScreen.tsx` line 95).
5. **The screen:** `src/screens/ThreadScreen.tsx`, route `Thread: { tag: string }` in
   `RootNavigator.tsx` (`headerShown: false`, like the rest; the screen draws its own header the
   way `ActionsScreen` does). Header: the tag name and "N meetings". Then the three sections of
   §1 with `SectionHead` from `src/screens/meeting/shared.tsx`. Rows: an open action shows the
   text, then a dim line "Owner · due Day · Meeting title, Day"; a decision shows the text, a
   dim "Meeting title, Day", and when `changes` is set a third line `changes: "<earlier text>"
   (Day)`; a meeting row is title and Day. Tapping an action or a decision opens its meeting
   (`navigation.navigate('Meeting', { meetingId })`); tapping a meeting row does the same. Empty
   states, one line each: "Nothing open in this thread." / "No decisions yet." Day labels use
   `dayLabel` from `src/pipeline/dateNorm.ts`. On mount the screen calls `db.thread(tag)`; a
   `NOT_PRO` refusal navigates to `'Paywall'` and renders nothing else (mirror `AskScreen.tsx`
   line 82).
6. **The doors.** (a) `LibraryScreen`: when `tag !== null` (the store's selected chip), an
   `IconButton` (icon `list`) at the end of the filter row, label "Open thread" on paid, "Open
   thread (Pro)" on free; paid → `navigate('Thread', { tag })`, free → `navigate('Paywall')`. The
   library already holds `paid` (line 351). (b) `SummaryTab`: a new optional prop
   `threads?: { tag: string; open: number; decisions: number }[]` and `onOpenThread?: (tag:
   string) => void`; when paid (the tab already resolves `ent.paid` in its effect — Phase 2 stored
   it as `templateWritable`; reuse that state, rename it `paid` if you like, one place) and the
   list is non-empty, one `Pressable` line per entry under the summary card, at most three, text
   `${tag}: ${open} open · ${decisions} decisions` with singulars ("1 open", "1 decision"),
   accessibility label `Open thread ${tag}`. On free nothing is drawn — not even a "(Pro)" line;
   the library door is the nudge. `MeetingScreen` fills `threads` by calling `db.thread(t)` for
   each of the meeting's tags (alphabetical, first three) after `refresh`, counting `open` and
   `decisions` **excluding this meeting's own rows** (the line says what is *earlier*), and
   skipping a tag whose thread has no other meeting. A `NOT_PRO` refusal → `threads = []`.
7. **Kotlin gate first, JS gate second.** `AudioDb.threadJson` returns the refusal when
   `!LicenceStore.entitled(ctx)` before touching a table. The TS screens also check
   `entitlement().paid` so a free user never reaches the screen; the Kotlin check is what the
   device test pins.
8. **Labels and copy are fixed here:** "Open thread", "Open thread (Pro)", "Still open",
   "Decisions so far", "Meetings", "changes:", "Nothing open in this thread.", "No decisions
   yet.", "Actions (Pro)". Do not restyle existing components.

---

## 3. Files

**Create**
- `android/app/src/main/java/com/innocorelabs/verbale/pipeline/DecisionLinks.kt` — the pure link
  rule of §4: `data class Decision(val itemId: String, val meetingId: String, val meetingAt:
  Long, val text: String, val vec: FloatArray?)`, `fun link(decisions: List<Decision>): Map<String,
  String>` (later itemId → earlier itemId), constants `LINK_COSINE`, `LINK_COSINE_WITH_WORD`,
  `MIN_WORD_LETTERS`, `STEM_LETTERS`, `STOP_WORDS`, and `fun sharedContentWord(a: String, b:
  String): Boolean`.
- `android/app/src/test/java/com/innocorelabs/verbale/pipeline/DecisionLinksTest.kt` and
  `VecCodecTest.kt`; `cpp/tests/golden/decision_links.json`.
- `android/app/src/androidTest/java/com/innocorelabs/verbale/ThreadsDbTest.kt` (+ the CLASSES
  line in `scripts/device-verify.sh`).
- `src/screens/ThreadScreen.tsx`; `src/screens/threadData.ts` (pure: `threadLine(tag, open,
  decisions)`, `countsExcluding(meetingId, thread)`); `src/screens/__tests__/ThreadScreen.test.tsx`,
  `src/screens/__tests__/threadData.test.ts`.

**Modify**
- `android/.../pipeline/VecCodec.kt` — `fun decode(blob: ByteArray): FloatArray` (scale × int8;
  the inverse of `encode`, same little-endian layout) so two stored vectors can be compared.
- `android/.../data/AudioDb.kt` — `threadJson(ctx, tag)` (the refusal, the three SELECTs, the
  vectors for the decision item ids from `search_vec WHERE kind='item' AND ref_id IN (…)`,
  `DecisionLinks.link`, the JSON). One `companion object` only — add nothing new at that level.
- `android/.../pipeline/StorageModule.kt` — `@ReactMethod fun thread(tag: String, promise:
  Promise)` mirroring `search` at line 211.
- `src/native/NativeStorage.ts` — `thread(tag: string): Promise<string>;` with a comment.
- `jest.setup.js` — `thread: jest.fn(async () => '{"refusal":"NOT_PRO"}')` in the `Storage` mock
  (a safe default: a screen that forgets to mock it sees the paywall, not data).
- `src/db/queries.ts` — `thread: (tag) => Storage.thread(tag).then(JSON.parse)` typed as
  `ThreadResult` in `src/pipeline/types.ts` (add the interfaces of §2.3 there).
- `src/navigation/RootNavigator.tsx` — the `Thread` route and screen.
- `src/screens/LibraryScreen.tsx` — the "Open thread" door; "Actions (Pro)" and the card (§2.2).
- `src/screens/ActionsScreen.tsx` — the paywall on mount for free (§2.2).
- `src/screens/meeting/SummaryTab.tsx`, `src/screens/MeetingScreen.tsx` — the thread line (§2.6).
- `src/screens/__tests__/LibraryScreen.test.tsx`, `ActionsScreen.test.tsx`,
  `MeetingScreen.test.tsx`, `src/screens/meeting/__tests__/SummaryTab.test.tsx` — the new cases
  of §5.4 and the new `db.thread` mock where a screen calls it (`jest.mock('../../db/queries')`
  auto-mocks every export with no factory; a new export needs a `mockResolvedValue` in each test
  file that renders a caller, or the call resolves `undefined` and the screen throws).
- `cpp/tests/test_embed.cpp` — the measured pairs of §4 (live; skips without the model).
- `android/.../VerificationProbeTest.kt` — print the tags of each meeting (`SELECT name FROM
  tags WHERE meeting_id=?`) and, for the newest tag, `AudioDb.threadJson` — so the thread can be
  read over adb without the screen.

---

## 4. The link rule (so the golden is unambiguous)

Vectors: `search_vec` rows with `kind='item'` and `ref_id` = the item id, written by
`Embedder.fill` after narration (Pro, with the bge-small model). Decode with `VecCodec.decode`;
both are unit vectors, so `dot` is the cosine.

For each decision D (in `meetingAt` order), the candidates are decisions E with `E.meetingAt <
D.meetingAt` (an earlier **meeting** — never the same meeting; a contradiction inside one meeting
is already the typed record's `status='contradicted'`) and both vectors present. Score each
candidate `c = cosine(D.vec, E.vec)`. E qualifies when

- `c >= LINK_COSINE` (**0.72**), or
- `c >= LINK_COSINE_WITH_WORD` (**0.60**) and `sharedContentWord(D.text, E.text)`.

`sharedContentWord`: lower-case both; split on non-letters; keep tokens of at least
`MIN_WORD_LETTERS` (**4**) letters not in `STOP_WORDS` (`will, that, this, with, from, have, been,
were, they, them, then, than, what, when, which, there, their, about, would, could, should,
next, week, today, tomorrow, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
decided, agreed, agree, decide`); compare on the first `STEM_LETTERS` (**5**) letters, so
`ship`/`shipping` and `vendor`/`vendors` match and `monday`/`thursday` never count. The best
`c` among qualifying candidates wins; at most one link per D; a D with no qualifying candidate
has none.

**Why these numbers — measured 17 Sep on the real model** (`bge-small-en-v1.5-q8_0`, the pairs
`test_embed` must pin, §5.2):

| cosine | pair | should link? |
|---|---|---|
| 0.876 | "The proposal goes out Friday." ↔ "The proposal will be sent next week instead of Friday." | yes (cosine alone) |
| 0.824 | "We will use Postgres for the new service." ↔ "We decided to switch the new service from Postgres to SQLite." | yes (cosine alone) |
| 0.696 | "We will ship on Monday." ↔ "Shipping moved to Thursday because QA is not done." | yes (0.60 + shared *ship*) |
| 0.747 | "Existing vendors keep their old codes." ↔ "We will not migrate the old codes." | yes (cosine alone) |
| 0.646 | "Shipping moved to Thursday because QA is not done." ↔ "The proposal will be sent next week instead of Friday." | **no** (no shared word) |
| 0.623 | "We will ship on Monday." ↔ "The proposal goes out Friday." | **no** |
| 0.607 | "The proposal goes out Friday." ↔ "Lunch will be at one." | **no** |
| 0.525 | "We will ship on Monday." ↔ "We agreed to hire two more testers." | **no** |

Unrelated decisions score 0.50–0.65 on this model; the same decision changed scores 0.70–0.88
except when the wording changes entirely, which is what the shared-word clause is for. Do not
retune the constants to make a golden case pass — change the case or report the case.

---

## 5. Definition of done — the tests

Every test below must exist, pass, and have at least one recorded mutant that fails it.

**5.1 Kotlin (unit)**
- `DecisionLinksTest` against `decision_links.json` (the golden carries the constants in its
  `note` and cases with **injected cosines**: each case lists decisions with `meetingAt`, `text`
  and a `cos` matrix, and the expected `links` map). Cases, at least: cosine 0.80 links; 0.55
  never links even with a shared word; 0.65 with shared word links; 0.65 without one does not; a
  candidate in the same meeting is ignored even at 0.95; a candidate in a *later* meeting is
  ignored; two qualifying candidates → the higher cosine wins; a decision with `vec == null` gets
  no link and blocks none; stop-words do not count as shared ("will", "next", "monday");
  `ship`/`shipping` count as shared. *Mutants:* `LINK_COSINE = 0`; the word clause dropped; the
  `E.meetingAt < D.meetingAt` test made `<=`; "first qualifying" instead of "best".
- `VecCodecTest`: `decode(encode(v))` is within `scale` of `v` element-wise and
  `dot(q, encode(v))` equals the plain dot of `q` and `decode(encode(v))` within 1e-3. *Mutant:*
  wrong byte offset in `decode`.
- Every existing test stays green (`./gradlew :app:testDebugUnitTest`).

**5.2 C++**
- `test_embed`: extend with the eight pairs of §4 — the four "yes" pairs ≥ 0.69, the four "no"
  pairs ≤ 0.66, on the real model (the test already skips without `VERBALE_EMBED_GGUF`). Print
  each cosine. *Mutant:* swap a "yes" and a "no" sentence → fails.

**5.3 TypeScript (pure)**
- `threadData.test.ts`: `threadLine('weekly', 2, 3)` → "weekly: 2 open · 3 decisions";
  singulars; `countsExcluding` drops this meeting's own rows from both counts and returns null
  when the thread has no other meeting. *Mutants:* plural always; own rows counted.

**5.4 TypeScript (screens)**
- `ThreadScreen.test.tsx`: with `db.thread` resolving a fixture of two meetings, two open
  actions (one from each) and three decisions (the third `changes` the first): the three
  section heads render; the open rows show owner and due (from a content with the " — Priya
  (due tomorrow)" suffix) and the meeting title; the decision rows are oldest first and the third
  shows `changes: "…"`; tapping a row navigates to `Meeting` with its id; with an empty
  fixture both empty-state lines render; with `{"refusal":"NOT_PRO"}` it navigates to `Paywall`
  and renders no section head. *Mutants:* decisions newest first; `changes` line drawn for every
  decision; the refusal ignored.
- `LibraryScreen.test.tsx`: no "Open thread" without a selected tag; with a tag selected and
  paid it appears and navigates to `Thread` with that tag; on free (flip `Licence.status` from
  `jest.setup.js` to `paid: false`, or mock `entitlement` as `SummaryTab.test.tsx` does) it reads
  "Open thread (Pro)" and navigates to `Paywall`; the Actions header button reads "Actions (Pro)"
  and navigates to `Paywall` on free, and the outstanding card is not drawn on free (the three
  existing "front door" tests keep passing on paid). *Mutants:* the Pro gate inverted; the card
  drawn on free.
- `ActionsScreen.test.tsx`: on free the screen navigates to `Paywall` on mount. *Mutant:* gate
  dropped.
- `SummaryTab.test.tsx`: with `threads=[{tag:'weekly', open:2, decisions:3}]` and paid, the line
  "weekly: 2 open · 3 decisions" renders and tapping it calls `onOpenThread('weekly')`; on free
  it does not render; with `threads=[]` it does not render; four entries render three.
  *Mutants:* drawn on free; the wrong tag passed.
- `MeetingScreen.test.tsx`: with `db.tagsFor` → `['weekly']` and `db.thread` → a fixture whose
  rows include this meeting's own decision, `SummaryTab` receives `threads` with that decision
  excluded from the count; with `db.thread` → `NOT_PRO`, it receives `[]`. *Mutant:* own rows
  counted.

**5.5 Gate** — `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh` → "all
clear". Paste the stage summary into the report.

**5.6 Device (Pixel, `ANDROID_SERIAL=36091FDH30034G`)**
- `ThreadsDbTest` (write it; add to CLASSES; grant the trial the way `NativePipelineTest.grantTrial`
  does and restore it in `@After`): insert three meetings tagged `ops` (created 3, 10, 17 Sep)
  and one untagged; give each an action item and a decision item through the real
  `AudioDb.replaceItems`; tick one action with `item_done`; reject one with `review='rejected'`;
  store vectors for the decisions with `VecCodec.encode` of hand-made unit vectors (two nearly
  parallel for the 3 Sep / 10 Sep decisions, one orthogonal for 17 Sep). Then `threadJson(ctx,
  "ops")`: `meetings` is the three tagged ones newest first; `open` excludes the ticked, the
  rejected and the untagged meeting's action, newest meeting first; `decisions` is oldest first,
  the 10 Sep one `changes` the 3 Sep one, the 17 Sep one changes nothing; an archived tagged
  meeting (`archived_at` set) is excluded from all three lists. With the trial keys written off
  (`trial_ended_at` > 0 and no licence, see `Trial.kt` line 56) the result is the `NOT_PRO`
  refusal — restore the keys after.
- `NativePipelineTest` stays 16/16 (run it; the thread code shares `AudioDb`).
- By hand (record in the report with what you saw): start the trial; record three short
  meetings through the mic (`say` on the Mac): (1) "We decided we will ship on Monday. Ravi will
  send the proposal by Friday." (2) "Shipping moved to Thursday because QA is not done. Priya
  will draft the mapping table tomorrow." (3) "We agreed to hire two more testers." Tag all three
  `ops` (the tag editor on the meeting). Tick Ravi's action on meeting 1. Select the `ops` chip
  in the library → "Open thread" → the screen shows: *Still open* Priya's action only, from
  meeting 2; *Decisions so far* three, oldest first, with meeting 2's saying `changes: "…ship on
  Monday"` and meeting 3's saying nothing; *Meetings* three. Open meeting 3's Summary tab: the
  line reads "ops: 1 open · 2 decisions" (its own decision excluded); tap it → the thread. End
  the trial (write `trial_ended_at`, as the device test does, or a `VerificationTrialEndTest`
  you add beside `VerificationTrialTest`) → the chip's button reads "Open thread (Pro)" and opens
  the paywall; the Actions header button reads "Actions (Pro)"; meeting 3's Summary tab shows no
  thread line. Restore the trial afterwards.

---

## 6. Traps in this codebase (each has bitten a previous session)

- **Judge what the phone shows** (§0.3). A list that is right in JSON and wrong on screen is
  wrong.
- `AudioDb.kt` has exactly **one** `companion object`; add to it, do not add another. JNI is not
  involved in this phase — everything native here is Kotlin.
- `StorageModule` is a legacy `ReactContextBaseJavaModule` (interop), so a new method is one
  `@ReactMethod` plus one line in the TS spec; there is no generated abstract class to satisfy.
  `TurboModuleRegistry.getEnforcing` will still throw at runtime if the spec and the Kotlin
  name differ by a letter.
- **org.json:** `optString` on a SQL NULL returns the string `"null"`; use `isNull`/`opt`.
- **SQLite booleans** come back as 0/1 through `rawQueryJson`; `d.item_id IS NULL` in a WHERE is
  fine, `AS done` in a SELECT is a number.
- **Item text carries its suffix**: `content` is "Draft the mapping table — Priya (due
  tomorrow)"; split with `splitAction`, never by hand, and never store a split version.
- **Item ids are stable across reprocessing** (the Reconciler carries them); `item_done` keys on
  them. `search_vec.ref_id` for `kind='item'` is that same id.
- **A decision may have no vector**: free tier, model not downloaded, or the sweep's
  `backfillEmbeddings(3)` has not reached the meeting yet. `changes: null`, silently.
- **Tags are normalised on write** (`normaliseTag` in `queries.ts`); the thread key is the
  stored `name`, compared with `=`, not `LIKE`.
- `Paywall` route params are optional; `navigate('Paywall')` from the library is the existing
  form.
- RN's `Modal` renders nothing in jest when hidden; the custom font measures short, so give a
  chip or a line `flexShrink: 0` and check it on the phone, not only in jest.
- `jest.mock('../../db/queries')` auto-mocks every export: a new `db.thread` resolves
  `undefined` in a test that does not set it — set it in every test file that renders a caller.
- The trial is spent after three narrations ("Write it again" counts); the by-hand run needs
  three recordings, so start it fresh and do not narrate anything else first.
- Another session sometimes drives the same phone (YouTube, Folio have appeared unprompted).
  Check focus; wait; report.

---

## 7. The report

Write `docs/superpowers/reports/2026-MM-DD-phase-3-thread-memory.md` with these sections, in
this order, and nothing invented — if something was not run, say so:

1. **Status** — one line: done / done except (list).
2. **What was built** — files created and modified, one line each.
3. **Decisions taken** — anything this brief left open and what you chose, with the reason.
4. **Tests** — a table: test file · test names · result · mutants tried (what you changed) ·
   mutant result (must be "fails"). Include the Kotlin XML counts, the jest totals and the C++
   count, and the eight measured cosines from `test_embed`.
5. **Gate** — the stage summary lines from the run.
6. **Device** — each §5.6 item with what the phone showed, and the thread JSON for the by-hand
   thread as `VerificationProbeTest` printed it.
7. **For the founder to test by hand** — five to eight numbered steps on the phone, each with
   the exact thing to look for, so a person can confirm the phase without reading code. Include
   one step on a free account.
8. **Known gaps and cosmetic leftovers.**
9. **Commits** — the hashes and subjects, oldest first.

Then update `docs/superpowers/plans/2026-09-17-release-phases.md` (Phase 3 → "Done <date>",
Phase 4 → "Next"), update the two rows in
`docs/superpowers/specs/2026-09-15-improvement-report-scorecard.md` ("Decision history" and
"Meeting preparation" → ✅ with the date), and commit. Do not push.

---

## 8. Out of scope for Phase 3

Person-threads and anything about voices (Phase 4); any text written by the language model (a
"prep brief" paragraph was considered and dropped — the lists are exact and the paragraph would
not be); editing or dismissing a decision; a "resolved" state for decisions; notifications or a
prompt on the Record screen before a meeting; exporting a thread; forgetting a tag's remembered
template (Phase 2's tag memory) — untouched; a thread across *all* meetings (no tag = no
thread); pagination (a thread is dozens of rows, not thousands).
