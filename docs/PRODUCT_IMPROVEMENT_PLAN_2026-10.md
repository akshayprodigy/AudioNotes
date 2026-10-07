# Verbale product improvement plan

Date: 7 October 2026  
Status: **revision 2 (7 October 2026, after the Phase 0 baseline)**. Revision 1 text is kept; changes are marked **[R2]**. App changes beyond two unwired allowance building blocks have not been implemented.  
Purpose: improve activation, trust, repeat usage, and paid conversion.

**[R2] What Phase 0 found, in one paragraph.** The allowance design is complete but its code is two of ten tasks, on the unmerged branch `free-allowance`, and nothing calls it; the live app still enforces 15 minutes from JavaScript, and a Free recording started from the Quick Settings tile has no cap. None of the Phase B fixes (25–26 Sep) has run on a phone. The trust defects that matter most (speaker rename, transcript corrections, extractor misses, writer facts, Ask citations) are open in code, and `eval/` cannot yet measure prices, dates, owners or promised-versus-completed. Evidence and file:line for every claim: `docs/superpowers/reports/2026-10-07-phase-0-baseline.md` (the "baseline report"). Everything that needs the founder, a phone or the Play Console is in `docs/FOUNDER_TODO_2026-10.md`.

## 1. Product direction and decisions

Build the easiest way to turn an in-person English meeting into private, trustworthy notes and clear follow-up.

The core journey is: understand the value → record → receive useful notes → check important details → share → complete commitments.

The founder approved replacing the 15-minute Free limit with a limited number of meetings, each no longer than one hour, and retaining premium features for Pro. This plan chooses **five meetings per calendar month, up to 60 minutes of captured audio per meeting**.

Five per month provides up to five hours of useful recording and roughly one recurring meeting per week. Five per week would provide roughly 20–25 meetings each month and could cover most of a regular user's needs before they have a reason to upgrade. This is a product hypothesis, not a measured conversion result. Revisit after observing complete monthly cohorts.

Keep English as the supported launch language, Android as the initial platform, and audio/text processing on the device. Additional languages, desktop, and iOS remain later work. Preserve the privacy promise, source-audio links, screen-off recording, PiP controls, and free export.

Expert review baseline: 6.5/10 overall. This is a qualitative assessment from code, screenshots, and existing reports, not customer research or a fresh device test.

## 2. Free and Pro packaging

| Capability | Free | Pro |
|---|---|---|
| New recordings and imported audio | Five sessions per calendar month, shared allowance | Unlimited sessions |
| Session duration | Maximum 60 minutes of captured audio | No commercial duration cap; device/storage limits still apply |
| Meeting and dictation modes | Included; both use the shared allowance | Included |
| Screen-off recording, PiP, pause, moment markers | Included | Included |
| English transcription | Standard model | Larger model where supported |
| Speaker separation and manual naming/correction | Included | Included |
| Extracted minutes, decisions, per-meeting actions | Included | Included |
| Playback, editing, manual notes/actions, archive | Included | Included |
| Basic keyword search across saved meetings | Included; newly moved out of Pro | Included |
| Existing export formats and sharing | Included | Included |
| Backup/restore and access to saved content | Included | Included |
| AI prose summaries and narrated minutes | — | Included on capable devices |
| Ask this meeting with transcript citations | — | Included on capable devices |
| Semantic search | — | Included |
| Remembered voices across meetings | — | Included, opt-in |
| Vocabulary/correction rules across meetings | — | Included |
| Project threads and decision history | — | Included |
| Action worklist across meetings | — | Included |
| Advanced follow-up digest and reminders | — | Planned Pro enhancement; advertise only after delivery |

Reliability, consent tools, accessibility, correction of individual meetings, and preservation of users' work are baseline capabilities. Do not sell them as premium benefits.

On phones unable to run the writer, describe the exact Pro benefits available before purchase. Do not promise a prose summary or Ask merely because a subscription can be purchased.

## 3. Allowance specification

The following edge-case rules are proposed implementation defaults under the approved five-session, one-hour policy.

### Monthly period and display

- Reset on the first day of each calendar month using the device's local calendar. No rollover of unused sessions.
- Show the concrete reset date and remaining allowance in Library, Record, import, Settings, and the paywall.
- Use clear copy: **“Free: 5 meetings each month · up to 1 hour each.”** Use “sessions” in explanatory text when covering dictation and imports.
- Example remaining-state copy: **“3 of 5 free meetings left · resets 1 November.”**
- Exhausted-state copy: **“You've used your 5 free meetings this month. Your saved meetings are still available. Get Pro for more meetings, or record again from 1 November.”**

