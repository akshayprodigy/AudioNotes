# Phase 3 — Thread memory: decision history and preparation (the report)

*17 September 2026. Against `docs/superpowers/specs/2026-09-17-phase-3-thread-memory-brief.md`.*

## 1. Status

**Done, except** the §5.6 by-hand pass: the Pixel 7 Pro was not connected to this machine during
this session (only an emulator was attached; the phone came online partway through and was then
in someone else's active use — YouTube in the foreground, not launched by this session — so it was
left alone rather than driven, per the brief's own house rule). Every automated test in §5.1–§5.4,
the gate, and both automated device suites in §5.6 (`ThreadsDbTest`, `NativePipelineTest`) are done
and green. §7 below gives the founder the exact steps to run the by-hand pass themselves.

## 2. What was built

**Created**
- `android/.../pipeline/DecisionLinks.kt` — the pure "changes: …" link rule; `DecisionLinksTest.kt`
  against a new golden with injected cosines; `VecCodecTest.kt`.
- `cpp/tests/golden/decision_links.json`.
- `android/.../ThreadsDbTest.kt` (androidTest), added to `scripts/device-verify.sh`'s `CLASSES`.
- `src/screens/ThreadScreen.tsx`, `src/screens/threadData.ts`, plus
  `src/screens/__tests__/ThreadScreen.test.tsx` and `threadData.test.ts`.

**Modified**
- `android/.../pipeline/VecCodec.kt` — `decode`, the inverse of `encode`.
- `android/.../data/AudioDb.kt` — `threadJson(ctx, tag)`: the Pro refusal before any table is
  touched, the meetings/open/decisions SELECTs, the decision vectors, `DecisionLinks.link`, the
  JSON.
- `android/.../pipeline/StorageModule.kt` — `thread` `@ReactMethod`, mirroring `search`.
- `android/.../VerificationProbeTest.kt` — prints each meeting's tags and, for the newest tagged
  one, its full `threadJson`.
- `cpp/tests/test_embed.cpp` — the brief's eight measured pairs on the real bge-small model.
- `src/native/NativeStorage.ts`, `jest.setup.js` — the `thread` spec and its safe `NOT_PRO` mock
  default.
- `src/pipeline/types.ts` — `ThreadMeeting`, `ThreadOpenItem`, `ThreadDecisionChange`,
  `ThreadDecision`, `ThreadResult`.
- `src/db/queries.ts` — `db.thread`.
- `src/navigation/RootNavigator.tsx` — the `Thread` route.
- `src/screens/LibraryScreen.tsx` — the "Open thread" door in the filter row; "Actions (Pro)" and
  the outstanding-actions card gated on `paid`.
- `src/screens/ActionsScreen.tsx` — a free user is sent to the paywall on mount.
- `src/screens/meeting/SummaryTab.tsx` — the thread line(s) under the summary card;
  `templateWritable` renamed `paid` and reused for the same gate.
- `src/screens/MeetingScreen.tsx` — resolves `threads` for the meeting's own tags (first three,
  alphabetical) via `db.thread` + `countsExcluding`.
- The matching test files for every screen above:
  `LibraryScreen.test.tsx`, `ActionsScreen.test.tsx`, `SummaryTab.test.tsx`,
  `MeetingScreen.test.tsx`.

## 3. Decisions taken

1. **`DecisionLinks.link` takes an optional second parameter, `cosineOf`.** The brief's literal
   signature is `link(decisions: List<Decision>): Map<String, String>`, and that overload still
   exists and is what `AudioDb.threadJson` calls — it scores real decoded vectors with a plain dot
   product. But §5.1's golden test injects a cosine **matrix** directly ("each case lists decisions
   with `meetingAt`, `text` and a `cos` matrix"), and engineering real `FloatArray` vectors to hit
   an exact target cosine for every pair in a 3-decision case requires a globally consistent Gram
   matrix, which is not always constructible for arbitrary injected numbers. The simplest option
   that keeps every golden case meaningful was a second, test-only overload —
   `link(decisions, cosineOf: (Decision, Decision) -> Float)` — that `DecisionLinksTest` calls with
   a lookup into the golden's matrix, ignoring the (dummy) `vec` contents entirely.
2. **"Never the same meeting" is enforced by the `meetingAt` strict-less check alone**, with no
   separate `meetingId` comparison. Every decision in one meeting shares that meeting's
   `meetingAt`, so a same-meeting candidate already fails `E.meetingAt < D.meetingAt` on equality.
   This matches §4's literal candidate rule and the mutant list in §5.1, which only names the
   `meetingAt` comparison, not a `meetingId` one.
