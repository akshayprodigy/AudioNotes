# Phase 0 — baseline and specifications

*7 October 2026. Branch `phase-0-baseline`, cut from `main` at `81396d0`. Documentation only: no app code was changed, nothing was pushed, no phone was used. Sources: `docs/PRODUCT_IMPROVEMENT_PLAN_2026-10.md` (§3–§7), the three September documents (A07 pass, Phase B report, fix plan), `docs/NEXT.md`, the free-allowance native plan (it exists only on branch `free-allowance`), and `eval/`.*

**Read this first.** Three facts shape everything below.

1. **Nothing in the allowance design is live.** The two pure-Kotlin building blocks sit on an unmerged side branch and nothing calls them. The app still enforces 15 minutes, decided in JavaScript, and a Free recording started from the Quick Settings tile has no cap at all.
2. **No Phase B fix has run on a phone.** Phase B (25–26 Sep) came after the only phone pass (A07, 25 Sep). The A07 phone holds the founder's real meeting and the Pixel is dead.
3. **The trust defects the plan cares most about are all still open in code** (owner rename, transcript corrections, extractor misses, writer facts, Ask citations), and `eval/` cannot measure most of them yet.

Where I could not verify something the row says so. Nothing here is a quality threshold.

## 1. Defect audit

**Method.** Every row was checked against the code on `main` (`81396d0`) by reading it, with `git log -S` / `git blame` for the introducing commit, and by reading the test that is claimed to prove it. Statuses were not copied from the reports. Abbreviations: **A07** = `reports/2026-09-25-a07-play-build-feature-pass.md`; **PB** = `reports/2026-09-25-phase-b-nothing-lost-nothing-false.md`; **FP** = `plans/2026-09-25-fix-plan-after-a07-pass.md`; **PA** = `reports/2026-09-24-phase-a-buying-and-pro-state.md`. All three September documents and the other listed sources exist; the allowance plan exists only on branch `free-allowance` (see Section 2).

**Status rules used.** *FIXED* = the change is in the code and a test that fails without it exists. *AWAITING-DEVICE* = a fix exists but nothing shows it running on a phone. The only phone run in the repo is the A07 pass of 25 Sep on build `e1a960b` (11:53 +05:30); every Phase B commit (`defc6c9` onward, 25–26 Sep) came **after** it, and no document dated after 26 Sep records a phone run, so no Phase B fix has device evidence. *UNRESOLVED* = no fix, or a partial one (the missing part is named). *NOT-REPRODUCIBLE-FROM-CODE* = Play Console, live server or OS state.

**Baseline run on this branch (7 Oct).** `npx jest`: 68 suites, 655 tests, all pass. `./gradlew :app:testDebugUnitTest --offline --rerun`: 359 tests, 0 failures, 0 skipped — run on `free-allowance`, so it includes the 18 allowance tests; the other 341 are what `main` carries. I did not run the instrumented (`androidTest`) tests, the C++ tests, or any mutation checks, and I did not run `npx jest minutes.golden` because it rewrites golden files. Mutant results quoted below are the reports' claims, not re-run.

Line numbers are current at `81396d0`. `KT` = `android/app/src/main/java/com/innocorelabs/verbale/`.

### 1.1 Findings