### What consumes a session

- A new meeting recording, dictation, or imported audio file uses the same allowance. Do not create a separate import or dictation route around the limit.
- Reserve one slot atomically before starting capture or accepting an import. Commit the slot once the session has at least 60 seconds of captured audio, or a shorter session produces a usable transcript.
- Refund an accidental short session with no usable transcript, an empty recording, or a cancelled/invalid import. A longer retained recording consumes a slot even if processing fails; retrying it is free.
- Pausing/resuming the same recording, crash recovery, retrying processing, editing, and regenerating existing output never consume another slot.
- Deleting or archiving a counted meeting does not restore the allowance. Restoring a backup does not recount historical meetings as new sessions.
- A sample meeting does not consume allowance. Listening, searching, sharing, and editing remain available after exhaustion.
- If a recording crosses midnight into a new month, attribute it to the period when it began. Do not stop it at the reset boundary.

### One-hour limit

- Measure captured audio duration, excluding time paused. Enforce the boundary natively even when React Native is inactive.
- Show “up to 1 hour on Free” before recording. Warn with five minutes remaining, then a clear final-minute countdown in the app, PiP, and notification.
- Stop at 60 minutes, save the captured audio, and queue processing automatically. Never discard a recording to enforce the allowance.
- Keep Stop/Pause accessible when the warning or upgrade offer appears, including on small screens and with large text.
- For Free imports longer than 60 minutes, explain the limit before accepting the file. Offer Pro; do not silently truncate the file or consume a slot for a rejected import.
- A verified upgrade during capture removes the Free duration cap without restarting the recording. A cancelled or pending purchase does not remove it.
- If an active session began with Pro entitlement, retain its starting entitlement through that capture. Expiry applies to the next session; do not unexpectedly stop an ongoing paid meeting.

### Storage, offline operation, and migration

- Store an allowance ledger separately from meeting rows in encrypted local storage; use stable session IDs and transactional reservations to prevent double counting.
- Native capture/import checks are authoritative. JavaScript renders the same policy and usage; it must not be the only enforcement layer.
- Reconcile abandoned reservations from actual captured files and persisted session state after a crash.
- Keep the ledger through archive/delete and include it in backup/restore. Merge ledger entries by stable ID rather than adding totals.
- A backward device-clock or timezone change must not grant a second reset for an already-used month. Avoid locking users out of saved content because of clock anomalies.
- Free stays accountless and offline. Reinstall/data clearing and arbitrary forward clock changes cannot be perfectly prevented by a local-only quota. Accept this limitation for the initial release; do not introduce silent tracking or mandatory sign-in to solve it.
- On migration, start the new allowance period with five available sessions. Do not retroactively charge existing recordings. Preserve all saved content and previously generated Pro output after downgrade.
- Pro/trial sessions do not consume Free slots. If Pro expires during a month, the user receives the remaining Free allowance for that month, not a reset on every entitlement change.

### 3a. [R2] Gaps in the rules above, with proposed defaults

The baseline report (Section 2) worked 45 scenarios through the rules and found 14 places where this section is silent or two rules conflict. Each has a **proposed default** below. They are proposals, not decisions: the founder confirms them (`FOUNDER_TODO_2026-10.md` A2), and until then engineering builds the proposed default and flags it in the code. Scenario numbers refer to the baseline report.