3. **The open row's "due" text comes from `splitAction`'s raw stored suffix, not a recomputed
   `dayLabel(dateNorm)`.** §2.3 says the shape carries `dateNorm` and that TS "adds the typed-record
   labels with `labelsFor` ... when `itemType` is set" — read as: `dateNorm` feeds the typed-record
   chips (`RecordChips`/`labelsFor`, exactly as `DocItem` already does), while the line's own
   "Owner · due …" text is the same `splitAction` split every other screen in this app uses. §5.4's
   test wording — "the open rows show owner and due (from a content with the ' — Priya (due
   tomorrow)' suffix)" — reads the same way and is what is pinned.
4. **`ThreadScreen` never runs `splitAction` on a decision's content.** Only actions ever carry the
   " — Owner (due …)" suffix (`composeAction`); a decision is free prose and can legitimately
   contain its own em dash, which `splitAction`'s `lastIndexOf(' — ')` would misread as an
   owner/due suffix and silently truncate. Decisions render their `content` as-is.
5. **The `SectionHead` labels are rendered in the codebase's existing all-caps convention**
   ("STILL OPEN", "DECISIONS SO FAR", "MEETINGS") rather than the sentence case the brief's §2.8
   list writes them in. Every other `SectionHead` caller in this app (`"HIGHLIGHTS"` in
   `SummaryTab.tsx`) hardcodes its label in caps — `overlineSm` has no `textTransform` — so passing
   sentence case would have been the one `SectionHead` in the app styled differently from all the
   others, which reads as the restyling the brief says not to do. No test pins the exact case
   (§5.4 only asks that "the three section heads render"), so this was free to choose either way.
6. **`ThreadsDbTest`'s three meetings use relative day offsets** (`now`, `now - 7d`, `now - 14d`)
   rather than literal 3/10/17 September dates. The SQL and the link rule only ever compare
   `meetingAt` values relative to each other; the calendar date itself is exercised by the JS-side
   `dateNorm`/`dayLabel` tests already, not by this device test.

## 4. Tests