| id · title | source doc + line | status | evidence |
|---|---|---|---|
| **D01** Record screen overflows once the Free-limit card appears; Stop pushed off-screen | A07 L19-23; FP C1.1 L53-57 | **UNRESOLVED** | `src/screens/RecordScreen.tsx`: the card (`capNote`, L492-530) is still a child of `st.stage` (L471; style `flex:1, justifyContent:'center'` L602), no `ScrollView` in the recorder branch (the only one is the consent branch, L325); the mascot is still rendered (L472-475), so the card does not replace it as FP decided; big Stop is the `MicVisualizer onPress` (L546). Only commit touching the file since the A07 is `ccd93a3` (alert). No `RecordScreen` test exists (PB L87 confirmed). |
| **D02** Lapsed subscription keeps Pro ~3 days (200 + `token:null` kept the old token) | A07 L24-28; FP H1 L23-30 | **FIXED** (JS logic; no phone run after it) | `src/billing/subscription.ts:136-143` clears the token on a 200 with no token; `ae33b43` (25 Sep 20:10). Tests `src/billing/__tests__/playPurchase.test.ts:221` "forgets a token the server no longer backs, and keeps the refresh key", `:237` network error keeps token, `:244` 5xx keeps token (24/24 pass). Note it is `Licence.store('', null)`, not `Licence.clear()` as FP wrote (deliberate: keeps the refresh key). Server side: `server/app/main.py:124-129` returns `token:null` when not entitled. |
| **D03** The lapsed UI (Check again / Manage) cannot be reached after D02 | A07 L92 "lapsed UI … blocked by defect 2"; FP H1 L26-27 | **UNRESOLVED** | UI exists (`SummaryTab.tsx:198-211`, built `92cdffd`; test `SummaryTab.test.tsx:425`) but renders only for `licence.state === 'expired'` (`SummaryTab.tsx:235`). D02's `store('', null)` yields state `NONE` (`Licence.kt:63,84`), which the Summary treats as `locked` (Free upsell, `:249-250`). So FP's expectation ("Summary shows Check again and Manage at once") is not what the code does; the lapsed card appears only when a signed token naturally expires. Never seen on a phone; no test chains refresh → store('') → SummaryTab. |
| **D04** Consent clip leaks into transcript and title when found but judged too quiet | A07 L29-33; FP B7 L45-49; PB L21-23 | **AWAITING-DEVICE** | Rule `AnnouncementSpan.lagToExclude` keys on `found` (`KT/pipeline/AnnouncementSpan.kt:31-32`); wired `RecordingService.kt:385-398` before the heard-only stamp; `AudioDb.setAnnouncedLag` (`:588`) consumed by `ProcessingEngine.announcementFree` (`:619`). Commit `a351194`. Tests `AnnouncementSpanTest.kt:87-102` "a clip found but too quiet to count as heard is still kept out of ASR" (kills the `found`→`heard` mutant). **Not tested:** that the service calls `setAnnouncedLag`, that the SQL writes the column, that `ProcessingEngine` drops the span, the title outcome (PB L162-164 accurate). Unverified ordering concern: a live ASR window can close before the 12-s verdict writes the lag (`LiveTranscriber.kt:196-199`). |
| **D05** A Free-limit stop is not processed; notice claims transcription; Record screen resets silently | A07 L34-36; PB B2; FP L39-41 | **AWAITING-DEVICE** | Path: cap loop `RecordingService.kt:461-478` → `END_CAP_REACHED` → `onDestroy` `:640-659` stores the reason, `ProcessingService.enqueue` only `if EndNotice.shouldProcess`, posts notice 45; text "It is being transcribed now." only when enqueue did not throw (`EndNotice.kt:28-31`); old string gone (`git grep notif_cap_reached` empty). Record screen: `explainEnding` `RecordScreen.tsx:201-225`. Commits `defc6c9`, `8307c22`, `ccd93a3`. Tests `EndNoticeTest.kt` (5), `meetingNotes.test.ts`, `MeetingScreen.test.tsx:737`; none cover `onDestroy` wiring or `explainEnding`. Caveats: the Record-screen explanation fires only if that screen is mounted when the recording ends; whether Android allows `startForegroundService` from `onDestroy` screen-off is unproven (see D24). |
| **D06** An announcement nobody heard is reported nowhere | A07 L37-38; PB B4 | **AWAITING-DEVICE** | `RecordingService.kt:393-394` stores the outcome for every recording and raises `CaptureController.noteAnnouncement`; two-minute warning `CaptureWarnings.kt:93-97`; Record screen `RecordScreen.tsx:79-80,537-544`; meeting line `meetingNotes.ts:23-39`. Commits `38f8c3c`, `8307c22`. Tests `CaptureWarningsTest.kt:75,86`, `meetingNotes.test.ts:21-31`. Untested: announce thread → controller → event chain, `setAnnounceOutcome` SQL. |
| **D07** Renaming a speaker does not reach minutes, actions, threads (search, exports) | A07 L39-42; FP C1.3 L60-63 | **UNRESOLVED** | The owner is baked into item text at extraction (`cpp/minutes/minutes_extractor.cpp:379-397`; TS twin `src/pipeline/minutes.ts:90-97`) and parsed back at render by `splitAction` (`src/screens/meeting/shared.tsx:422`). `renameSpeaker` is one `UPDATE speakers` (`src/db/queries.ts:487-488`). Per surface: Actions tab `ActionsTab.tsx:70` no; Minutes tab `shared.tsx:630` no; cross-meeting worklist `ActionsScreen.tsx:206` no; Threads `ThreadScreen.tsx:124` no; search rows index raw text (`AudioDb.kt:240-250`) and keep "— Unassigned" no; exports: transcript labels live (`FileExportModule.kt:149,475`, `ExportItemsTest.kt:538`), action lines keep the old name no. Only the Review queue resolves live (`ReviewScreen.tsx:57-65`; I did not verify a rename assertion in its test). Speakers' "Regenerate minutes" rewrites `minutes` rows only (`queries.ts:306`), never `items`, so it is a no-op for any meeting with items. No fix commit, no rename-propagation test. |
| **D08** Model mirror 404 for `bge-small-en-v1.5-q8_0.gguf` | A07 L43-45; FP H2 L32-35 | **NOT-REPRODUCIBLE-FROM-CODE** | Repo side complete: catalog row `KT/data/ModelCatalog.kt:260-265`, mirror-then-upstream order `:288-292`, `ModelCatalogTest.kt:167-175`; `server/deploy/mirror-models.sh` unchanged since 2 Sep. Whether the idempotent script was re-run on the live host cannot be seen from here (and I made no network call). |
| **D09** Settings model rows stick at "1.1 GB of 1.1 GB · 100%" with the spinner | A07 L46-47; FP C2.1 L69-70 | **UNRESOLVED** | `SettingsScreen.tsx:366-373` records progress for any download, but only Settings' own `onToggle` `finally` (`:428-438`) clears it and refreshes; a download started from Paywall (`PaywallScreen.tsx:249`) or Onboarding (`:247`) leaves the row `busy` (`:472`) with stale `installed=false`. There is no completion event at all (`ModelManagerModule.kt` emits only `onModelProgress`, final `(size,size)` at `:215`). No Settings test; no commit since `0e88506` (24 Sep). |
| **D10** Summary writer states wrong facts ($499, "sent out", invented schedule) | A07 L48-51; FP D1 L86-90 | **UNRESOLVED** | No grounding post-check exists (`cpp/minutes`, `src/pipeline`, `Narrator.kt`): only prompt wording (`cpp/minutes/llm_prompts.cpp:129,214-220`) and a template-echo filter (`llm_minutes.cpp:20-24`). `eval/` skips the summary (`eval/metrics/mom.py:from_document`). FP D1 says measure first — nothing measured. Prices have no check anywhere; promised-vs-completed has no field (`evidence_record.cpp:19`). |
| **D11** Ask cites "[4] Minutes · 0:00" instead of the transcript moment; uncited sentence not dropped | A07 L52-53; FP C2.2 L77-80 | **UNRESOLVED** | `KT/ask/Asker.kt:53-60` labels every non-utterance hit "Minutes" and keeps its `startMs`; minutes/summary are indexed at `start_ms = 0` (`AudioDb.kt:196-221`). `AskerTest.kt:48` pins the current label — the fix means changing that test. `cpp/minutes/ask.cpp:113-148 validateAnswer` rejects only an answer with no cite at all, and the grammar is `body cite+` (`:59-68`), so an uncited sentence inside a cited answer survives. `AskScreen.test.tsx:79` covers only an utterance cite (6500 ms). |
| **D12** Meaning search has no relevance floor; rows show raw "— Unassigned" | A07 L54-55; FP C2.3 L81-83 | **UNRESOLVED** | `AudioDb.kt:138-167 meaningHits` keeps the top 40 by dot product with no minimum; `Retriever.fuse` is rank-only (`Retriever.kt:28-44`). `grep -i "cosine\|similarity\|threshold" docs eval` finds no measurement of a floor, which FP says must precede the code. "— Unassigned" is not stripped in `SearchScreen.tsx` (see D07). |
| **D13a** "Let's start the weekly check-in…" is an ACTION | A07 L56-57; FP C2.4 L79-81 | **UNRESOLVED** | `let['’]s` is in `ACTION_FIRST_PERSON` (`src/pipeline/minutes.ts:15`; C++ `cpp/minutes/minutes_extractor.cpp:17-19`). I ran the real `minutes.ts` from a scratch copy: `isAction=true`. A current golden pins the opposite: `minutes.golden.test.ts:114-118` and `cpp/tests/golden/minutes_meeting.json` expect "let's kick off the design review" to be an action — fixing this changes a pinned golden in both ports. No commit touches either extractor since `d247e83` (22 Sep). |
| **D13b** "Rahul will recruit ten more testers by Monday" is not an action | A07 L57-58; FP C2.4 | **UNRESOLVED** | The `will <verb>` list is closed (`minutes.ts:21`; C++ `:27`); "recruit" absent. Ran real TS: `isAction=false`, owner Rahul and `due=by Monday` found, sentence dropped. `d35a81a` (14 Sep) only widened the list; FP's "any verb when a date or object follows" does not exist. No test pins the miss. |
| **D13c** "before Wednesday" gets no due date | A07 L58; FP C2.4 | **UNRESOLVED** | `DUE` has no `before` (`minutes.ts:63`; C++ `:47-49`); `dateNorm.ts:17` `DROPPED_LEADS` lacks it too, so it would reach the review queue as unpinnable. Ran real TS: action found, `due=null`. |
| **D14** A transcript correction does not update items built from the line | A07 L58-60; FP C1.4 L64-65 | **UNRESOLVED** | A correction is a row in the `edits` side table (`MeetingScreen.tsx:549,582` → `queries.ts:686` → `AudioDb.kt:1394`); nothing calls `ensureItems`/`replaceItems`/the rule pass. FP's "re-run via `db.ensureItems`" cannot work as written: `ensureItems` only migrates meetings with no items (`MeetingScreen.tsx:212-251`, `AudioDb.kt:2510`) and the rule pass reads raw `utterances.text`, not the `edits` overlay. Per artefact: transcript display yes (`TranscriptTab.tsx:292`); exports yes (`FileExportModule.kt:529-530`); items, minutes, narration, review queue, FTS index (`reindexMeeting` `AudioDb.kt:290-310`), embeddings no. The preservation half is built and tested (`ReconcilerTest.kt:360,386,427`; `userItems.test.ts`). `MeetingScreen.test.tsx:655` asserts only that `putEdit` ran. |
| **D15** Free limit stops at 15:15, not 15:00 | A07 L63; FP C1.2 L58-59 | **UNRESOLVED** | `RecordingService.kt:462` tests the cap only when `reads % DISK_CHECK_EVERY_READS == 0`; `DISK_CHECK_EVERY_READS = 256` (`:91`) ≈ 33 s, plus ≈ 2 s of buffered output (`:348`). The ≈ 1 s cadence (`:92`, `:451`) serves warnings only. No cadence test (`CapClockTest.kt` covers phases). The live cap is `FREE_CAP_MS = 15 min` (`src/billing/recordingCap.ts:26`). |
| **D16** First line "Good morning everyone." missing from mic recordings | A07 L63-66; FP D3 L91-92 | **UNRESOLVED** | No code change, investigation note or test (`git log` since 25 Sep). Untested hypothesis only: `AnnouncementSpan.exclude` drops every VAD span overlapping the clip ±500 ms (`AnnouncementSpan.kt:23,41-61`), and `a351194` widened it to every *found* clip, so it can only remove more. |
| **D17** whisper hears "comma" as "Kama"; dictation commas fail | A07 L65-66; FP D2 L91 | **UNRESOLVED** | `cpp/minutes/dictation.cpp:18-26` matches the whole word "comma" only; no alias; `cpp/tests/test_dictation.cpp:28-34` covers only correctly-heard "comma"; vocabulary biasing was "measured and left off" (`9f05928`). |
| **D18** A dictation is auto-titled "Afternoon meeting" | A07 L66; FP C2.5 L82-84 | **UNRESOLVED** | `CaptureController.kt:475-486 defaultTitle()` has no mode branch and runs (`:401`) before the mode is set (`:403`). Partial mitigation: `ProcessingEngine.retitleFromTranscript` (`:522-545`) retitles from the opening words after ASR, and the Library/Meeting headers show a "Dictation" label. No test. |
| **D19** Free summary card says "processed before summaries were written" | A07 L66-67; FP C2.5 | **UNRESOLVED** | The Free ('locked') copy was rewritten on 31 Aug (`44df120`), before the A07; the old string remains as the catch-all (`SummaryTab.tsx:483`) shown for the `checking` state (`:172-173`) and the `catch` path (`~:278`). I could not tell which path the A07 hit. No test of those paths. |
| **D20** Meeting overflow sheet hides Archive/Delete below the fold with no scroll cue | A07 L67-68; FP C2.5 | **UNRESOLVED** (partial) | The sheet scrolls and is capped at 85% (`src/components/ui.tsx:410-420,1017`; `36b8488`, 22 Sep, test `Sheet.test.tsx:26`) — that was already in the 1.0.3 build the A07 tested. What remains is the cue: the scroll indicator is explicitly hidden (`ui.tsx:420`), no fade or peek. |
| **D21** Model row's "· 100%" clipped at the right edge | A07 L68; FP C2.1 | **UNRESOLVED** | The meta row is a non-shrinking `flexDirection:'row'` with an un-wrapped `Txt` (`SettingsScreen.tsx:538-541`, style `:1075`). The Android 15 theme fix (`0d9910e`, `values-v35`) predates the A07 and addresses a different mechanism, so it is not the answer. No layout test. |
| **D22** Play Console prices ₹300 / ₹2,500 (final ₹299 / ₹2,499) | A07 L59-60; FP §6 L96 | **NOT-REPRODUCIBLE-FROM-CODE** | Console state. Repo copy already says final prices: `docs/play-console.md:143-148`, `server/app/landing.py:246`; the app reads Play's price live. |
| **D23** Console benefits list says "Export meetings (MP3, SRT, PDF)"; export is free, no MP3 | A07 L60-62; FP §6 L97-98 | **NOT-REPRODUCIBLE-FROM-CODE** | Console state; repo copy is clean (`grep -ri mp3` finds no MP3-export claim; export is listed as Free at `docs/play-console.md:276`, `landing.py:239`, `PaywallScreen.tsx:55-56,129`). |
| **D24** Background start of processing after a non-Stop ending is unverified on a phone | PB L154-156 | **AWAITING-DEVICE** | `RecordingService.kt:650-656` (try/catch; falls back to "Open Verbale to transcribe it."), `RecordTileService.kt:82-88`, `PipActionReceiver.kt:33-42`; fallback sweep `LibraryScreen.tsx:301` → `PipelineController.processPending` with `PENDING_MEETINGS_SQL` (`queries.ts:28-30`). `ProcessingService.enqueue`'s own KDoc (`:345-346`) says it must be called in the foreground. No later device doc. |
| **D25** `markFailed` in `ProcessingEngine` has no JVM test | PB L158-161 | **AWAITING-DEVICE** (no test exists) | Still no test: `grep markFailed` in `src/` and the Android test dirs finds only `ProcessingEngine.kt:470-471` and `AudioDb.kt:712-717`. Tested around it: `FailureReasonTest.kt` (6), `ResumePlanTest.kt:103,107`, `pendingMeetings.test.ts`, `SchemaTest`. Introduced `42d2b2b`. |
| **D26** `mergeSpeakers` has no transaction and writes no `edits` rows | PB L165-166 | **UNRESOLVED** | `src/db/queries.ts:513-520`: two bare statements (UPDATE utterances, DELETE speaker), no transaction, no `edits` insert (contrast `setLineSpeaker`, `:530-538`). No DB-level test of `mergeSpeakers`; untouched since the initial commit. |
| **D27** Merging speakers now asks first and names both | PB Step 9 L34-37; §7.7 L149-150 | **FIXED** (by-hand step still open) | `SpeakersScreen.tsx:88-103` `confirmDestructive`; `ccd93a3`. Test `SpeakersScreen.test.tsx:150` "merging names both speakers and asks first" (asserts the title, that `mergeSpeakers` has not been called before confirming, and the call after). "Cancel keeps both" is not asserted. |
| **D28** The full gate found a MeetingScreen test broken by Step 8 | PB L40-50 | **FIXED** | `cce9754` (test-only, +7 lines): `MeetingScreen.test.tsx:263-286` now presses **Change** in the confirm before asserting; non-vacuous (without Step 8 `alert.mock.calls[0]` is undefined). |
| **D29** `clearNarration` grep note | PB L52-63 | **FIXED** (claim accurate) | Production grep is empty; remaining hits are the definition `queries.ts:345`, a mock `MeetingScreen.test.tsx:72` and the guard assertion `:754`. `97238a3`. Side finding: `db.clearNarration` is now dead production code. |
| **D30** "Write it again" keeps the old summary until replaced; changing type asks first | PB L33-34, §7.6 L146-148 | **AWAITING-DEVICE** | JS contract tested: `MeetingScreen.test.tsx:748-755` ("keeps the summary and asks native for a forced narration", `process('m1',{model:'base',force:true})`), `SummaryTab.test.tsx:142` ("a type change over a summary asks first, then saves the type before writing"). The "replace in one transaction" half is native (`PipelineController.process … force`) and I did not read it. `97238a3`, `d081080`. No phone run. |
| **D31** By hand §7.1: Free limit with screen off | PB L127-131 | **AWAITING-DEVICE** | Backed by D05/D24. No run recorded. |
| **D32** By hand §7.2: Free limit with the Record screen open | PB L133-134 | **AWAITING-DEVICE** | `RecordScreen.tsx:201-225,235-243`; screen has no test suite. |
| **D33** By hand §7.3: Quick Settings tile Stop queues processing | PB L135-137 | **AWAITING-DEVICE** | `RecordTileService.kt:73-91` (`defc6c9`; the old tile Stop did not enqueue). No test of a `TileService`. |
| **D34** By hand §7.4: announcement not heard (volume 0) | PB L138-141 | **AWAITING-DEVICE** | Backed by D06. Note a quiet-but-found clip reads the `not_heard` line, not "phone was on silent" (`meetingNotes.ts:27-30`). |
| **D35** By hand §7.5: waiting is never shown as "no speech" | PB L142-145 | **FIXED** (display logic; the by-hand race not run) | `holdFor` (`meetingNotes.ts:43-53`); tests `meetingNotes.test.ts:39-44`, `MeetingScreen.test.tsx:698,712,726`; `8307c22`, `97238a3`. |
| **D36** Not tested: payment received while offline | A07 L92; PA §7.2 | **AWAITING-DEVICE** | `subscription.ts:180-199`, `:351-369`; tests `playPurchase.test.ts:71,81,163,182`. A07 ran only the happy path. |
| **D37** Not tested: slow test card | A07 L92; PA §7.3 | **AWAITING-DEVICE** | HTTP 402 → pending, not acknowledged (`subscription.ts:193`); `playPurchase.test.ts:88`; `server/tests/test_play.py:125`. |
| **D38** Not tested: Restore after clearing data; reinstall ×3 | A07 L92-93; FP §6 L99-100; PA §7.4,7.7 | **AWAITING-DEVICE** | `restorePlayPurchase` `subscription.ts:325-334`; tests `playPurchase.test.ts:115,123,130,182`; server eviction `73c5431`, `server/tests/test_store.py:66`. Needs a phone with no real meeting (A07's holds the founder's). |
| **D39** Not tested: speaker merge | A07 L93-94 | **AWAITING-DEVICE** | UI tested (D27); the DB write has no test (D26); synthetic voices diarize as one speaker, so two real voices are needed. |
| **D40** Not tested: remembered voices on the Play build | A07 L94 | **AWAITING-DEVICE** | Steps 1, 2, 4, 6, 7 ran on the A07 on 22 Sep with a real voice (`reports/2026-09-22-a07-layer-1-session.md:31-38`); step 3 (one-time card, needs a fresh install) and 5 (second real voice) never ran; not re-run on 1.0.3. Tests `SpeakersScreen.test.tsx`, `VoicesSection.test.tsx`, `PeopleMatchTest`. |
| **D41** Not tested: Whisper small | A07 L95 | **AWAITING-DEVICE** | Catalogued and Pro-gated (`ModelCatalog.kt:157,306-307`); only a Mac eval number exists (`PRODUCT_RESEARCH_2026-09.md:75`); no document records a phone transcription with it. |
| **D42** Not tested: backup / restore | A07 L96 | **AWAITING-DEVICE** | `BackupManager.kt`; instrumented tests `BackupManagerTest.kt:104,138` ran 16–22 Sep; the Settings → Back up → restore flow was never driven on a phone. The allowance ledger is not in backup (plan Task 4 unbuilt). |
| **D43** Not tested: mic lost / disk full | A07 L96 | **AWAITING-DEVICE** | `RecordingService.kt:437-441` (mic lost), `:282-287,479-483` (disk); audio kept, queued, noticed (`:640-659`). Only wording is tested (`EndNoticeTest`). See §4-A (v). |
| **D44** Not tested: Quick Settings tile — **start** half | A07 L96 (tile listed) | **UNRESOLVED** | **Not in any September document**: a Free recording started from the tile or shortcut has no cap. `ShimActivity.kt:68` calls `CaptureController.start(applicationContext)` with the default `capMs = 0L` (`CaptureController.kt:387`), so `RecordingService.kt:461` never runs. No countdown, no stop, no notice. No test. I confirmed it in the code; the allowance plan (L15) also says so. |
| **D45** Not tested: the 90-minute capture | A07 L96-97 | **NOT-REPRODUCIBLE-FROM-CODE** | Needs 90 minutes of wall clock on a phone. Code facts: wake lock with 6 h cap (`RecordingService.kt:270-277`), 64 KB buffered stream (`:348`). `docs/ARCHITECTURE.md:633` says it has never been run. |
| **D46** Push when ready (31+ commits unpushed) | FP §6 L102 | **UNRESOLVED** (founder action) | `main` is **49** commits ahead of the local `origin/main` ref (not fetched). |