| Gap | Question | Proposed default | Why |
|---|---|---|---|
| GAP-1 | What is a "usable transcript"? (rows 6, 7, 35) | At least one utterance of three or more words, after the transcription pass. Retune from the benchmark. | The built core says "at least one utterance"; a one-word cough should not take a slot. |
| GAP-2 | "Empty recording" is refunded but a longer retained recording consumes a slot even if processing fails. (rows 7, 9, 33) | *Empty* = no speech found by the speech-detection stage, at any length: refund. *Retained* = speech found and at least 60 s: counts even if processing then fails. A crash on a session under 60 s keeps the slot reserved until a retry completes. A short dictation with real words **does** take a slot (as written) — flagged because it lets one sentence cost one-fifth of a month. | Separates "nothing there" from "something there that failed". The dictation cost is the founder's call. |
| GAP-3 | What does the screen show while a slot is reserved but unsettled? (rows 2, 6) | Reserved counts as used. A session under 60 s settles right after the speech-detection stage (about 0.01× real time), not after full transcription, so an accidental tap returns its slot within seconds. | Avoids "0 left" for minutes because of a refundable tap. |
| GAP-4 | A Free session upgraded mid-way (row 23) | Keeps its slot. | No special case; Pro is unlimited anyway. |
| GAP-5 | What is "began with Pro"? (row 22) | A valid, unexpired licence on the phone at the instant of start. The payment-grace token counts until the server has said no (the lapsed-subscription fix). A pending purchase and an offline, unrefreshable expired token count as Free. | Offline-first, consistent with the licence design. |
| GAP-6 | Tolerance at 60:00 (rows 25, 28, 29) | Stop at 60:00 of captured audio; a one-second overrun is acceptable. An import is refused if its decoded length exceeds 60:00 + 1 s; if the container header is unreliable, decide after decode and before creating a meeting. | One second is the check cadence. |
| GAP-7 | No maximum pause (row 27) | After 30 minutes paused, the notification asks; after 60 minutes paused, the recording ends and is kept and queued. (Numbers are starting guesses.) | A forgotten pause should not hold a slot, a microphone session and a foreground service for a day. |
| GAP-8 | Backward-clock rule versus lock-out (rows 18–20) | Keep "no second reset on a backward clock". Read a counted session more than one month ahead of the phone's clock as belonging to the current month. Entries keep the period stored at reservation; travel across time zones never moves them. | Bounds any clock-excursion lock-out to the current month, which §3 already accepts as the cost of an accountless, offline ledger. |
| GAP-9 | Backup merge when one id has two states (row 13) | The state that uses more allowance wins (committed over reserved over refunded). | A restore can never create free slots. |
| GAP-10 | Order of checks at start (row 43) | Permission → storage → licence → take a slot → open the microphone. A start that fails after the slot is taken refunds it. | A failed start costs nothing. |
| GAP-11 | Concurrent sessions (imports during recording) | One session at a time. An import while recording is refused with "Finish recording first"; imports run one after another. | Simplest rule consistent with an atomic slot. |
| GAP-12 | "5 meetings" versus imports and dictations also counting | Keep the headline copy; add one line in the explanation: "Imports and dictations count as meetings." | §3 already says to use "sessions" in explanations. |
| GAP-13 | "Captured" audio for an import (row 29) | The import's decoded duration. | An import has no capture. |
| GAP-14 | Time between a purchase and its verification offline | Stays Free until verified; the existing "payment received" card remains; the cap lifts without restarting the recording when verification lands. | Matches §3 L78 and the Phase A purchase states. |

## 4. Workstreams and acceptance criteria

### 4.0 [R2] The fix list

Every issue in the baseline report's backlog is below with an id, the defects it closes (D-numbers are the report's), what to build, how it is proven, and a size guess (S under a day, M a few days, L a week or more of one engineer; guesses, not commitments). **Order matters:** items with a *needs* column cannot start before it. Items that need a person, a phone or the Play Console are in `FOUNDER_TODO_2026-10.md`.

**Phase 1a — close the holes** (the Free limit must be real before anything is built on it)

| Id | Closes | Build | Proof | Size | Needs |
|---|---|---|---|---|---|
| F01 | — | Review and merge `free-allowance` (policy and service code) into `main`. | Reviewer reads the four commits; JVM tests pass on `main`. | S | Founder A1 |
| F02 | D44 | Resolve the cap **natively** in `CaptureController.start` so the tile, shortcut, PiP and Record screen all get it; delete the JS-supplied `capMs`. | JVM test that no entry point can start uncapped; device test of a tile start on Free. | S | F01 |
| F03 | D15 | One-hour cap and five-minute warning enforced on the ~1 s cadence, not the ~33 s disk cadence. | `CapClockTest` and a cadence test; a paused 60-minute run stops at 60:00 ±1 s on a phone. | S | F01 |
| F04 | — | Ledger table in the encrypted DB, backup carries it (merge by id, GAP-9), commit/refund when capture and processing end, reconcile abandoned reservations after a crash, settle short sessions after the speech-detection stage (GAP-3). | JVM tests per rule; instrumented test of crash reconcile; the 45 baseline scenarios as the checklist. | M | F01, Founder A2 |
| F05 | — | Imports use the same allowance; refuse over-long Free imports **before** accepting; refund on decode failure. | Scenario rows 28–33 (unit + device). | M | F04 |
| F06 | N04 | JS stops deciding the cap and only renders; every 15-minute string in the app, tests, landing page source and docs replaced. | `git grep` for "15 min" finds only meeting *content*; copy tests updated. | S | F04 |
| F07 | D01 | Record screen: the Free-limit card replaces the mascot, the stage scrolls if needed, Stop stays reachable at 384×853 dp and large text; add the first `RecordScreen` test. | Test of Stop reachability; device check at large font. | M | — |
| F08 | — | Display: remaining and reset date in Library, Record, import, Settings and paywall; the exhausted state with saved work still open. | Copy tests; screenshots. | M | F04, Founder A2 (GAP-12) |
| F09 | — | Keyword search available to Free. | Gating test flips. | S | — |

