# F15 — a transcript correction reaches the items, search and embeddings, keeps ticks and hand-typed items, and survives a Redo

Branch `dev/october-plan`, 7 Oct 2026. Closes D14 and N01 in the phase-0 baseline (in code and on the JVM; the SQL half is device-only, below). Nothing was run on a phone.

## Design as built (as decided; deviations listed at the end)

1. **Write-through.** `AudioDb.saveCorrection` writes the `edits` row (still the durable record) and the corrected words into `utterances.text` in one transaction; `text_raw` keeps the recogniser's wording once and is never overwritten (`Corrections.writeThrough`). `revertCorrection` deletes the row and restores `text_raw` with the Pro vocabulary rules re-applied over it (what the pipeline would have left there), then clears `text_raw` when only the correction separated the two. A blank correction is a revert. The overlay at render is kept (same value).
2. **`Rederive.run`** (new, `pipeline/Rederive.kt`) is exactly the minutes stage of `ProcessingEngine` — `Minutes.extract`, `Minutes.extractItems`, then `AudioDb.rederiveWrite` = `replaceMinutes("rule")` + `replaceItems` (the existing Reconciler path, so ticks, hand edits, hand-typed items and the F14 `owner_json` recording behave as on a reprocess) + `reindexMeeting` (FTS rebuilt, `embedded_at` unstamped; the hash-diff in `Embedder.fill` re-embeds only the changed text on the next sweep), in one transaction. It runs only for a **finished** meeting (`ResumePlan.finished(status)`). **While a run is in flight it skips** — the engine's own minutes stage reads the corrected lines — and sets `rederive.pending.<id>`; a core that fails to load sets the same flag. `StorageModule.ensureItems` (every open) calls `Rederive.catchUp`, which honours the flag.
3. **Narration.** Never rewritten. `markNarrationStale` sets `narration.stale.<id>` when a correction changes a line of a meeting with a written `llm` summary; `AudioDb.replaceMinutes(…,"llm", summary)` clears it (so `Narrator.kt` is untouched). `MeetingScreen` reads it and passes `stale` to `SummaryTab`, which shows "You corrected the transcript after this summary was written. Write it again to update it." above the existing Write it again button.
4. **Survive re-transcription.** `replaceUtterancesJson` snapshots utterance edits as (start, end, value) from the OLD rows, deletes, inserts the new rows, and `Corrections.reapply` places each on the new line with the greatest overlap (earlier line on a tie, at least 50% of the shorter range); the winner is written through exactly as in (1) and its `edits` row re-keyed. Two corrections landing on one line: the larger overlap wins. Corrections that match nothing are dropped and counted into `corrections.dropped.<id>`; `MeetingScreen.refresh` says "N corrections couldn't be re-applied" once (`takeDroppedNotice` reads and clears). Speaker edits keep today's behaviour (`SpeakerRepair` untouched). Re-application sits inside `replaceUtterancesJson` (one transaction, nothing to lose between calls) and so runs BEFORE the vocabulary pass, which then sees the corrected text.
5. The vocabulary path is unchanged.

JS: `db.putEdit` / `db.clearEdit` route `utterance` edits to the new `Storage.saveCorrection` / `revertCorrection` (native does the `edits` row too, atomically) and resolve with "were the items re-derived now"; `MeetingScreen` re-reads on true. Every other edit kind is unchanged.

## Per artefact

| Artefact | Before | After |
|---|---|---|
| Transcript display | overlay at render | same (value now equals the line) |
| `utterances.text` | raw ASR | corrected; first raw in `text_raw` |
| Items (action text etc.) | old words until a Redo | re-derived through the Reconciler on save/revert; tick, hand edit, hand-typed item kept |
| Rule minutes / summary row | old words | re-derived with the items |
| FTS (`search_fts`) | raw utterance text | corrected text (rebuilt) |
| Embeddings | old | `embedded_at` unstamped; changed chunks re-embed on the next sweep |
| Written summary (`llm`) | silently out of date | marked stale with the existing rewrite action; not rewritten |
| Exports | overlay | unchanged (overlay and line now agree) |
| Corrections made before this build | only in `edits` | written through and re-derived on the next open (`writeThroughSavedCorrections`) |
| Redo (re-transcribing) | corrections deleted | re-applied by overlap; unplaced ones counted and said once |

## Tests