**Additional findings, not in the three September documents** (found while verifying):

| id · title | source | status | evidence |
|---|---|---|---|
| **N01** A re-transcribing Redo deletes transcript corrections | found by audit | **UNRESOLVED** | `AudioDb.kt:892` `DELETE FROM edits … target_kind IN ('utterance','speaker')` — deliberate (fresh ids), but a user's correction is lost on Redo. Not mentioned in any report. |
| **N02** A retry shows an ETA priced for the whole pipeline until the first stage event | found by audit | **UNRESOLVED** | A `failed` or finished meeting maps to stage `'vad'` (`src/screens/progress.ts:60-62`) while `reprocessing`, so `progressFor` sums every stage (≈ 131 min for 90 min of audio) even though `ResumePlan` resumes later. No test. |
| **N03** `recoverOrphanedRecordings` has no test | found by audit | **AWAITING-DEVICE** (no test) | `AudioDb.kt:503-526` is the only rescue for a mid-recording death when the service is not redelivered; no JVM or instrumented test. |
| **N04** Free copy still sells 15 minutes | found by audit | **UNRESOLVED** | `recordMode.ts:28`, `RecordScreen.tsx:500-501`, `PaywallScreen.tsx:130`, `server/app/landing.py:236,291-292`, `docs/play-console.md:270`. Expected until the allowance ships (plan Workstream B), recorded so none is missed. |
| **N05** `flush()` in the capture loop's `finally` could escape on a full disk | found by audit (code reading only) | **UNRESOLVED** (unverified at runtime) | `RecordingService.kt:494` runs before `stopSelf()` `:498`; if it throws, the service may keep showing "Recording" with a dead worker. Not exercised. |

### 1.2 Plan §4-A "Deliverables" answered

| §4-A bullet | Status | Evidence and what is unproven |
|---|---|---|
| **Reconcile September findings with code** | done by §1.1 | See counts at the end. |
| **Free-limit stop** preserves recoverable audio, queues processing, explains outcome | **AWAITING-DEVICE** | Audio is streamed to `audio.pcm` and flushed in `finally` (`RecordingService.kt:348,491-495`); `markCaptured` (`:640`); enqueue and notice (`:650-659`, `EndNotice.kt`); Meeting page `endingNote`. Unit/jest tests listed in D05. Unproven: any phone run after `defc6c9`; background enqueue screen-off (D24); the Record-screen alert exists only while that screen is mounted, so reopening later shows an idle recorder with no word (the A07 symptom survives in that case); and the live cap is 15 min stopping at ≈ 15:15 (D15), not the plan's 60 min — and the tile is uncapped (D44). |
| **Notification / PiP stop** | **AWAITING-DEVICE** for the tile; notification and PiP Stop are *device-evidenced 25 Sep, untested in the repo* | Notification Stop (`RecordingService.kt:206-226`) and PiP Stop (`PipActionReceiver.kt:27-45`) passed on the A07 including headless processing and "Your notes are ready" (A07 L74-75); `git diff e1a960b..HEAD` on `PipActionReceiver.kt` is empty. No automated test of stop-then-enqueue (`StartRouteTest.kt` tests routing only). Tile Stop changed after the A07 (D33). If the 5-s flush latch times out (`CaptureController.kt:453-458`), `stop()` returns and the caller enqueues while the service may still be flushing. |
| **Process death** | **AWAITING-DEVICE** | Recording: `START_REDELIVER_INTENT` (`RecordingService.kt:263`), `CaptureController.adopt` reconciles dead time against bytes on disk (`:317-350`), append mode (`:348`); if the service never returns, `recoverOrphanedRecordings` turns rows over 32,000 bytes into `captured` (`AudioDb.kt:503-526`; **no test**, N03). Loss bound ≈ 2 s buffered. Processing: `ResumePlan.remaining` (`ResumePlan.kt:39-52`, `ResumePlanTest.kt`), sweep re-queues `failed` with `fail_count < 3`. Instrumented `CaptureStateTest` exists in `androidTest` and needs a device. Unproven: a real force-stop mid-recording and mid-ASR is not recorded as an outcome in any document I could find; OEM battery killers; the `failed` path against a real OOM (D25). The background-processing report of 11 Aug is a prior claim, not re-verified. |
| **Interruption** (call, focus loss, mic taken, headset) | **AWAITING-DEVICE**; no JVM test | API 29+ `AudioRecordingCallback` sets `silenced` and swaps Mark for "Mic unavailable" (`RecordingService.kt:522-553`, `RecordScreen.tsx:557-558`). The loop keeps writing silence, so a call becomes a silent stretch; **no gap marker is persisted** though the KDoc promises one (`:510-513`). Capture never requests audio focus. Headset or route change is only logged (`:545,548`). Hard loss (`ERROR_DEAD_OBJECT`) ends as `mic_lost` with audio kept and queued. Below API 29 there is no silence detection. Nothing is tested beyond the `mic_lost` wording. |
| **Storage failure** | **AWAITING-DEVICE** | Start refused under 50 MB (`RecordingService.kt:282-287`, nothing recorded, told so); mid-recording hard stop at < 50 MB checked every ≈ 33 s (`:479-483`) — ≈ 27 minutes of headroom, so the code comment saying "a couple of minutes" (`:83-87`) is wrong; a storage warning at ≈ 81 min (`CaptureController.kt:48`). Audio kept, queued, noticed. Tests: `CaptureWarningsTest.kt:38,43`, `EndNoticeTest`. Unproven on hardware; N05; disk exhaustion during processing was not analysed. |
| **Source links resolve to transcript moment and audio** (decisions, actions, Ask) | **UNRESOLVED** (partial) | *Fixed for the meeting's Minutes and Actions tabs*: `ProvenanceButton` (`ItemProvenance.tsx:47-82`) → `MeetingScreen.openProvenance` (`:679-686`) scrolls the transcript to `items.anchor_start_ms` and plays from it; tests `ItemProvenance.test.tsx:442,948,963,556,220`, `ReconcilerTest.kt` anchor test, goldens `evidence_*.json`; the A07 saw it work (L75-76). Hand-typed items and unmigrated meetings have no anchor, so no button (by design). *Not resolved*: Threads ("decisions so far", open actions) `ThreadScreen.tsx:53` and the cross-meeting worklist `ActionsScreen.tsx:138` open the meeting with **no moment** though the row carries `anchorStartMs`; Ask cites to minutes/summary/title/hand-typed items show "Minutes · 0:00" (D11); Ask only scrolls, it never plays audio. The Review queue is fixed (`ReviewScreen.tsx:258-260,302`; which test covers the button is not verified). Unproven: anchor accuracy on a real meeting beyond the A07 pass; anchors after a re-ASR. |
| **Speaker rename propagation** (minutes, actions, threads, search, exports) | **UNRESOLVED** | D07. Only the Review queue and transcript labels in exports are live. |
| **Transcript corrections update derived items, preserving manual changes and completion state** | **UNRESOLVED** | D14. Preservation is built and tested; update is absent, and N01 (Redo deletes corrections). |
| **Processing progress/ETA, thermal pauses, retry states honest and actionable** | **AWAITING-DEVICE** (two gaps) | *Progress/ETA*: stage rates and learned per-phone rates (`progress.ts:32-42`, `StageRates.kt`, 70/30 blend), counts "Words written down · 14 of 40" (`MeetingScreen.tsx:1100-1102`); `progress.test.ts` 14 tests; device-verified once on the Pixel 16 Sep (diarization counts; ASR counts explicitly *not* exercised) — **that phone is dead**, no later phone evidence. The 6 Sep "four-hour estimate" is fixed in code (`76c32de`), but its test only asserts `< 150` min (`progress.test.ts:50`). *Thermal*: pause at SEVERE or < 15 % unplugged (`ProcessingBudget.kt:28-33`), UI hides the ETA while paused (`MeetingScreen.tsx:998-1013`, test `:460-476`), Library PAUSED; heat pause verified on the Pixel 16 Sep, battery pause unit-tested only. *Retry*: `failed` shows the reason with **Try again**, queued shows **Process now**, Library `DIDN'T FINISH` (`MeetingScreen.tsx:1180-1240`, `LibraryScreen.tsx:44-60`; tests `MeetingScreen.test.tsx:698,712`) — never run on a phone. Gap N02: a retry shows an over-large whole-pipeline ETA until the first stage event; diarization's 0.67 is an unmeasured constant (`progress.ts:27-30`). No ETA appears while paused (verified in code). |