**Phase 1b — prove what is already built**

| Id | Closes | Build | Proof | Size | Needs |
|---|---|---|---|---|---|
| F10 | D04, D25, N03, D24 | Add the missing tests: failure path (`markFailed` via an extracted, testable seam), `recoverOrphanedRecordings`, the `setAnnouncedLag` write and engine consumption, `RecordScreen`'s ending explanation, stop-then-enqueue. | New tests; one mutant each, per the house rule. | M | — |
| F11 | D05, D06, D24, D31–D34, D43, D45 | **Device pass 1** on a low-memory and a newer phone: Phase B by-hand list (PB §7.1–7.7), the full 60-minute Free recording screen-off with pause, PiP and notification controls, 5th/6th sessions, upgrade during a recording, storage full, mic lost, call interruption, force-stop mid-recording and mid-processing, tile start and stop. | Dated device report; each baseline row ticked or failed. | L | Founder C |
| F12 | D36–D38, D42 | Billing device scenarios: offline payment, slow card, restore after clearing data, reinstall ×3, backup/restore through Settings. | Dated device report. | M | Founder C |
| F13 | D05 | Persist the explanation of a non-Stop ending so a reopened Record screen still says why (one-time card until acknowledged). | Test; device check. | S | F10 |

**Phase 1c — trust fixes** (A07 defects still open; none has a commit)

| Id | Closes | Build | Proof | Size | Needs |
|---|---|---|---|---|---|
| F14 | D07 | Resolve an action's owner **live** from `owner_json` and the current speaker name on every surface: Actions tab, Minutes, cross-meeting worklist, Threads, search rows (and re-index on rename), exports; fix Speakers' "Regenerate". Stored text stays untouched. | One test per surface, including an export test that a rename appears on action lines. | L | — |
| F15 | D14, N01 | **Decide the design first (S):** make a correction write through to the transcript text (as the vocabulary path already does, keeping the raw text), then re-run the rule pass keeping ticks and hand-typed items, re-index and re-embed, and re-apply corrections after a re-transcription. Then build. | Test that a corrected line changes the derived action, keeps its tick, appears in search, and survives Redo. | L | — |
| F16 | D13a–c | Extractor: "Let's start/begin" is not an action; `<Name> will <verb>` for any verb when a date or object follows; "before <day>" is a due date. TS and C++ in lock-step, goldens regenerated (including the pinned "let's kick off" golden), each cue first recorded through whisper on a phone. | Golden tests in both ports; the A07 script re-run. | M | — |
| F17 | D11, §4-A | Ask: a citation resolves to the transcript line it came from, never "Minutes · 0:00"; an uncited sentence is dropped (per-sentence cite rule); Ask plays the audio; Threads and the worklist open the meeting **at the moment**. Update `AskerTest` that pins the old label. | Tests per link type; the A07 Ask case as a regression test. | M | F14 helps |
| F18 | D03 | Make the "server said no" state reachable as the lapsed card (Check again / Manage in Google Play), not the Free upsell. | Test chaining refresh → store('') → Summary. | S | — |
| F19 | D26 | `mergeSpeakers` in one transaction and recorded in `edits`, so re-diarization keeps it; add a DB-level test. | Test. | S | — |
| F20 | D09, D21 | Settings model rows clear and refresh when any screen finishes a download; the row wraps instead of clipping. | Test of a download started elsewhere; large-text check. | S | — |
| F21 | N02 | A retry or Redo shows "resuming" and no whole-pipeline ETA until the first stage event. | `progress.test.ts` case. | S | — |
| F22 | D16, D17, D18, D19, D20, N05 | Small batch: investigate the lost first line with a phone recording vs the imported file; "comma"/"Kama" alias in dictation; dictation title; Free summary card routing for the `checking` and error states; overflow-sheet scroll cue; guard the capture loop's `flush()` on a full disk. | One test each where testable. | M | — |