| Test file | Test names | Result | Mutants tried | Mutant result |
|---|---|---|---|---|
| `android/.../DecisionLinksTest.kt` | `everyRowOfTheGoldenTable` (10 golden cases: cosine 0.80 links; 0.55 never links even with a shared word; 0.65 with a shared word links; 0.65 without one does not; same-meeting candidate at 0.95 ignored; later-meeting candidate at 0.95 ignored; two qualifying candidates → higher wins; `vec == null` gets no link and blocks none; stop-words ("will"/"next"/"monday") don't count as shared; "ship"/"shipping" do) | pass (1/1) | `LINK_COSINE = 0`; the word clause dropped; `E.meetingAt < D.meetingAt` made `<=`; "first qualifying" instead of "best" | fails (each, individually applied and reverted) |
| `android/.../VecCodecTest.kt` | `decodeOfEncodeIsWithinScaleElementwise`, `dotOfEncodedEqualsPlainDotOfDecodedWithin1en3` | pass (2/2) | wrong byte offset in `decode` (`blob[3+i]` instead of `blob[4+i]`) | fails (both tests) |
| Every existing Kotlin unit test | — | pass (full `testDebugUnitTest`: **289 tests, 0 failures, 0 errors**) | — | — |
| `cpp/tests/test_embed.cpp` | the eight measured pairs on the real model, printed | pass | swapped a "yes" pair's expectation to `true`-when-it-should-be-`false` | fails |
| `src/screens/__tests__/threadData.test.ts` | `threadLine` (formats the counts; singulars "1 open"/"1 decision"; zero reads plural), `countsExcluding` (drops this meeting's own rows; a different meeting keeps its own rows counted; null with no other meeting; null on refusal) | pass (7/7) | plural always ("1 decisions"); own rows counted (dropped the `.filter`) | fails (each) |
| `src/screens/__tests__/ThreadScreen.test.tsx` | renders the three section heads; an open row shows owner/due/meeting title; decisions oldest first, only the third shows `changes:`; tapping an open/decision/meeting row navigates to `Meeting`; an empty thread renders both empty-state lines; a `NOT_PRO` refusal navigates to `Paywall` and renders no section head | pass (8/8) | decisions reversed (newest first); the `changes` line drawn unconditionally; the refusal branch removed | fails (each — the last two by throwing on a null `changes`/on the refusal shape, which is itself a failure) |
| `src/screens/__tests__/LibraryScreen.test.tsx` | (Phase 3) no "Open thread" without a selected tag; with a tag selected and paid it appears and navigates to `Thread`; on free it reads "(Pro)" and opens the paywall; the Actions header reads "Actions (Pro)" and opens the paywall on free; the outstanding-actions card is not drawn on free; paid keeps the card and the plain "Actions" label — plus all 9 pre-existing tests | pass (15/15) | the Pro gate inverted (`!paid`); the outstanding card drawn unconditionally on free | fails (3 tests; 1 test) |
| `src/screens/__tests__/ActionsScreen.test.tsx` | on free the screen navigates to `Paywall` on mount — plus the 4 pre-existing tests | pass (5/5) | the gate call replaced with a no-op | fails |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | (Phase 3) on Pro the line renders and tapping it calls `onOpenThread`; on free no line renders; an empty list renders nothing; four entries render three; the second row calls `onOpenThread` with its own tag, not the first — plus all 6 pre-existing tests | pass (11/11) | drawn unconditionally (dropped `paid &&`); the tapped row always passed `threads[0].tag` | fails (each; the second needed the dedicated two-tag test added for it, since the single-thread fixture couldn't tell a wrong-but-only tag from a right one) |
| `src/screens/__tests__/MeetingScreen.test.tsx` | (Phase 3) this meeting's own decision is excluded from the count; a `NOT_PRO` refusal resolves to no threads at all — plus all 16 pre-existing tests | pass (18/18) | `countsExcluding` replaced with raw `.length` counts (own rows counted) | fails |
| `android/.../ThreadsDbTest.kt` (device) | `threadJsonAssemblesMeetingsOpenAndDecisionsForOneTag`, `threadJsonRefusesWithoutEntitlement` | pass (2/2, Pixel 7 Pro) | — (device run only; see §6) | — |
| `android/.../NativePipelineTest.kt` (device) | all 16 | pass (16/16, Pixel 7 Pro) | — | — |

Kotlin XML totals (full `testDebugUnitTest`): **289 tests, 0 failures, 0 errors.**
Jest totals (full `npx jest`): **53 suites, 520 tests, 0 failures.**
C++ (`ctest`): **28/28 passed**, including the extended `test_embed`.

The eight measured cosines from `test_embed` (bge-small-en-v1.5-q8_0, matching the brief's table
exactly):

| cosine | pair | linked? |
|---|---|---|
| 0.876 | "The proposal goes out Friday." ↔ "The proposal will be sent next week instead of Friday." | yes |
| 0.824 | "We will use Postgres for the new service." ↔ "We decided to switch the new service from Postgres to SQLite." | yes |
| 0.696 | "We will ship on Monday." ↔ "Shipping moved to Thursday because QA is not done." | yes |
| 0.747 | "Existing vendors keep their old codes." ↔ "We will not migrate the old codes." | yes |
| 0.646 | "Shipping moved to Thursday because QA is not done." ↔ "The proposal will be sent next week instead of Friday." | no |
| 0.623 | "We will ship on Monday." ↔ "The proposal goes out Friday." | no |
| 0.607 | "The proposal goes out Friday." ↔ "Lunch will be at one." | no |
| 0.525 | "We will ship on Monday." ↔ "We agreed to hire two more testers." | no |

Every mutant above was introduced, watched fail, and reverted before the next step; `git status`/
`git diff` were checked clean before each commit.

## 5. Gate

```
GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh
==> types
    ok  types (2s)
==> js
    ok  js (8s)
==> scans
    ok  scans (4s)
==> mutations
    ok  mutations (86s)
==> kotlin
    ok  kotlin (4s)
==> cpp
    ok  cpp (25s)

gate: all clear in 129s
```

`mutations` is `scripts/mutate-reconciler.py`, unrelated to this phase and unaffected (33/33
mutants still caught — printed in the run, unrelated to `DecisionLinks`).

## 6. Device (Pixel 7 Pro, `ANDROID_SERIAL=36091FDH30034G`)

**Instrumented tests — real SQLCipher, real model, both green:**
- `ThreadsDbTest`: **2/2 passed.** Three meetings tagged `ops` plus one untagged and one archived
  (also tagged `ops`), each with a real action and decision through `AudioDb.replaceItems`; one
  action ticked, one rejected; two nearly-parallel hand-made unit vectors (15° apart, cosine
  ≈0.966) for the two decisions that should link, one orthogonal for the one that shouldn't.
  `threadJson(ctx, "ops")` returned: three meetings, newest first (the archived one excluded
  entirely); `open` holding only the one untouched action, from the newest meeting; `decisions`
  oldest first with the middle one's `changes` pointing at the oldest, the newest's `changes`
  null. The second test wrote the trial off (`trial_ended_at` set, no licence token) and got the
  `NOT_PRO` refusal back, before any table was touched.
- `NativePipelineTest`: **16/16 passed** — no regression from the thread code sharing `AudioDb`.

**By hand: not run this session.** The phone was not connected when this session started; it came
online later but was in active use by someone else (YouTube in the foreground — not launched by
this session), and per the brief's own house rule ("if Verbale is not focused and you did not put
another app there, wait, and say so in the report rather than pushing through") it was left alone.
§7 below is exactly the by-hand pass from §5.6 of the brief, written up for the founder to run.

## 7. For the founder to test by hand

1. Start (or confirm) a trial or subscription, then record three short meetings, saying exactly:
   (1) *"We decided we will ship on Monday. Ravi will send the proposal by Friday."*
   (2) *"Shipping moved to Thursday because QA is not done. Priya will draft the mapping table
   tomorrow."* (3) *"We agreed to hire two more testers."* Let each finish processing before
   starting the next. **Look for**: each one gets a summary and a MOM as usual.
2. Tag all three meetings **"ops"** (the tag editor, from each meeting's overflow menu). **Look
   for**: an "ops" chip appears in the library's filter row, and "ops · 3" once all three are
   tagged.
3. Open meeting 1 and tick off Ravi's action on its Actions tab. **Look for**: the checkbox fills
   and the line strikes through, same as any other tick.
4. In the library, tap the "ops" chip, then tap "Open thread" (the list icon at the end of the
   filter row). **Look for**: *Still open* shows only Priya's action, from meeting 2; *Decisions
   so far* shows all three, oldest first, and the middle one reads `changes: "…ship on Monday…"`;
   *Meetings* lists all three, newest first.
5. Open meeting 3 (the newest)'s Summary tab. **Look for**: a line under the summary card reading
   "ops: 1 open · 2 decisions" — its own decision is not counted. Tap it. **Look for**: it opens
   the same thread screen as step 4.
6. End the trial (or use a lapsed/free account) and return to the library. **Look for**: the "ops"
   chip's button now reads "Open thread (Pro)" and opens the paywall instead of the thread; the
   header's Actions button reads "Actions (Pro)" and also opens the paywall; meeting 3's Summary
   tab shows no thread line at all — not even a "(Pro)" placeholder.
7. On that same free/lapsed account, add or remove a tag on any meeting and filter the library by
   it. **Look for**: tagging and tag filtering still work exactly as before — only the thread
   screen and the cross-meeting worklist are gated, nothing else.

## 8. Known gaps and cosmetic leftovers

- The §5.6 by-hand pass was not run this session (device contention/availability — see §6); §7
  above is written so it can be run and confirmed without reading any code.
- No dedicated mutation pass was run against `ThreadsDbTest`/`NativePipelineTest` themselves — the
  same convention Phase 2's report used for its own device-only classes — because the logic they
  exercise (`DecisionLinks`, `threadJson`'s SQL) is already mutation-tested at the Kotlin-unit and
  C++ level; the device tests are what confirm it holds against real SQLCipher and a real model.
- `ThreadScreen` re-reads on every focus (fixed mid-session — see the commit history, §9) but has
  no pull-to-refresh; a person who ticks an action elsewhere and returns to an *already-open*
  thread screen (rather than re-navigating to it) sees the old counts until they leave and come
  back. Not requested by the brief and not tested.
- The open row's typed-record chips (`RecordChips`/`labelsFor`, for an itemType-classified action)
  render but are not directly asserted by any test — only implied by §2.3's shape description, not
  by §5.4's literal test list.

## 9. Commits

1. `051cf5f` — feat(threads): the decision-link rule — cosine over the meaning vectors, never the model
2. `ffab018` — test(threads): pin the eight measured cosines that chose the decision-link thresholds
3. `f1013e3` — feat(threads): one native query, one JSON — AudioDb.threadJson end to end
4. `7d60abc` — feat(threads): the thread screen — still open, decisions so far, meetings
5. `acd68b7` — feat(threads): the two doors, and the worklist becomes Pro
6. `a4596d5` — feat(threads): the Summary tab's thread line
7. `287e442` — feat(threads): MeetingScreen resolves the thread line for its own tags
8. `2fed289` — test(threads): device tests — the tag join, the exclusions, the Pro gate
9. `80a6281` — fix(threads): ThreadScreen re-reads on focus, not only on mount