### 1.3 Prioritised backlog

Size: S ≈ under a day, M ≈ a few days, L ≈ a week or more of one engineer plus device time (guesses, not estimates). Workstreams are the plan's letters (A trust, B allowance, C first value, D results/navigation, E sharing, F retention).

**UNRESOLVED first**

| Pri | Item | Size | Workstream |
|---|---|---|---|
| 1 | **D44** Free recording from the tile or shortcut is uncapped — resolved natively in `CaptureController.start` (allowance plan Task 5) | S | B (a P0 defect today) |
| 2 | **D01** Record-screen overflow under the cap card — Stop must stay reachable; needs a test harness for `RecordScreen` | M | A/D, and B (new 60-min warning flows through it) |
| 3 | **D15** Cap enforced on the ≈ 1 s cadence (to the second) | S | B (allowance Task 6) |
| 4 | **D07** Owner resolved live from `owner_json` on every surface including exports and search; fix Regenerate | L | A |
| 5 | **D14 + N01** Corrections reach items, index and embeddings; decide whether the rule pass reads the `edits` overlay (design decision first) and stop Redo deleting corrections | L | A |
| 6 | **D13a-c** Extractor misses, TS + C++ + goldens, cue-from-whisper rule (change the pinned "let's kick off" golden) | M | A |
| 7 | **D10** Writer fact errors — *measure first* with a price/date/promised-vs-completed benchmark (Section 3), then a post-check | L | A |
| 8 | **D11** Ask cites resolve to the transcript line; drop uncited sentences (changes `AskerTest.kt:48`) | M | A/D |
| 9 | Source links from Threads and the worklist carry the moment (§4-A) | S | A/D |
| 10 | **D12** Search relevance floor — measure the cosine distribution first, then filter before fusion; strip "— Unassigned" | M | A |
| 11 | **D03** Lapsed card unreachable after D02 — route the "server said no" state to Check again/Manage | S | A/B |
| 12 | **D09** Settings model rows clear on download completion from any screen | S | A |
| 13 | **D26** `mergeSpeakers` in one transaction, with `edits` rows; add a DB test | S | A |
| 14 | **N02** Retry ETA overstated until first stage event | S | A |
| 15 | **D16** First line missing — needs a phone recording with the clip vs the imported file | M | A |
| 16 | **D17** "comma" → "Kama" dictation alias | S | A |
| 17 | **D18, D19, D20, D21** small copy/layout items (dictation title; Free summary card paths; sheet scroll cue; model-row clip) | S each | D |
| 18 | **N05** Guard the capture loop's `flush()` on a full disk | S | A |
| 19 | **N04** All 15-minute copy (lands with the allowance, Task 9, plus store/landing/play-console) | M | B |
| 20 | **D46** Push the 49 commits | S | founder |

**AWAITING-DEVICE next** (one device day on a low-memory phone plus a newer one; plan §6 lists the same coverage)

| Pri | Item | Size | Workstream |
|---|---|---|---|
| 1 | **D05, D24, D31, D32, D33** Free-limit stop and non-Stop endings, screen-off, tile Stop (PB §7.1-7.3) | M | A |
| 2 | **D04, D06, D34** Announcement outcome and clip-leak wiring; add the missing wiring test for `setAnnouncedLag` | M | A |
| 3 | **D25, N03** Crash path and `recoverOrphanedRecordings` — add tests, then a force-stop run | M | A |
| 4 | **D30** Write it again / type change on a real Pro phone | S | D |
| 5 | **D43, §4-A storage + interruption** Mic lost, disk full, call interruption; decide whether to persist a gap marker | M | A |
| 6 | **D45** 90-minute capture (overnight) | M | A |
| 7 | **D36-D38, D42** Billing offline/slow-card/restore/reinstall; backup flow (needs a phone without real meetings) | M | B |
| 8 | **D39, D40, D41** Speaker merge with two real voices; remembered-voice steps 3 and 5; whisper-small run | M | A |
| 9 | **§4-A progress/ETA, thermal, retry** on a current phone (ASR counts, battery pause, a 90-minute ETA) | M | A |
| 10 | **D02, D03, D35** Lapsed flow and waiting-vs-no-speech on the phone | S | A |


## 2. Allowance policy examples

**Source of truth:** plan §3 (`docs/PRODUCT_IMPROVEMENT_PLAN_2026-10.md` L49–90). This section does not redesign it. Each row is something QA can run; where §3 does not settle the outcome the row says **GAP-n** and the "Policy gaps" list below it carries the question.

**How far the allowance is actually built (checked 7 Oct, `git log`, grep).** The brief calls the allowance design "already done". The *design* is; the *implementation* is two of ten tasks. **None of it is on `main`.** It lives on the unmerged branch `free-allowance` (4 commits ahead of `main`: plan `322c947`, `AllowancePolicy.kt` pure rules `e3531da`, `Allowance.kt` reserve/commit/refund/settle over a store `78c91f3`, plan fix `4274da1`), both Kotlin files with JVM tests (9 + 9), and **nothing calls either of them** outside their tests (`grep` finds no production reference). The allowance plan file itself exists only on that branch too (`git show free-allowance:docs/superpowers/plans/2026-10-07-free-allowance-native.md`). Tasks 3–10 of the allowance plan (`2026-10-07-free-allowance-native.md`) — the `allowance` table, backup merge, native reserve in `CaptureController.start`, the one-hour cap, commit/refund wiring, import, JS copy — are unticked and unbuilt. The live Free policy is still 15 minutes with a 3-minute warning. So every "expected outcome" below is the **target**, and a QA run today will fail all of them; the rightmost column of the table says which rows the built core already satisfies at the unit level.

**Notation.** The month under test is October 2026 unless stated; a Free user unless stated. Ledger entries: **C** = committed, **R** = reserved, **X** = refunded (X never counts). *Slots left* = 5 − (C + R) in the period the allowance is read in. "Unit" = already asserted by `AllowancePolicyTest` / `AllowanceTest` (read, not mutated by me); "—" = nothing exists yet; "device" = can only be proven on a phone.