JVM (`CorrectionsTest`, 19): overlap table (exact, shifted, split equal/unequal, merged, none, touching, below 50%, exactly 50%, zero-length, empty); greatest overlap wins; every correction placed; unmatched counted; merged corrections — larger wins in either order; first raw kept across two corrections; revert restores raw, with and without vocabulary; stale rule; `rederiveNow` over statuses; notice wording; key spellings; and over the real `Reconciler`: a corrected line changes the action text on the SAME item id (so the tick stays), a hand-typed item survives, a ticked item whose line was rewritten beyond recognition is kept.
jest: `transcriptCorrection.test.ts` (4: routing), `correctionNotices.test.ts` (6), `SummaryTab.test.tsx` +3 (stale shown / not shown / no summary), `MeetingScreen.test.tsx` +5 (re-read after re-derive, not otherwise, dropped notice once, stale flag handed to the tab, not stale).
androidTest `CorrectionsDbTest` (9, **compiled, not run**): write-through with raw kept once, FTS holds the correction and `embedded_at` is NULL, revert, item follows + tick kept + hand-typed kept + index, mid-processing flagged then caught up on open, pre-existing edit caught up, stale set/clear, Redo re-applies and re-keys, Redo drops and counts.

## Mutants (each made, a named test failed, restored; scripts under the scratchpad with unique names; `git diff --stat` clean after)

Kotlin (`Corrections.kt`): no 50% floor → `bestMatchTable`; tie to the later line → `bestMatchTable`; larger later correction no longer wins → `aLaterLargerCorrectionTakesTheLineFromAnEarlierSmallerOne` (first attempt SURVIVED; that test was added); unmatched not counted → `aCorrectionWithNoLineLeftIsCountedNotLost`; merge loser not counted → `twoCorrectionsMergedInto…`; raw overwritten → `theFirstRawWordingIsKeptForever`; revert ignores vocabulary → `revertingReappliesTheVocabulary…`; revert leaves raw → `revertingPutsTheRecognisersWordsBack`; stale needs only a change / only a summary → `onlyAWrittenSummaryThatChangedGoesStale`; rederive during a run → `onlyAFinishedMeetingIsRederivedAtOnce`; singular wording; key rename → `theKeysArePerMeeting`.
JS: reading does not clear; plural; utterance and revert routed to the side table; no re-read after save; stale flag never read; dropped notice never taken; stale line never drawn / drawn with no summary — all killed.
Not mutated (device-only SQL, no way to run it here): the `AudioDb` write-through UPDATE, the snapshot/re-apply in `replaceUtterancesJson`, `rederiveWrite`.

## Gate

`npx tsc --noEmit` clean; `npx jest src/db src/screens src/pipeline` 670 pass; `:app:testDebugUnitTest` and `:app:compileDebugAndroidTestKotlin` pass; `GATE_STAGES="types js scans mutations kotlin" scripts/gate.sh` all clear (33 reconciler mutations caught). One early unit-test failure in `ReconcilerTest` was another agent's reconciler mutant mid-run; it cleared on retry and I touched nothing there.

## Device-only parts (not run)

Everything in `CorrectionsDbTest`; that `Minutes.extract` over the real core gives the "Mira" action; that a split / merged utterance on a real Redo lands the way the pure table says; timing of the rule pass on the module thread for a very long meeting; the Summary card and the one-time Alert as drawn.

## Deviations, known limits, not done

* The `edits` upsert moved from JS into the native call for utterance edits (atomic with the write-through); the JS schema never carried that table.
* **Split utterance:** the whole corrected sentence lands on the better half (the rule as decided); the other half keeps the new raw text. A corrected line is a whole sentence applied to half a line in that case.
* **Vocabulary after a Redo** still runs over corrected lines (the correction is re-applied first, vocabulary second), as it already does on any line.
* A reverted line gets the vocabulary re-applied but not dictation's spoken punctuation (native-only).
* The Pro classifier is not re-run; a re-extracted item arrives unclassified (its pending test picks it up), a matched one keeps its carried record.
* The Reconciler keeps its existing behaviour for a heavily reworded item: matched below 0.6 similarity it is carried flagged `needs_review`; with no anchor overlap the old ticked row is retained beside the new one (a split, by design).
* A re-derive requested while the meeting is mid-run is deferred to the next open, not performed after the run ends.
* Not done: a "Backup restore" check that `narration.stale.*` / `corrections.dropped.*` settings keys travel sensibly (they ride the existing settings table, like every other key); `deleteMeeting` leaves its three settings keys behind (a few bytes).