**Measurement first, then fix** (these must not be built from guesses)

| Id | Closes | Build | Proof | Size | Needs |
|---|---|---|---|---|---|
| F23 | §4-A "labelled evaluation" | Build the benchmark: `facts.json` schema, labelling tool, `eval/score_facts.py`, then record and label the 12-meeting pilot and the second 12 (Section 7a). | The protocol's own tests; a first baseline report. | L | Founder B, A3 |
| F24 | D10 | Writer fact post-check: every number, currency and date in a summary must be supported by the transcript, future-tense commitments stay future, unsupported sentences are dropped or flagged. Measure the baseline error first. | Benchmark before and after on meetings not used to design it. | L | F23 |
| F25 | D12 | Meaning-search relevance floor and stripped "— Unassigned". Measure the score distribution on the bench meetings first. | Test of the floor; before/after on the bench. | M | F23 or a measurement run |
| F26 | Interruption | Decide whether a call interruption writes a visible gap marker (the code's own comment promises one). If yes, build it. | Decision recorded; test. | S+M | Founder |

### A. Reliable capture and trustworthy results — P0

Problem: documented device failures can undermine the core promise even when the feature set is extensive. Several fixes already exist; verify their current behavior before adding duplicate work.

**[R2]** The reconciliation is done (baseline report §1: 53 rows — 5 FIXED, 19 AWAITING-DEVICE, 25 UNRESOLVED, 4 not reproducible from code). The work items are F07, F10–F22 and F23–F26 in §4.0; the deliverables below stay as the acceptance statement. Note two of them cannot be met by the fix plan's original mechanism: transcript corrections cannot be applied by re-running `ensureItems`, and rename in exports cannot work while the owner is baked into stored text (F14, F15).

Deliverables:

- Reconcile the September device findings with current code and label each fixed, awaiting device verification, or unresolved.
- Verify Free-limit stop, notification/PiP stop, process death, interruption, and storage failure preserve recoverable audio and explain the outcome accurately.
- Verify source links for decisions, actions, and Ask answers resolve to the transcript moment and audio, rather than a generated-summary placeholder.
- Measure errors in prices, dates, owners, and promised versus completed tasks. Add targeted validation or review cues based on evidence.
- Verify speaker renaming propagates to minutes, actions, threads, search, and exports.
- Make transcript corrections update affected derived items while preserving manual changes and completion state.
- Verify processing progress/ETA, thermal pauses, and retry states are honest and actionable.

Acceptance: no lost audio or unsupported success claims in the release scenarios; source timestamps resolve correctly; a labelled real-meeting evaluation records factual errors and missed/spurious actions. Set numeric quality thresholds from this baseline before release approval.

### B. New Free allowance and Pro packaging — P0

**[R2]** Work items F01–F09 in §4.0. The proposed defaults in §3a apply until the founder decides otherwise. The Quick Settings tile today bypasses the cap entirely; F02 closes it first.

Deliverables:

- Implement Section 3 across native recording, imports, database, entitlement handling, and UI.
- Replace all 15-minute policy/copy references, including PiP, notifications, onboarding, paywall, store materials, and relevant tests.
- Make keyword search available to Free while retaining semantic retrieval and other premium benefits for Pro.
- Add the remaining-meetings/reset-date display and an exhausted state that preserves access to saved work.
- Update upgrade messaging to lead with additional meetings and premium outcomes; keep trial terms and device limitations clear.

Acceptance: the sixth counted Free session is blocked; a paused session stops after exactly 60 minutes of captured audio; retries do not double charge; reset, migration, import, expiry, and offline scenarios pass. Verify screen-off enforcement on actual phones.

### C. Faster first value — P1

Deliverables:

- Add an offline, clearly labelled sample meeting with a summary, decisions, owners, due dates, and source links. Bundle only the small assets needed to demonstrate the experience.
- Make setup lead with one primary action: “Set up private recording — X MB.” Preserve an accessible Pro entry without requiring a plan decision before showing value.
- Reveal advanced writer/model choices when relevant; retain total download size and device-fit information before downloading.
- Explain English support and the Free allowance before the first real recording.
- Make “Start recording” open the recorder after successful setup.
- Provide resume/retry behavior and a clear readiness state after a skipped or incomplete essential download.

Acceptance: a new user can inspect sample output before downloading models; can identify download size and recording limits; and reaches a working recorder without guessing which model to select.

### D. Clearer results and navigation — P1

Deliverables:

- Rename “MOM” to “Minutes” and “Script” to “Transcript.”
- Lead with a concise takeaway, then actual decisions and next steps. Show useful item previews alongside counts.
- Give Ask a discoverable labelled entry and preserve visible source-audio links.
- Move “Write it again” to a secondary action. Provide visible editing affordances alongside long-press shortcuts.
- Use quieter surfaces for long reading while retaining the mascot and brand identity.
- Keep recording controls in a stable, reachable position during warnings; verify scrolling sheets and long titles.

Acceptance: users can find an action, correct its owner, check its source, and share notes without coaching. Verify small screens, large text, dark mode, and screen-reader navigation.

### E. Useful sharing and acquisition — P1

Deliverables:

- Offer a preview before sharing, with title/date, concise decisions, actions, owners/due dates, and unresolved details clearly indicated.
- Preserve existing export formats and free sharing. Evaluate DOCX only after testing whether target users need editable documents beyond existing formats.
- Offer an optional, discreet “Created with Verbale” attribution; it must not obscure the document.
- Align store screenshots and paywall copy with actual limits, features, and device capability. Replace “the moment it ends” unless measured processing supports it.
- Position the first campaign around recurring, in-person English meetings and private follow-up. Test whether recipients understand the exported document without context.

Acceptance: shared output matches the reviewed in-app content, does not invent missing owners/dates, and remains available when Free allowance is exhausted or Pro expires.

### F. Retention through follow-up — P2

Deliverables:

- Build on the existing Pro open-actions card with due/overdue actions, unresolved decisions, and notes awaiting review.
- Reduce capture-streak prominence. Prioritize completing commitments over recording every day.
- Add a discoverable “Add to project” flow over the existing tag/thread system.
- After core usage is established, test opt-in Pro reminders and a local digest. Ask for notification permission when the benefit is clear.

Acceptance: users can follow an action back to its source meeting and complete it; project setup is understandable without knowing that tags create threads; reminders respect explicit preferences.

## 5. Delivery sequence

**[R2] Revised.** Revision 1 gave six to eight weeks. Phase 0 shows that is not credible: the allowance is two of ten tasks, none of Phase B has run on a phone, five trust fixes are each a week or more, and the quality benchmark needs real recordings and consent that only people can supply. **Indicative sequence: nine to eleven weeks** for one implementation owner with product/design and device-QA support. These are planning estimates, not committed dates; accuracy work may take longer and must not be hidden by a calendar deadline. Item ids (F01…) are in §4.0; founder items (A–G) are in `docs/FOUNDER_TODO_2026-10.md`.

| Phase | Indicative window | Work | Exit condition |
|---|---|---|---|
| 0. Baseline and specifications | Week 1 — **done 7 Oct, except the parts that need people** | Defect audit, allowance worked examples, benchmark protocol, interview kit (baseline report) | Met: verified backlog and policy examples. **Not met:** quality baseline numbers and interview results — they need recordings, consent and participants (Phase 0b) |
| 0b. People and decisions (runs in parallel with Phase 1) | Weeks 2–6 | Founder confirms the allowance defaults (A2) and merge (A1); recruit interview participants and benchmark meeting owners; name roles; make phones available (F23 build; round-1 interviews on the current build) | Decisions recorded; 12 pilot meetings recorded and double-labelled; round-1 interview notes |
| 1a. Close the holes | Weeks 2–3 | F01–F09: merge the allowance code, native cap for every entry point (the tile hole), one-hour cap on the 1 s cadence, ledger, imports, copy, Record-screen layout, remaining/reset display, Free keyword search | Allowance scenario rows pass in unit tests; no entry point can start uncapped |
| 1b. Prove what is built | Week 4 | F10–F13: the missing tests, **device pass 1** on a low-memory and a newer phone, billing device scenarios | P0 acceptance scenarios pass on target phones, with a dated device report; every baseline AWAITING-DEVICE row ticked or failed |
| 1c. Trust fixes | Weeks 4–6 | F14–F22 (live owners, corrections, extractor, Ask citations and moment links, lapsed card, merge transaction, Settings rows, retry ETA, small batch); F23 benchmark build and pilot; F24, F25 only after their measurement | Each fix proven by its test and the A07 scenario re-run; first quality baseline published |
| 2. Improve activation and clarity | Weeks 7–8 | Sample meeting, onboarding, result hierarchy, labels, editing, sharing (Workstreams C, D, E) | Usability tasks pass (round-2 interviews on the new build, which includes the real sample) and no new recording regressions |
| 3. Package and release | Weeks 9–10 | Free/Pro copy, store assets, migration, release QA, the Play Console list (founder D) | App/store policy agrees; staged-release checklist complete |
| 4. Improve repeat usage | Week 11 onward | Follow-up home and project discovery; measure first cohorts | Evidence supports the next iteration |

Responsibilities: product owner maintains policy and priorities; design owner specifies flows/copy; engineering owns native enforcement and persistence; QA owns device scenarios; founder owns store/commercial updates and release decisions. Roles may be held by the same person. **Assign named owners before Phase 1a begins** (founder item A4).

## 6. Verification and release requirements

Meaningful automated coverage:

- Quota boundary at five sessions; atomic reservation and duplicate-event handling.
- Month change, recording across a boundary, clock rollback, and timezone changes.
- Accidental short capture, invalid/long import, failed processing, retry, deletion, and backup merge.
- One-hour captured-duration boundary, pauses, and entitlement changes.
- Upgrade/downgrade, existing-user migration, and preservation of saved output.

**[R2] Tests that are missing today and must exist before release** (each with a mutant, per the repository's house rule): the failure path that marks a meeting `failed` (`markFailed`); `recoverOrphanedRecordings`; the write of the announcement lag and its use by the engine; the Record screen's ending explanation and Stop reachability under the warning card; stop-then-enqueue from the notification, PiP and tile; native cap resolution for every start path; rename visible on every surface including exports; a correction that updates a derived action, survives Redo and keeps its tick; the Settings model row after a download finishes elsewhere; the lapsed-subscription card chain; the per-sentence Ask citation rule; and a Threads/worklist link that opens at the moment.

Device coverage on a low-memory phone and a representative newer phone:

- A full 60-minute Free recording, including screen-off, pause/resume, PiP, and notification controls.
- The fifth and sixth sessions, an exhausted allowance, and a Pro upgrade.
- Background/native-only stop and processing, process recovery, low storage, and thermal/battery pauses.
- Essential-model download failure/retry and incapable-device Pro messaging.
- Small viewport, large text, screen reader, and dark mode.
- **[R2]** A Free recording started from the Quick Settings tile and from the shortcut; a force-stop mid-recording and mid-processing; a call during recording; a full disk; mic lost; the 90-minute capture; a speaker merge with two real voices; billing restore on a phone with no real meetings; and the Phase B by-hand list (Phase B report §7). A device claim counts only if a dated report records it at or after the fixing commit.

Run repository-required checks relevant to each implementation change. Audit already-built work rather than assuming old report defects still reproduce. Release through a staged rollout after the P0 scenarios are verified; preserve quota/content compatibility if a rollback is necessary.

## 7. Measurement and user research

Do not upload audio, transcripts, titles, speaker names, or meeting content for product measurement. Use local diagnostic aggregates, consented usability studies, and store/billing aggregates initially. Any future event collection needs an explicit data-minimization and consent design consistent with the privacy promise.

| Measure | Definition | What it answers |
|---|---|---|
| Setup completion | Successful essential setup / users who start setup | Does onboarding block activation? |
| First useful meeting | New users with usable notes from a real session within seven days | Do users reach actual value? |
| Time to useful notes | Stop/import completion to usable notes; median and p90 by device class | Is waiting acceptable? |
| Second-meeting rate | Activated users starting another real session within 14 days | Was the first result worth repeating? |
| Sharing rate | Activated users initiating at least one export/share | Is output useful enough to send? Share completion may not be observable. |
| Four-week retention | Activated users using a real session or follow-up feature in week four | Does value persist? |
| Allowance utilization | Counted Free sessions and users reaching five per month | Is the allowance appropriately sized? |
| Paid conversion | Activated Free users starting paid Pro; trial-to-paid measured separately | Does packaging convert after value? |
| Quality burden | Corrections and confirmed factual errors in consented evaluation sessions | Can users trust the output? |

Run task-based sessions with 5–8 target users: explore the sample, set up, record/import, find a decision, correct an owner, verify source audio, and share. Observe task completion and misunderstandings; do not treat positive comments as retention evidence.

**[R2] Interview kit and its limits.** The recruiting criteria, task script, consent wording and note template are in the baseline report, Section 4. The sessions need people and cannot be run by engineering. Two rounds: **round 1** on the current build, using a facilitator-prepared stand-in for the sample meeting (the app has no sample today) and the current "MOM"/"Script" labels, as a baseline for the rename; **round 2** after Phase 2 on the real sample and the new labels. Record which build each participant saw.

### 7a. [R2] Quality benchmark

Plan §4-A requires a labelled real-meeting evaluation. The protocol is in the baseline report, Section 3; its decisions are:

- **Size:** a pilot of 12 real meetings, then 24, covering meeting types, field-dense and sparse meetings, 15- to 60-minute lengths, accents and rooms, captured in the app on both a low-memory and a newer phone. A per-class rate is reported only when the reference holds enough instances; below that, raw counts and the individual errors.
- **Labels:** two people label independently from the **audio** (not from the app's transcript) into a `facts.json` per meeting: prices, dates, commitments (promised / completed / conditional / withdrawn), decisions, owners, each with an audio span. A third adjudicates.
- **Counting:** per reference fact, correct / wrong value / missing; per produced item, spurious. Each error carries the first stage that lost the truth (ASR, speaker attribution, rules, classifier, writer, rename/resolution, export) and a severity (S1 changes who does what by when or what was agreed; S2 is wording). Matches are human-adjudicated for the baseline.
- **Scoring:** a new `eval/score_facts.py` and a labelling tool (F23), run on both the desktop CLI and phone exports.
- **No numeric thresholds are set here.** They are set only after: the benchmark is complete and double-labelled; labeller agreement is measured; the judge is calibrated or not used (no calibration was ever recorded); a repeat run gives the same items; desktop and phone agree on a subset; the error taxonomy has stopped growing; and the interview sessions have shown which errors users will not tolerate. Fixes are then measured on meetings not used to design them.
- **Human work:** recording real meetings with every speaker's consent, labelling, adjudication, and phone runs are not something engineering can do; they are founder items B and A3.

Baseline first, then set improvement targets. Review five-per-month packaging after at least two complete monthly cohorts. Consider five per week only if evidence shows the monthly allowance blocks repeat-value discovery; compare retention, quality, and conversion rather than installs alone.

## 8. Scope and source references

This file is the planning baseline for the October product-improvement work. Its Free allowance replaces the 15-minute product policy for this planned implementation. The current application continues using the existing policy until implementation and release. Historical reports and roadmap decisions remain useful evidence; this file does not declare their work newly unbuilt.

Sources reviewed:

- `src/screens/OnboardingScreen.tsx`, `LibraryScreen.tsx`, `RecordScreen.tsx`, `MeetingScreen.tsx`, `PaywallScreen.tsx`, and meeting tabs.
- `src/billing/recordingCap.ts` and current navigation/language policy.
- `docs/store/screenshots/01-recording.png` and `02-summary.png`.
- [September device pass](superpowers/reports/2026-09-25-a07-play-build-feature-pass.md).
- [Phase B implementation report](superpowers/reports/2026-09-25-phase-b-nothing-lost-nothing-false.md).
- [Post-device-pass fix plan](superpowers/plans/2026-09-25-fix-plan-after-a07-pass.md).
- [Existing next-work roadmap](NEXT.md).
- **[R2]** [Phase 0 baseline report](superpowers/reports/2026-10-07-phase-0-baseline.md) — defect audit, 45 allowance scenarios and 14 policy gaps, benchmark protocol, interview kit.
- **[R2]** [Founder to-do list](FOUNDER_TODO_2026-10.md) — decisions, people, phones, Play Console, server and repository actions.
- **[R2]** The allowance implementation plan (`superpowers/plans/2026-10-07-free-allowance-native.md`) exists only on branch `free-allowance` until F01 merges it.
- [Progressive disclosure guidance](https://www.nngroup.com/articles/progressive-disclosure/).

Later bets: additional measured languages, desktop capture, iOS, and processing during capture. Do not let these displace the first complete, accurate, shareable meeting experience.