| # | Scenario | Starting ledger | Action | Expected outcome (per §3) | Slots left | Basis · built? |
|---|---|---|---|---|---|---|
| 1 | First session of the month | Oct: empty | Start a meeting recording, speak for 90 s, Stop | Slot reserved before capture starts; at ≥ 60 s of captured audio it is committed. Processing runs. | 4 | §3 L64 · unit (policy/service) |
| 2 | **5th session** | Oct: 4C | Start a meeting recording | Granted. The reservation takes the last slot *as soon as capture starts*. Stop at 5 min → committed. | 0 (after start, and after commit) | §3 L64 · unit · GAP-3 for what the screen says while it runs |
| 3 | **6th session — Record screen** | Oct: 5C | Tap Start recording | Refused natively **before** capture starts (no audio, no meeting row). Exhausted copy: "You've used your 5 free meetings this month. Your saved meetings are still available. Get Pro for more meetings, or record again from 1 November." Offer Pro. | 0 | §3 L59, L64 · unit (`decide` → Denied with reset date) |
| 4 | 6th session — tile / shortcut | Oct: 5C | Start from the Quick Settings tile, with the app killed | Same refusal; tile opens the app to the exhausted state. No capture. (Today the tile passes no cap at all — see §1 finding D44.) | 0 | §3 L65, L87 · device |
| 5 | 6th session — dictation | Oct: 5C | Start Dictation mode | Refused exactly as a meeting; dictation has no separate route. | 0 | §3 L63 · — |
| 6 | **Accidental 10-second tap** | Oct: 2C | Start, Stop after 10 s, silence in the room | Reservation taken at Start (slots shown: 2); no usable transcript → **refunded** once processing has finished, so no slot is lost. The recording is shown as empty or removed. | 3 | §3 L65 · unit (`settleAction`: short, done, no transcript → REFUND) · GAP-1, GAP-3 |
| 7 | Short session that *does* have words | Oct: 2C | Dictate "Call Priya at five" (8 s), Stop | Short, but the transcript is usable → **committed**. | 2 | §3 L64 · unit · **GAP-1** (what is "usable"?), and see GAP-2 about 8-second notes burning a slot |
| 8 | **A 61-second recording** | Oct: 2C | Record 61 s of speech, Stop | Committed at the 60-second line whatever processing does. | 2 | §3 L64 · unit (`COMMIT_AFTER_MS`, boundary) |
| 9 | 59-second recording, processing crashes | Oct: 2C | Record 59 s, Stop; force the pipeline to fail | §3 says a *longer* retained recording consumes a slot even if processing fails, and an accidental short one with no usable transcript is refunded. 59 s is neither clearly. Built core: `processingDone` (error counts as done) + no transcript → **REFUND**. | 3 (built core) / 2 (if "retained" wins) | **GAP-2** |
| 10 | **Retry processing** | Oct: 2C + the 61-s meeting (3C), status failed | Tap *Try again* (and later *Write it again*, and *Process now*) | No new slot, however many retries; committed status unchanged. | 2 | §3 L66 · unit for the ledger half (`the same session id twice takes one slot`; `refund … never un-commits`); the retry UI path is — |
| 11 | **Delete a counted meeting** | Oct: 5C | Delete one meeting (named confirm); then archive another | Slot is **not** returned; ledger row stays after the meeting row is gone. | 0 | §3 L67 · — |
| 12 | Delete a refunded (empty) meeting | Oct: 2C + 1X | "Clear empty recordings" | Nothing changes; the refunded row never counted. | 3 | §3 L65 · — |
| 13 | **Backup restore — same period, overlapping ids** | Local Oct: {a,b} C. Backup Oct: {b,c,d} C | Settings → Restore from backup | Ledger merged by stable id, not by adding totals: {a,b,c,d} = 4 used. | 1 | §3 L86 · — (Task 4 unbuilt) · GAP-9 for a state conflict on the same id |
| 14 | Backup restore — meetings but no ledger | Fresh install, Oct: empty. Backup holds 5 Oct meeting rows from before the migration | Restore | Restoring does not recount historical meetings as new sessions: nothing is charged. | 5 | §3 L67, L89 · — |
| 15 | Reinstall / data cleared, no backup | Oct: 5C then Clear data | Reinstall, start recording | Ledger is gone; five fresh slots. **Accepted limitation**; no sign-in added to prevent it. | 5 | §3 L88 · device (accepted) |
| 16 | **Month boundary, mid-recording** | Oct: 4C | Start 31 Oct 23:50 (5th slot, period Oct), keep recording through 00:00, stop 00:20 on 1 Nov | Not stopped at midnight. Attributed to October. On 1 Nov the November period opens with five slots. | Oct: 0 · Nov: 5 | §3 L69 · unit (`periodOf`, no rollover) · device for the no-stop part |
| 17 | Month boundary — exhausted at 23:59 | Oct: 5C | Try to start 31 Oct 23:59, retry 1 Nov 00:01 | First refused with "record again from 1 November"; second granted. | Nov: 4 after start | §3 L59, L62 · unit |
| 18 | **Clock moved back** | Oct: 5C | Set the device date to 15 Sep, start recording | Still October's tally → refused, reset date still 1 Nov. No second reset. Saved meetings stay fully available. | 0 | §3 L88 · unit (`effectivePeriod`) |
| 19 | Clock wound **forward then corrected** | Oct: 0 used. Clock set to 10 Jan 2027 (session recorded and committed in Jan), then set back to 7 Oct | Start recordings; use 4 more | Built core reads the allowance in the *later* period (2027-01): 1 used + 4 more → exhausted, and the displayed reset date is 1 Feb 2027. A single clock excursion therefore blocks new recordings for months. §3 asks both "no second reset" and "never lock users out of saved content" — saved content stays open, but new recording does not. | 0 (built core) | Derived by reading `effectivePeriod`; **no test covers it** · **GAP-8** — needs a decision |
| 20 | Time-zone change across the boundary | Oct: 5C; Nov: empty. User in Asia/Kolkata at 1 Nov 02:00 local records a session (committed in Nov); then flies west so local time is 31 Oct 13:30 | Start another recording | Entries keep their stored period; the effective period stays the latest counted one (Nov). Reads Nov's tally (1 used). | 4 | §3 L68, L88 · unit (zone test) · §3 silent on travel → GAP-8 |
| 21 | **Pro expiring mid-month** | Oct: 3C (Free, before buying) → 9 sessions as Pro (no ledger rows) → Pro lapses 20 Oct | Start a recording on 21 Oct | Pro sessions took no slot. The user gets the remaining Free allowance for October — not a reset. | 2 | §3 L90 · unit (`reserve` with `paid`=true writes nothing) |
| 22 | Pro expiry **during** a recording | Oct: 1C. Recording began as Pro at 10:00; Pro lapses 10:20; recording continues to 11:30 | Keep recording | Not stopped at 60 min; ends at 90 min and is processed. It began under Pro, so no slot is taken; expiry applies to the next session. | 4 (unchanged) | §3 L79 · — (Task 5/6 unbuilt) · device · see GAP-5 for "began with Pro" while offline |
| 23 | **Upgrade during a recording — verified** | Oct: 2C. Free recording at 54:00 (warning showing) | Buy Pro; server verifies at 55:30 | Cap lifted with no restart; recording runs past 60:00, countdown/notification/PiP stop showing "left on Free". | 2 if the slot stays, 3 if it is released | §3 L78 · — · **GAP-4** (slot taken at start as Free — kept or released?) |
| 24 | Upgrade during a recording — pending / cancelled | Oct: 2C. Free recording at 54:00 | Start a purchase, leave Play pending (or cancel) | The cap is **not** lifted. At 60:00 the recording stops, is kept and processed. | 2 | §3 L78 · — |
| 25 | **Paused 60-minute recording** | Oct: 1C | Record 40 min, Pause 30 min (screen off), Resume, record 20 min | Stops at **60:00 of captured audio** (≈ 90 min of wall clock), audio kept, processing queued automatically with no tap. One slot. | 3 | §3 L73–75 · — · device (screen-off, native enforcement) · GAP-6 for "exactly" |
| 26 | Warning cadence on a Free hour | Oct: 1C | Record past 55:00 and 59:00 with app foreground, screen off, PiP and notification | Warning at 5 minutes left, final-minute countdown at 1 minute, in the app, PiP and notification; Stop/Pause remain reachable at small screen and large text. | 3 | §3 L74, L76 · — · device (A07-1 shows this screen overflowed before) |
| 27 | Paused and forgotten | Oct: 1C | Record 5 min, Pause, leave the phone overnight | §3 is silent: there is no maximum pause. The reservation, microphone session and foreground service persist. | 3 until decided | **GAP-7** |
| 28 | **61-minute Free import** | Oct: 3C | Import a 61:00 file | Refused **before** accepting, with the one-hour explanation and a Pro offer. No truncation, no slot consumed, no meeting row. | 2 | §3 L77 · — (Task 8 unbuilt) · GAP-6 |
| 29 | Exactly-an-hour import | Oct: 3C | Import 60:00 file | Accepted, one slot, ≥ 60 s so committed. Boundary tolerance undefined. | 1 | §3 L77 · — · GAP-6 |
| 30 | **Import that fails to decode** | Oct: 3C | Import a corrupt .m4a / a truncated file | Slot reserved on accept, **refunded** on failure; no meeting left behind. | 2 | §3 L65 · — |
| 31 | Import cancelled in the picker | Oct: 3C | Open the picker, back out | Nothing reserved. | 2 | §3 L65 · — |
| 32 | Valid import, processing then fails | Oct: 3C | Import a 5-minute file; kill the app during ASR; relaunch; Try again | Slot committed at accept (≥ 60 s); processing resumes or retries free. | 1 | §3 L65–66 · — |
| 33 | Import decodes to silence | Oct: 3C | Import a 3-minute silent file | §3 says an "empty recording" is refunded but also that a longer retained recording consumes a slot. Built core: ≥ 60 s → COMMIT regardless of speech. | 1 (built core) | **GAP-2** |
| 34 | **Crash during recording** | Oct: 2C | Kill the app at 40 min of a Free recording; relaunch | Audio is recovered and processed; the abandoned reservation is settled from the file on disk → committed (≥ 60 s). No second slot for the resumed work. | 2 | §3 L66, L84 · unit (settle) · device |
| 35 | Crash at 20 seconds | Oct: 2C | Kill the app at 20 s; relaunch | Reservation settles from the file: < 60 s → waits for the transcript, then commit or refund. | 2 or 3 | §3 L84 · GAP-1/3 |
| 36 | **Duplicate start event** | Oct: 4C | Double-tap Start / start from tile and app within a second | One session, one reservation (same session id); only one meeting row. | 0 after one start | §3 L64, L84 · unit (`reserve` is idempotent per id) |
| 37 | Two starters race for the last slot | Oct: 4C | Tile and in-app start simultaneously | Exactly one granted; the other refused as exhausted. | 0 | §3 L64 · unit (atomic) · device for true concurrency |
| 38 | Sample meeting | Oct: 5C | Open the sample; play, search, share it | Allowed; consumes nothing, remains available when exhausted. | 0 | §3 L68 · — (no sample exists yet) |
| 39 | Exhausted, still usable | Oct: 5C | Listen, search, edit, share, export, archive/restore, back up, restore | All remain available. | 0 | §3 L68 · device |
| 40 | Upgrade after exhaustion | Oct: 5C | Buy Pro, start recording | Granted, unlimited; no slot written. After a later lapse, Free reads 0 until the reset. | 0 on lapse | §3 L90 · unit |
| 41 | Play free-trial session | Oct: 5C | Active 7-day trial, start a recording | Trial counts as Pro: no slot, no cap. | 0 | §3 L90 · — |
| 42 | **Migration** | Update installed 20 Oct with 12 existing Oct meetings | First launch after the update | New period begins with five available; no retro-charge; all saved content and prior Pro output kept after downgrade. | 5 | §3 L89 · — |
| 43 | Disk full at start | Oct: 3C, storage 0 free | Start recording | Reservation taken then **refunded** because nothing is captured; user told why. (§3 silent on order of the checks.) | 2 | §3 L65 · **GAP-10** · device |
| 44 | Disk fills mid-session | Oct: 3C | Disk fills at minute 12 | Recording stops, audio kept, committed (≥ 60 s), explained. | 1 | §3 L65 · device |
| 45 | Migrated and re-restored on a later month | Backup taken in Sept with a Sept ledger; restore on 3 Oct | Restore | Ledger merged; Sept entries are in Sept and count against nothing in Oct. | 5 | §3 L86 · — |

**Rows the built core already asserts at unit level** (tests: `AllowancePolicyTest` 9, `AllowanceTest` 9): 2, 3, 6/8 (settle verdicts), 16 (`a recording that crosses into a new month is charged to the month it began in`), 17, 18, 20 (stored-period conversion only), 21 and 40 (`a paid session takes no slot`), 34/35 (settle verdict only), 36, 37 (atomic insert asserted; true concurrency is not). **Rows nothing in the repo can show yet:** everything with "—" in the Basis column, which is every end-to-end behaviour (cap, import, backup, UI).

### Policy gaps (not decided silently)

Each is a place where §3 is silent or two of its rules conflict. The product owner must pick; nothing here chooses.

- **GAP-1 — "usable transcript" is undefined** (§3 L64–65). The built core uses "at least one utterance". Is a transcript of "uh, hello" usable? Is a dictated note of 8 words? Rows 6, 7, 35.
- **GAP-2 — "empty recording" versus "a longer retained recording consumes a slot even if processing fails"** (§3 L65). A 3-minute recording of a muted microphone, an import that decodes to silence, and a 59-second recording whose processing crashed are each both "empty/no transcript" and "retained". Which rule wins? Also a short dictation (8 s) with real words consumes a whole slot: one in five of a month's allowance for a single sentence — a product consequence worth deciding on purpose. Rows 7, 9, 33.
- **GAP-3 — what the user sees while a slot is reserved but not yet committed.** A short session's refund waits for processing, which can queue behind other meetings for minutes (A07 measured 229 s in ~35 s on a good day). During that wait the slot is held, so a user could be told "0 left" because of an accidental tap that will be refunded. §3 does not say whether a reserved slot counts in the display. Rows 2, 6.
- **GAP-4 — a session that started as Free and is upgraded mid-recording** keeps or releases the slot it took (§3 L78 says only that the cap lifts). Row 23.
- **GAP-5 — "an active session began with Pro entitlement"** (§3 L79) needs a definition of Pro *at that instant*: the 3-day payment-grace token, an offline phone whose token cannot be refreshed, a pending purchase, a trial. Ties to the H1 fix, which treats a server "not entitled" as lapsed at once but keeps the token on network failure. Row 22.
- **GAP-6 — tolerance at 60:00.** §3 says "exactly 60 minutes of captured audio" (L73, plan §4-B) and the built plan checks at ≈ 1 s cadence; for imports the duration may come from a container header that variable-bit-rate files get wrong. Is 60:00.4 refused? Rows 25, 28, 29.
- **GAP-7 — no maximum pause** (§3 L66 only says pausing never consumes another slot). A recording paused for a day holds a slot, a microphone session and a foreground service. Row 27.
- **GAP-8 — the clock rules conflict.** §3 L88 forbids a second reset on a backward clock; the built core achieves that by reading "the later of now and the latest counted period" — so one forward-clock excursion pins the effective period in the future and can lock new recording until that month (row 19), and also shows a far-future reset date. §3 also says to avoid locking users out because of clock anomalies. Travel across time zones (row 20) is not mentioned at all.
- **GAP-9 — backup merge when the same id carries different states** (local REFUNDED vs backup COMMITTED, or the reverse). §3 L86 says "merge by stable id"; the implementation plan chooses "local wins" (`INSERT OR IGNORE`) but §3 does not. Also silent: a backup whose ledger is newer than the phone's clock.
- **GAP-10 — order of checks at start** (permission, storage, slot, entitlement). Row 43 depends on whether a slot is reserved before or after the disk check; §3 only requires reservation "before starting capture".
- **GAP-11 — import during an active recording**, and two imports at once. §3 says reservation is atomic but not whether concurrent sessions are allowed.
- **GAP-12 — wording versus rule.** The headline copy is "5 meetings each month" (§3 L57) but dictations and imports consume the same slots (L63); the plan itself says to use "sessions" in explanations. QA should decide whether the headline is acceptable to a user who dictates six notes and is told they have used "5 meetings".
- **GAP-13 — the 60-second commit line for imports.** §3 L64 says "captured" audio; an import is not captured. Row 29 assumes decoded length.
- **GAP-14 — Pro that never synced.** A Free-started session is entitled the moment a verified purchase lands; the plan does not say how long the app may keep recording as Free while verification is pending offline (cf. the "payment received" card from Phase A).


## 3. Quality benchmark protocol

**Purpose.** Plan §4-A asks for "a labelled real-meeting evaluation [that] records factual errors and missed/spurious actions", with numeric thresholds set *from the baseline* before release approval. This section proposes how to run that evaluation. It sets no thresholds.

### 3.1 What `eval/` measures today, and the gap

Verified by reading `eval/metrics/*.py`, `eval/run.py`, `eval/report.py` and running `python3 -m unittest discover -s eval/tests` (106 tests, all pass).

| Measured today | How |
|---|---|
| WER | `wer.py`: reference `truth.json` text vs the CLI transcript; counts of substitutions, deletions, insertions |
| DER and attribution | `der.py`, `attribution.py`: Hungarian-mapped speaker labels, 250 ms collar, overlap excluded and reported |
| Minutes recall / support | `mom.py` + `judge.py`: an LLM judge matches produced decisions/actions/questions to a hand-written `minutes.json`; reports recall, precision, `unsupported`, `invented` |
| Owner and due date on *matched* actions | `mom.py:130-138`; rendered by `report.py:135-141` |
| Speed, memory | `run.py` real-time factors, peak RSS |
| Judge trustworthiness | `calibrate.py`: a 20-item human-labelled sample; below 85% agreement the report prints "noise" instead of percentages |

| **Not** measured today | Why it matters here |
|---|---|
| Price / amount / currency accuracy, in items or prose | A07 defect 9 (`$499` for "four ninety nine") is invisible to `eval/` |
| Promised vs completed | No field exists. The evidence record's `status` is `open / qualified / contradicted / withdrawn` — a *later turn pushed back*, never "done" (`cpp/minutes/evidence_record.cpp:19`) |
| The prose summary | `mom.py:from_document` skips `kind == "summary"` explicitly; `eval/run.py` docstring says a prose metric is future work |
| Owner/due accuracy *in practice* | The code scores it, but all four committed AMI `minutes.json` files have **zero** owners and **zero** dues, so the denominators are 0. `real-neosym-2026-08-19` has only `minutes.todo.json`; `real-inperson-2026-08-25` is empty |
| Real-speech phrasing | The extractor misses of A07 defect 12 ("Rahul will recruit…", "before Wednesday") come from real whisper output; AMI references are abstractive. Eval cannot see them |
| Review-queue precision, date normalisation, Ask/search relevance, dictation | Covered by C++/Jest golden tests, not by `eval/` |
| Anything on the phone | `eval/` runs the desktop CLI. On-phone engines (whisper-base standard; a larger model and a 1.5B writer on Pro) are not what it scores |

**Also true today:** `eval/results/` holds 94 local run dirs, 7 with a minutes-judge block, and **no `calibration.json` in any of them** — the judge has never been calibrated, so every minutes number on disk is, by the harness's own rule, noise. `real-*` fixtures are gitignored in full (`.gitignore:91`), so a real meeting's audio and labels cannot be committed by accident.

### 3.2 How many meetings, and what mix

**Proposal: 24 real meetings, in a pilot of 12 first.** I could not find a basis in the repo for a fixed sample size, so this is reasoned, not measured: prices, dates, owners and commitments are rare events inside a meeting, and a rate is only readable when there are enough instances. Two rules fix the size from the data rather than from my guess:

1. **Count-first rule:** do not report a per-class error *rate* for any field class (price, date, owner, promised/completed, action recall) until the reference holds at least a stated minimum of instances of it; below that, report raw counts and the individual errors. The minimum is a protocol constant to be chosen by whoever owns the benchmark before the first run; I suggest it be no lower than 30 instances per class because below that a proportion's interval spans most of the range.
2. **Stop-when-stable rule:** keep adding meetings until the field-class counts above are met and a further round of meetings produces no new *kind* of error (§3.4).

The pilot of 12 exists to find the labelling and attribution problems cheaply before the other 12 are recorded. **If recruitment only reaches 12, call it a pilot, not a baseline.**

**Mix (the plan's target product is recurring, in-person English meetings):**

| Axis | Cover at least |
|---|---|
| Meeting type | stand-up; one-to-one; client/sales call (prices live here); planning/status (dates and owners live here); a site or informal meeting |
| Field density | at least a third deliberately **field-dense** (prices, deadlines, named owners) and at least a few **sparse** (to measure spurious items) |
| Length | short (≤ 15 min), mid, and several 45–60 min (the Free cap) |
| Room | 2–3 people at a table; 4–8 at a conference table; one noisy (HVAC, café) |
| Speakers | accents spanning the launch markets (US, UK, Indian, Australian/Singaporean — the last two are unmeasured today, `NEXT.md` item 4); at least two non-native speakers |
| Capture path | recorded **in the app** on phones, not only imported audio, because the first-line loss (A07 "lower") and screen-off paths only occur in capture |
| Devices | at least one low-memory phone (A07-class) and one newer phone |

Keep AMI/EdAcc as the regression set (they already give WER/DER); they cannot stand in for field accuracy because their minutes carry no owners or dues.

### 3.3 How to label

Label from the **audio**, not from our transcript. The existing `truth_draft` workflow corrects the app's own transcript, which the README itself says makes WER a lower bound (a plausible misread stays in the reference). That is acceptable for WER trending; it is the wrong anchor for factual-error counting, where the labeller must hear what was said.

**Two labellers per meeting, independently**, then a third person adjudicates disagreements. One meeting in four is labelled twice for agreement statistics (all of the pilot; sample thereafter). Labellers sit apart; they do not see the app's output until their labels are frozen.

Each meeting gets a new reference file, **`facts.json`** (next to `truth.json`), with:

- `prices[]` — `{span_ms, spoken, amount, currency, period}` where `spoken` is what was said ("four ninety nine a month") and `amount`/`currency`/`period` are the intended reading (4.99, local currency or "unspecified", month);
- `dates[]` — `{span_ms, spoken, resolved_date | null, relative_to}` ("Thursday" resolved against the meeting's real date; "before Wednesday" kept as a deadline, not a date);
- `commitments[]` — `{span_ms, text, owner | null, due_spoken | null, due_date | null, state}` where `state` is **`promised`** (future, still to do), **`completed`** (reported done — not an action), **`conditional`**, or **`withdrawn`**;
- `decisions[]` — `{span_ms, text}`;
- `owners_note` — free text where an owner is ambiguous, so the adjudicator can decide, not the scorer.

Each span points at the audio the claim rests on. That also gives the "source link" check for free (§3.4 item 7).

`facts.json` is hand-labelled. The scoring script reads it and never edits it.

### 3.4 How errors are counted

The unit is a **reference fact** (a labelled price, date, commitment, decision) and a **produced item** (something shown to the user). Run the pipeline and, for the subset on phones, take the app's actual exports as the "produced" side, because the user sees the export.

Per reference fact, exactly one outcome: **correct**, **wrong value**, **missing**. Per produced item with no reference counterpart: **spurious**. Prose sentences in an AI summary are scored sentence by sentence: **supported / unsupported / contradicted** against the transcript *and* the audio.

1. **Price** — wrong amount, currency, period or unit; "four ninety nine" read as 499 is one *wrong value*.
2. **Date** — absolute or relative wrongly resolved; a deadline shown as a date or vice versa; a date shown where none was spoken is *spurious*.
3. **Owner** — wrong person, assigned when no owner existed (invented), or unassigned when one was named. Record *where it was lost*: ASR (name misheard), diarization (right person, wrong speaker), the extractor, or name resolution after a rename (A07 defect 6).
4. **Promised vs completed** — three errors: a *completed* thing shown as open; a *promised* thing written as done or sent (A07 defect 9); a commitment missing.
5. **Action recall / precision** — a reference commitment with no produced counterpart is *missed*; a produced action with no commitment behind it is *spurious* ("Let's start the weekly check-in" is the known example).
6. **Match rule** — a produced item matches a reference item when a human adjudicator says it does. For the baseline the match is **human-adjudicated**, recorded in a `matches.json`, because an automated matcher is exactly the thing whose error rate is unknown. Once there are enough adjudicated matches, evaluate an automated matcher (the existing judge, after calibration) against them.
7. **Source links** — for every produced item that carries an anchor, does playback begin inside the reference span's neighbourhood? Count `resolves / resolves-to-wrong-moment / resolves-to-summary / no-anchor`. The tolerance is a protocol constant to be read off the histogram of the baseline itself, not guessed.
8. **Stage attribution** — every error carries the *first stage at which the truth was lost*: `asr`, `diarization`, `extractor-rules`, `classifier`, `writer`, `rename/resolution`, `export`. This is what turns "an error rate" into "targeted validation or review cues based on evidence", as §4-A asks.
9. **Severity** — **S1**: changes who does what, by when, or what was agreed (wrong owner, price, date, invented or missing commitment, promise shown as done). **S2**: wording or ordering. Report S1 separately; it is the number users will judge trust by.
10. **Review burden** — corrections a reader would make to the produced minutes, per meeting, split by whether the app already flagged the item for review (the review queue exists, `reviewRule.ts`) or the error was silent. A silent S1 is the worst case and is reported on its own line.

Report, per class and per cohort (device class, capture path, Free rule-based vs Pro writer): counts, the rate if the count-first rule is met, and an interval for it. No pass/fail.

### 3.5 The scoring script (to write, not written)

**Name:** `eval/score_facts.py`, run as `python3 -m eval.score_facts` (same style as `eval.run`, `eval.calibrate`).

- **Inputs:** `--fixture eval/fixtures/real-<id>/` (reads `facts.json`, `truth.json`); `--run <results dir or CLI --json output>` (the produced document: transcript, minutes, review flags); optionally `--export <file>` for an app export taken from a phone; `--matches matches.json` (the adjudicated reference↔produced pairs; if absent the script writes a `matches.todo.json` listing candidate pairs for a human to confirm and stops); `--summary-labels summary_labels.json` (sentence-level supported/unsupported/contradicted verdicts, hand-made).
- **Outputs:** `facts_score.json` per meeting (outcomes per fact and per produced item); `facts_errors.csv` (one row per error: meeting id, class, outcome, stage, severity, reference span, produced text, anchor result); an aggregate `facts_report.md` in the style of `report.py` — counts and intervals per class and cohort, with the count-first rule enforced by *refusing to print a rate* below the minimum, the same way the calibration gate prints "noise" instead of percentages.
- **Companion:** `eval/corpus/facts_label.py` with `export` / `import` verbs mirroring `truth_draft.py`, producing a labelling sheet and a validated `facts.json`; a second `agreement` verb comparing the two labellers.
- **Tests:** unit tests in `eval/tests/` for every outcome, the count-first refusal, and a mutation check per project habit (break a rule, a test must fail).

### 3.6 What must be true before any numeric threshold is set

1. The full set (§3.2) is recorded, labelled by two people, adjudicated, and the count-first minimum is met for every class a threshold will name. A class that misses the minimum gets **no** threshold, only a manual review step.
2. Labeller agreement has been measured and reported; unresolved disagreements are listed, not averaged away.
3. The judge, if used at all, is **calibrated** — today no run has a `calibration.json`. Until then use human matches only.
4. The same pipeline run twice on the same audio gives the same produced items (the harness assumes deterministic greedy decoding; confirm it, especially on the phone).
5. Desktop-CLI results and a phone export agree on a shared subset, or the differences are themselves reported — otherwise the baseline describes software users do not run.
6. The error taxonomy has stabilised: a round of new meetings yields no new kind of error.
7. The product owner has agreed which errors are S1 and, after the interview sessions (§4), what users say they will not tolerate. Thresholds are then set from the baseline distribution plus that — not before.
8. Fixes made after the baseline are measured on meetings that were **not** used to design them (hold out the pilot's meetings, or the second 12), or the improvement is a fitting result.

### 3.7 What needs a human, real recordings and consent

**Everything that makes this a "real-meeting" evaluation needs people; I cannot do any of it.**

- **Recruiting meeting owners** and getting **informed consent from every speaker** in each recorded meeting (the app already announces that it records; a research recording needs more than that). Consent must say where audio is stored, who hears it, retention, and that it is deleted on request.
- **Recording** the meetings on the real phones, in rooms, with real accents and noise.
- **Labelling** (two people who hear the audio; ~several hours per meeting-hour is a realistic planning allowance, unmeasured) and **adjudication**.
- **Hand-confirming the match pairs** for the baseline and the sentence-level summary verdicts.
- **Running the app on target phones** and taking the exports (this section assumes no device is touched by me).
- **Storage governance:** `real-*` fixtures stay out of git (they are ignored already); the audio of consenting participants must live on an encrypted, access-limited disk and be deleted on the schedule promised in consent. That schedule is a founder decision.
- **The founder's call** on whether any participant's audio may ever leave their machine — nothing in the product's privacy promise permits it for product measurement (plan §7, L207), so analysis must be local.

I can write `score_facts.py`, the labelling tool and its tests once the schema is agreed; I cannot supply the recordings, the consent or the labels.


## 4. Task-based interview kit

> **These sessions cannot be run by me, and nothing here has been run.** They need 5–8 real people who agree to take part, a facilitator who can sit with them, and a phone in their hands. This section is the kit: who to recruit, what to ask them to do, what to watch, what to say about their data, and a note sheet. Plan §7 (L221) sets the shape: *explore the sample, set up, record/import, find a decision, correct an owner, verify source audio, share*; observe completion and misunderstandings; do not treat positive comments as retention evidence.

**Two dependencies the current build does not meet.**
1. There is **no sample meeting in the app today** (`grep` for sample/demo meeting in `src/` finds nothing; it is plan §4-C work, Phase 2). Task 1 cannot test the real sample until it exists. Until then, run Task 1 on a *stand-in*: a meeting the facilitator pre-processes from the scripted audio below, labelled in the session notes as a stand-in. Its results say nothing about the real sample's onboarding value.
2. The tabs still read **"MOM"** and **"Script"** (`src/screens/MeetingScreen.tsx:1095-1096`); plan §4-D renames them. A session run before that rename measures the old labels — which is useful as a baseline for the rename, provided the notes record which build was shown.

### 4.1 Who to recruit (5–8 people)

**Must have**
- Attends a recurring **in-person**, English-language meeting at least weekly (stand-up, client call, site meeting, one-to-one, committee) — the plan's target (§4-E).
- Is responsible for follow-up from it: takes the notes, sends the actions, or chases the owners.
- Uses an **Android** phone they would be willing to bring (Android is the launch platform). Offer a loaner (a low-memory phone) for the participants who prefer it.
- Has **not** seen Verbale before, and does not work for or with the team.

**Mix across the group** (so a lone profile cannot dominate)
- At least 2 on a low-memory phone (about 4 GB) and at least 2 on a newer one — device fit is a core finding.
- At least 2 who are not native English speakers, and a spread of accents — the launch is global.
- At least 2 who currently take notes by hand or in a notes app, and at least 2 who have tried an AI notes tool.
- At least 1 who uses **large text or a screen reader** (plan §4-D acceptance names both).
- A mix of roles: team lead/manager, independent consultant/founder, operations or project coordinator, and a non-office setting (site, clinic admin, school) if reachable.

**Screen out:** employees, contractors and relatives of the team; people whose employer forbids recording tools; anyone who would only talk about a recording of a *real* meeting (see the consent note: real content is not used).

**Screener questions (one page):** how often are you in a meeting in person; who writes it up; what phone, how much memory; which notes tools you use; first language; do you use large text / a screen reader; may we put a scripted scenario in front of you on your phone.

**Logistics:** 45–60 minutes each; one facilitator and one note-taker; a quiet room with a second person to play the other voice (the facilitator); incentive set by the founder. Recruiting, scheduling and the incentive are the founder's — I cannot do any of them.

### 4.2 The scenario (so no real meeting content is needed)

Use a scripted, fictional "Beta weekly check-in" read aloud by the facilitator and the participant (one each), ~3 minutes, containing: one decision ("we go with the Thursday release"), one price ("four ninety-nine a month"), three actions with owners and due dates ("Samantha will send the pricing deck by Friday"; "Rahul will recruit ten testers before Wednesday"; one with no owner), one item that is *completed* ("I already sent the invoice"), one correction target (an action whose owner the app may well label "Speaker 2" or leave unassigned — note on the sheet what it actually did). Record the same script once per session so every participant gets comparable errors. **The script is the A07 pass's own wording on purpose — it re-tests known extractor misses.** Prepare a matching audio file for the import branch of Task 3.

### 4.3 Task script

Say before starting: "We are testing the app, not you. Please think aloud. I will not help unless you are stuck for a full minute. If you want to stop, say so." Hint ladder if stuck: (1) re-read the task; (2) "what would you expect to see?"; (3) point to the area of the screen; (4) show — and record "assisted".

| # | Task (what the participant is told) | Done when | Watch for |
|---|---|---|---|
| T1 | "You have just installed this. Before you record anything, see what it produces." (Stand-in sample, see dependency 1) | They have opened the example notes and can say, in their own words, what the app gives them | Do they find the example without help? Do they understand it is an example? Do they read the decisions/actions or only the length? |
| T2 | "Get the app ready to record your own meeting." | The recorder opens after setup | Download-size reaction ("X MB"), whether they pick a model unprompted, whether they find an upgrade path they did not need, and whether they can state the Free limit afterwards (ask: *how many meetings do you think you get? how long can one be?*) |
| T3 | "Record this meeting" (read the script aloud, ~3 min, phone on the table, screen locked part-way) — **or**, if the facilitator chooses, "import this file". | A processed meeting appears | Screen-off behaviour; whether they press Stop or use the notification/PiP; reaction to waiting; what they say the ETA means; whether the consent announcement surprises them |
| T4 | "Find the decision about the release date." | They can state the decision and the source line | Which tab they open first; whether Minutes/Transcript labels (MOM/Script today) make sense; where they look for Ask; use of search |
| T5 | "The action about the pricing deck has the wrong owner. Fix it." | Owner is changed and they confirm it | Long-press vs visible edit control; where they expect speaker naming to live; whether the new owner shows everywhere (Actions tab, Minutes, a re-opened meeting) — A07 defect 6 is the known failure here |
| T6 | "How would you know this decision was really said?" | They have played the audio from that item | Whether source-audio links are discovered unprompted; whether the audio lands on the right moment; whether they trust the item more or less afterwards |
| T7 | "Send these notes to a colleague (use yourself)." | The share sheet / export has produced something they would send | Preview expectations; whether they notice unresolved or missing owners/dates; whether the output makes sense to someone who was not there (show it to the note-taker cold and ask what it says) |
| T8 | After a second recording, only if time: "Record one more." | — | Allowance understanding: do they notice remaining-meetings copy, when does the count matter to them |

Close with five questions: What was the most confusing moment? What would you want checked before you forwarded this? Would you use it for the next meeting — why or why not? What do you think happens to the recording? What do you think this should cost, and why? **Record the answers as opinions, not as evidence of retention.**

### 4.4 What to observe (record per task)

- **Outcome:** completed unaided / completed with hint level n / failed / abandoned.
- **Time on task** (approximate) and the number of wrong turns.
- **Hesitations and verbalised misunderstandings**, verbatim where possible.
- **Errors the app made that the participant noticed or missed** (price, date, owner, a completed thing shown as open) — this feeds Section 3.
- **Device events:** a crash, a stall, thermal pause, a blank screen, text clipped at large font.
- **Claims versus behaviour:** where what they say about the Free limit or privacy differs from what the screens say.
- Do **not** count praise as a result, and do not ask leading questions ("was that easy?").

### 4.5 Consent wording

Read it aloud and give a copy; record a yes in the note sheet. Wording is for the founder to confirm with whoever advises on privacy before use; I am not a lawyer and this is not legal text.

> **Why we are here.** We're testing a phone app that turns a meeting recording into written notes. We want to learn where it is confusing — we are testing the app, not you.
>
> **What you'll do.** About 45 to 60 minutes, you'll try a few tasks on a phone while thinking aloud. We'll use a short, made-up meeting script, so you don't need to bring or share anything from your own work.
>
> **Your meeting content stays on the device.** The app does all its work on the phone. We will not upload, copy off the phone, or keep any audio, transcript or notes from the session. Please don't read from, or record, a real meeting, a real colleague or anything confidential.
>
> **What we do record.** We will take handwritten notes about what you did and said about the app. [Choose one: no screen recording / the facilitator watches the phone screen but nothing is saved / the screen is recorded to this laptop, shows only the made-up script, and is deleted by [date set by the founder].] We won't record your face or voice unless you say yes below.
>
> **What we keep.** Your name stays separate from the notes; notes use a number such as P3. We'll keep the notes for [period the founder sets] and then delete them.
>
> **Voluntary.** You can skip a task, stop at any time, or ask us to delete your notes, without giving a reason and without losing your incentive.
>
> **Questions** go to [contact the founder provides].
>
> ☐ I agree to take part. ☐ I agree to the optional voice recording of my comments (optional). Name / signature / date.

The things I could not fill in: the retention period, the contact, the incentive, whether screen mirroring is acceptable (mirroring moves screen content to a laptop; with only the scripted scenario on screen that fits "meeting content stays on the device" — with a participant's real content it would not). Those are the founder's.

### 4.6 One-page note template

```
Participant P__   Date ____   Facilitator ____   Note-taker ____
Build shown (version / MOM-Script labels or Minutes-Transcript) ____
Phone model / memory ____   Android ____   Font size: default / large   Screen reader: Y / N
Profile (role, meetings/week, notes tool, first language) ______________________
Consent: ☐ verbal yes recorded  ☐ screen visible only  ☐ nothing recorded

Task    Outcome (U / H1-H4 / F / A)    Time    Wrong turns    Quote / what happened
T1 Sample
T2 Set-up   Said Free limit was: __________________  (actual: __________)
T3 Record/import
T4 Find decision
T5 Fix owner     New owner visible in: Actions ☐  Minutes ☐  after reopening ☐
T6 Verify audio  Audio began at right moment  ☐ Y ☐ N
T7 Share         Understood cold by a reader  ☐ Y ☐ N  Missing/invented fields: ______
T8 Second record

App errors noticed by participant:   price ☐  date ☐  owner ☐  done-vs-open ☐   other ______
App errors the participant MISSED (note-taker checks against the script):  ______________
Device events (crash / stall / heat / clipped text): __________________
Misunderstandings (their words):  ___________________________________________

Closing answers: most confusing ______  check before forwarding ______  next meeting? ______
What happens to the recording (their belief) ______  Price guess ______

Top 3 issues (facilitator, within 30 minutes of finishing): 1) ____ 2) ____ 3) ____
Severity: blocker / major / minor / cosmetic        Follow-up needed: ____
```

**After the sessions:** one affinity pass across the notes (issues by task, count of participants hit), a table of task completion, and a list of app errors found and missed. Numbers from 5–8 people are counts, not rates; report them as counts.

---

## Summary

### Counts per status (Section 1.1; 53 rows: 48 from the September documents, 5 additional)

| Status | Rows |
|---|---|
| FIXED | 5 — D02, D27, D28, D29, D35 |
| AWAITING-DEVICE | 19 |
| UNRESOLVED | 25 |
| NOT-REPRODUCIBLE-FROM-CODE | 4 — D08, D22, D23, D45 |

Of the five FIXED, only D02 is a product defect from the A07; D28 and D29 are test and doc notes, D27 is the merge confirm, D35 is display logic. **Of A07's 13 numbered defects, one (D02, lapsed subscription) is FIXED in code with a test, and even that has a consequence (D03) that makes its intended UI unreachable.** Five more are Play Console or ops state (defects 7 and 13: D08, D22, D23) or code-fixed but unrun on a phone (defects 3, 4, 5: D04, D05, D06). Seven are untouched (defects 1, 6, 8, 9, 10, 11, 12).

The §4-A "Deliverables" answers (Section 1.2): AWAITING-DEVICE ×5 (free-limit stop, notification/PiP/tile stop, process death, interruption, storage failure) plus the progress/ETA/thermal/retry bullet; UNRESOLVED ×3 (source links, speaker rename propagation, transcript-correction propagation). None is FIXED.

### The three biggest risks

1. **The Free limit is not enforced where the plan says it must be, and the allowance work that would fix it is unmerged.** JavaScript passes the cap; the tile and shortcut pass none (`ShimActivity.kt:68`); the cap lands about 35 s late; only two of eleven allowance tasks exist, on `free-allowance`, with no caller. Every Workstream B acceptance criterion depends on the other nine, and the policy itself has fourteen unresolved questions (Section 2), several of which change what is built (a short dictation costs a slot; one clock excursion can lock recording for months).
2. **"Nothing lost" is unproven on hardware.** All of Phase B — the end notice, background processing start, the `failed` state, the clip-leak wiring — is JVM or jest tested at the pure-function level only, with no phone run since the code landed. Specific untested links: the background `enqueue` from `onDestroy` screen-off, `markFailed`, `recoverOrphanedRecordings`, `setAnnouncedLag`, a full-disk `flush`. The device that did the A07 holds the founder's only real meeting and could not be wiped for restore tests, and the Pixel is dead.
3. **The output-trust defects are open and the benchmark to measure them does not exist.** Owners stay stale after a rename on every surface but one; a correction reaches neither items nor the search index and is deleted by Redo; the extractor still gets all three of A07's cases wrong; the writer has no fact check; Ask cites a "Minutes · 0:00" placeholder. Meanwhile `eval/` has no price or promised-vs-completed metric, its owner/due denominators are zero, and no judge calibration was ever recorded, so numeric thresholds cannot honestly be set yet.

### Where the plan contradicts the code today

- **"Status: planning baseline; app changes have not been implemented"** and the brief's "the allowance design; already done": the design is complete; the code is two of eleven tasks, on a side branch, not wired in. Plan §3's "Native capture/import checks are authoritative" describes what is *to be* built — today JavaScript is the only decider and a native entry point bypasses it.
- **Plan §3 imports:** "For Free imports longer than 60 minutes, explain the limit" — today imports have no Free duration cap at all (`AudioImport.kt` has only a disk floor; `useImport.ts` has no check).
- **Plan §4-A "source links for … Ask answers resolve to the transcript moment and audio":** Ask only scrolls the transcript; it never plays audio. Some cites resolve to a placeholder.
- **Plan §4-A "Make transcript corrections update affected derived items" and "speaker renaming propagates … exports"**, with the fix plan's mechanisms: the fix plan's "re-run `db.ensureItems`" cannot do it (it only migrates meetings with no items and reads raw text), and its "stored text is left alone (exports keep working)" cannot give correct owners in exports.
- **Plan §4-A "processing progress/ETA … honest":** the fix plan and `NEXT.md` call the ETA device-verified; the device report says ASR window counts were never seen on the phone, the battery pause is unit-test only, and the Pixel it ran on is dead.
- **Fix plan H1** expected the lapsed card to appear after the fix; the code lands on the Free upsell instead (D03). The H1 fix is `store('', null)`, not the planned `clear()`.
- **A07 "model row misses its completion event":** there is no completion event; the defect applies only to downloads started from another screen.
- **A07 "overflow sheet hides Archive/Delete"** and the Android-15 text-clip theme fix both predate the A07 build; only the scroll cue is missing and the clipped "· 100%" is a different, still-open overflow bug.
- **"Prices ₹300/₹2,500" and "MP3" in the Play benefits list:** the repo is clean; the stale text is only in Play Console, which I cannot see. Repo copy that *is* stale is the 15-minute wording (N04).
- **`FP §6` "31+ commits unpushed":** 49 on `main` (local ref, not fetched).
- **Plan §1 "Expert review baseline 6.5/10 … not customer research or a fresh device test":** nothing in this baseline changes that; the first fresh device evidence the plan asks for still has to be gathered (Sections 1.3, 3, 4).

### What needs a human

Everything marked AWAITING-DEVICE; the labelled real-meeting evaluation (recordings, consent, two labellers, adjudication — Section 3.7); the 5–8 interview sessions (recruiting, consent, facilitation — Section 4); the policy decisions in Section 2; and the founder-only items (Play Console prices and benefits, the mirror re-run, the push, and whether to merge `free-allowance`).
