# F24 — the writer fact check

Branch `dev/october-plan`. Closes the *check* half of D10 (Phase 0 baseline row D10); the *measurement* half is still open and is described at the end. **Nothing here was run on a phone.** Every statement below is about the C++ unit tests, the JVM tests, jest, and one run of the real writer on the Mac.

## What it is

A deterministic post-check on every piece of prose the writer produces — narrative, summary, headline, and a dictated note (which is the narrative with `template == "dictation"`). It reads the text one sentence at a time, extracts the claims a reader would act on, and keeps a sentence only if the transcript supports every claim in it. A sentence is kept whole or removed whole; nothing is rewritten, so no half-sentence is ever stored. The extractive item lists (decisions / actions / questions) never pass through it.

No model and no threshold are involved. Same inputs, same output, on the phone and on the Mac.

### Where it lives, and why C++

- **Rules:** `cpp/minutes/fact_check.{h,cpp}` — pure functions, `checkWriterFacts(written, transcript)`.
- **Phone path:** `NativeBridge.nativeFactCheck` (JNI, one new function in `audionotes_jni.cpp`) → `FactGuard.kt` (reads the one-string answer back, tallies, fails closed) → called three times in `Narrator.run`.
- **Desktop / eval path:** `narrate()` in `llm_prompts.cpp` runs the same function, so the CLI and the eval harness see the checked text.

Chosen over a Kotlin object because `Narrator.kt`'s own header says it is "Kotlin owns the LOOP; C++ owns the LOGIC": every other rule that decides what the reader sees (`stripLabels`, `trimToSentence`, `dropAbsenceTail`) is C++ behind one JNI call, so the CLI and the phone cannot drift. The wiring cost was one JNI function (`jstring`, `jstring` → `jstring`), one `external fun`, and one file added to the source list of the `.so` and of seven CMake targets that already compile `llm_prompts.cpp`.

### Order inside a narration

```
narrative  = check( clean( generate ) )          # empty -> existing "no narrative" exit, nothing stored
summary    = check( clean( generate(narrative) ) ) # written FROM the checked narrative; empty -> "no summary" exit
headline   = check( generate(summary) )
```

Checking the narrative *before* the summary is built from it is deliberate: a removed sentence must be gone from what the summary reads, not merely from what is stored. The transcript each output is held against is the plain utterance text (no speaker labels). For a long meeting the writer saw digests; the whole transcript is the superset those were made from.

### What happens on failure

- Each unsupported sentence is dropped. Paragraph breaks survive; a paragraph that loses its only sentence goes entirely; a template section label ("Planned next:") stays on the sentence that is left when its own first sentence is the one removed.
- If the check empties the narrative or the summary, `Narrator.run` takes the exit it already had for "the model produced nothing" and **stores nothing** (as before, that includes not touching the existing rows).
- The count is recorded per meeting in the settings key `writer_check:<meetingId>` = `"<n>|<class,class>"`, written with the rows it describes and rewritten on every narration (`"0|"` when clean), so a re-run clears a stale count. A settings key rather than a `minutes` row on purpose: `minutes` rows are indexed for search and a count must not become a search hit.
- The Summary card shows one quiet line under the card — "N sentences removed because the transcript doesn't support them." ("1 sentence … support it.") — only while the model's own text is on the card (hidden once the person has edited the summary), re-read when the summary row changes.
- **Not silent when it removes a sentence. Silent when it removes the whole summary**: in that case the card shows the existing "no summary" state and the count is only in the log (`Narrator` logs it). That is the cost of "store nothing"; flagging it would need a row to hang the line on.

## Rules as built

Tokeniser: lowercased words, digit numbers (`3,999`, `4.99`, `10th`, `5k`, `3:30`, `10/03`, `2026-03-10`), currency symbols (`$ € £ ₹` → `usd eur gbp inr`), `%` → `percent`, `a.m./p.m.` → `am/pm`; clause breaks (`, ; : ( —`) are recorded because they end a verb's context window.

**Numbers.** A table-driven spelled-number parser over the standard grammar (zero–nineteen, tens, hundred, thousand, lakh, crore, million, billion, "and", "point") with one extension: a group that cannot take the next word closes and a new group starts. That is what turns "four ninety nine" into `[4][99]`. Two plain groups with the second in 10–99 are a *colloquial pair* and mean either `g1*100+g2` or `g1 + g2/100`:

| said | candidate values |
|---|---|
| four ninety nine | 499, 4.99 |
| thirty nine ninety nine | 3999, 39.99 |
| nineteen ninety nine | 1999, 19.99 |
| twenty twenty six | 2026, 20.26 |
| four hundred ninety nine | 499 only (a hundred-word makes one number) |

Other magnitudes (4990, 49.9) are not candidates. On the transcript side a pair's two halves are also kept (so "forty fifty people" supports "40 people"); on the writer side only the pair readings count. Digit and word forms normalise to the same key (value × 1000, rounded). A claim is supported when any candidate value appears in the transcript.

**What counts as a claim.** Any number ≥ 11 or non-integer; any number attached to a currency, a percent sign, or a unit of time (hour, minute, day, week, month, year, quarter). A bare 0–10 without a unit is *not* a claim ("three options were discussed" is how a summary counts what it listed). A number directly after "speaker" is a label, not a quantity.

**Currency.** An amount is a claim on both halves: the number must be in the transcript *and* that currency must have been said somewhere in it (`$`/dollar(s)/bucks, €/euro(s), £/pound(s), ₹/rupee(s)/Rs). Right number, wrong currency is a wrong fact and is dropped. A currency the transcript never names is dropped too — the writer guessed one (a number said with no currency is the A07 case).

**Dates.** Weekday names; month names (and `may`/abbreviations only next to a day number, so "may revisit" is not a month); month + day in any form ("10 March", "March 10", "the tenth of March", "10th March", `10/03` read either way round, ISO); a month alone; a day alone ("the 15th" ⇄ "fifteenth"); relative phrases (`next/this/last week|month|quarter|year|weekend`, `tomorrow`, `yesterday`, `tonight`, `end of the day/week/month/quarter/year`, `eod/eow`); times (`3 pm`, `3:30`, `three o'clock`, `ten thirty am`; a bare hour is supported if the hour was said at all, since "meet at three" never says pm). A month-day must match as a pair, not as two supported halves. Month names the transcript lacks are invented months (a writer that turns "Friday the 12th" into "12 October" loses the sentence).

**Status verbs.** Writer claims are the past/participle forms of sent, shipped, delivered, completed, finished, done, approved, signed, paid, launched, released, resolved, postponed, rescheduled, delayed, cancelled, moved. A writer occurrence is *not* a claim when it is negated ("has not been paid"), promissory ("will be sent", "needs to be signed", "once it is signed"), or — for the soft verbs moved/pushed/bumped/slipped — not a postponement ("moved on to pricing", "moved onto").

Support: the same verb *family* (every inflection; every way of saying a date moved — postponed/rescheduled/delayed/moved/pushed/bumped/slipped — is one family; sent/shipped/delivered is one; done/finished/completed is one) must occur in the transcript **near the writer sentence's subject** (±15 tokens of any content word of the sentence; capitalised words are names and are not held to the transcript; no content word means no proximity requirement). Each transcript occurrence has a mood:

- **support** — a past form, or a bare/present form (the spec's "same verb or inflection"), unmarked;
- **promise** — preceded within four tokens (same clause) by will / 'll / shall / would / should / could / can / might / may / must / gonna / going to / let's / please / once / if / until / unless / whether, or an infinitive "to (be/get/have) <verb>", or a sentence-initial bare verb (an imperative: "Send the proposal by Friday");
- **negated** — not / never / no / without / -n't within four tokens;
- **question** — in a sentence ending `?`.

If any near occurrence supports, the claim stands. Otherwise: only promise occurrences → **tense** (the writer turned a promise into an event); anything else (no occurrence, negated, asked about) → **status**.

**Not claims:** a template section label ("Done since last time:") is stripped before analysis; "Speaker 13".

**Result.** `{text, dropped, classes}`; classes distinct in the fixed order number, currency, date, status, tense; a sentence with two failing claims counts once in `dropped` and contributes both classes. Byte-identical text when nothing is dropped.

## The three A07 cases (the tests contain exactly these strings)

Transcript snippets are written to match what A07 recorded (the ASR heard "four ninety nine a month" as "499 am").

| case | transcript | writer output | after | dropped / class |
|---|---|---|---|---|
| price | "Okay so for the starter plan the price is 499 am and we can talk about the annual one next time. Ravi will draft the pricing page." | "The group discussed pricing for the starter plan. The starter plan costs $499/month or $3999/year. Ravi will draft the pricing page." | "The group discussed pricing for the starter plan. Ravi will draft the pricing page." | 1 / currency |
| sent out | "Ravi: I'll send the report to the client by the end of the week. Priya: Great, thanks." | "The group reviewed the client report. The report was sent out to the client. Priya thanked Ravi." | "The group reviewed the client report. Priya thanked Ravi." | 1 / tense |
| schedule | "Let's hold the design review on Thursday afternoon." | "The design review had been scheduled for Tuesday but has now been postponed to Thursday. The review will be in the afternoon." | "The review will be in the afternoon." | 1 / date + status |

Note on the price case: the sentence goes for two independent reasons — `$3999` is not a value "499 am" can mean, and no currency was said at all. Even `$499` alone would go, because nothing in the transcript says dollars (the founder may have meant ₹ or $4.99).

## Tests

- `cpp/tests/test_fact_check.cpp` (ctest `test_fact_check`, 30 cases, no model): the spelled-number table (26 phrases), colloquial pairs and the magnitudes they must *not* allow, digit forms, the splitter, the three A07 cases, spelled/digit equivalence, small counting words, percent, currency (right number wrong currency, `$`⇄dollars, `₹`/Rs/rupees, no currency spoken), weekdays/months/`may`/relative dates/times/days alone, status support, tense flips (will, will be, needs to be, imperative, going to), negation and question, subject proximity, "moved on", names, a clean summary byte-for-byte, an emptied result, the exact counter and class order, paragraph and section-label preservation, empty inputs.
- `cpp/tests/test_llm_minutes.cpp`: `narrate()` removes the bad sentence from the narrative the summary is *built from*, counts it, names the class; an emptied narrative stops the chain (1 generate call).
- `FactGuardTest.kt` (12 tests, JVM, native stubbed): answer parsing, tally, fail-closed on an unreadable answer, `"0|"` clears, and a source-level wiring test that `Narrator.kt` has exactly three `FactGuard.guard` call sites, the summary prompt built from the checked narrative and the headline prompt from the checked summary, and the count written after the checks.
- jest: `writerCheck.test.ts`, `SummaryTab.writerCheck.test.tsx` (shows the count, hides on 0 / missing / other meeting / no summary / edited summary, replaces on re-run).

Results: `ctest` in my own build dir 28/28 (the three model-dependent live tests excluded from that run; `test_narrate_live` run once separately, below); `:app:testDebugUnitTest` exit 0; `npx tsc --noEmit` clean; `npx jest src/screens` 46 suites / 471 tests pass.

### One live look at the real writer (Mac, once, the existing `test_narrate_live`)

It passes with the one added prompt line. I ran the checker over its three real outputs (stand-up, client call, dictation; 14 sentences) against their records: **0 dropped**. I also ran it over 196 sentences of older real writer output stored in `eval/results/` (summary/narrative/headline from the AMI fixtures; transcripts rebuilt from the stored segments): 0 dropped after one fix this surfaced ("Speaker 13" was read as a quantity). Those writer outputs contain few numbers and no completion claims, so this says "does not wreck ordinary prose", not "catches errors". It is not a measurement and nothing was tuned on a held-out set.

## Mutants

House rule: break each rule, watch a named test fail. 29 loosenings of `fact_check.cpp` applied to *copies* (script `scratchpad/f24/mutate_f24_checker.py`, repo files untouched), each compiled against the real test file. **All 29 killed.** The ones the task named:

| loosened rule | killed by |
|---|---|
| number: unsupported plain number passes | `spelledAndDigitFormsAreEquivalent`, `percentIsANumberClaim`, `smallCountingWordsAreNotClaims` |
| number: digit and spelled forms no longer equivalent | `digitFormsNormalise`, `currencyMustBeTheOneSpoken` |
| currency: wrong/absent currency passes | `currencyMustBeTheOneSpoken`, `aCurrencyNobodySaidIsNotInventedForABareNumber` |
| currency: unsupported amount passes | `fourNinetyNineSupportsEitherMagnitudeButNothingElse`, `theCounterAndTheClassesAreExact` |
| date: weekday always supported | `a07InventedEarlierSchedule`, `weekdaysAndMonths` |
| date: month-day needs only the month | `weekdaysAndMonths`, `mayTheVerbIsNotAMonth` |
| date: relative phrase / time always supported | `relativeDates` / `timesOfDay` |
| status: completion with no occurrence passes | `a07InventedEarlierSchedule`, `aSpokenCompletionSupportsTheClaim` |
| status: subject proximity ignored | `completionNeedsTheSameSubjectNearby` |
| status: negated / question occurrence counts as support | `aNegatedOrAskedAboutCompletionDoesNotSupportIt` |
| tense: promised-then-done passes | `a07SentOutThatWasOnlyPromised`, `tenseFlipIsCaught` |
| tense: future markers / infinitive / imperative not recognised | `a07SentOutThatWasOnlyPromised` / `tenseFlipIsCaught` (each) |
| drop-vs-keep: unsupported sentences kept | `a07PriceIsDropped`, `a07SentOutThatWasOnlyPromised`, … |
| drop-vs-keep: count not reported / emptied text not emptied | `a07*`, `everySentenceUnsupportedLeavesNothing` |

Also killed: pair not combined, "hundred" ignored, `$` not understood, ₹ mapped to dollars, small-number-with-unit not a claim, section label counted, splitter splitting on abbreviations, `may` as a month, "moved on" as a postponement, "Speaker 13" counted.

Plumbing (applied in place with a unique backup per mutant and `cmp`-verified restore): Narrator headline unchecked, summary built from the unchecked narrative, count never recorded (all killed by `narratorChecksEveryOutputBeforeItIsStoredOrBuiltFrom`); `FactGuard` failing open (`guardStoresNothingWhenTheAnswerCannotBeRead`), tally not adding (`guardCountsAnOutputItEmptied` + 2), classes not distinct; `writerCheckLine` treating 0 as a removal; the line surviving a user edit; a re-run not re-reading the count (jest, named tests). All killed.

## What it deliberately does not catch

- **Any invented non-numeric fact**: "the client was unhappy", a wrong owner, a made-up decision, a reversed meaning. Not checkable without a model. D10's price / done-vs-promised / schedule classes are covered; D10 is not "the writer is trustworthy".
- **Wrong period or unit when the number is right**: "$4.99 a year" for "$4.99 a month". The period word is not checked.
- **Wrong attribution of a true number** to a different thing ("40 users" when 40 was the budget). The number is somewhere in the transcript, so it passes. Same for a date that is in the transcript but attached to the wrong event.
- **Small spelled numbers without a unit** (0–10) — exempt by design.
- **Derived numbers** (a sum, a rounding, "about 40 minutes" for 45) are *dropped*, which is the conservative side of the trade, but a derived number that happens to equal another number in the transcript passes.
- **A transcript that is itself wrong.** ASR "499 am" is supported as 499; the check cannot know the founder said "four ninety nine".
- **Loosenings I chose, each costing a wrong fact rather than a dropped sentence:** ambiguous pairs support both magnitudes and (transcript side) both halves; all numbers in the transcript form one pool (the "10" of "10 March" supports "10 people"); a bare hour is supported by the hour appearing as any number; a sentence whose only content word is a name has no subject to hold its verb to.
- **Strictnesses I chose, each costing a dropped sentence rather than a wrong fact:** a currency symbol the transcript never says; a present-tense "I approve" is a *support* (spec) but an imperative is a *promise*; any non-claim ≥ 11 the writer derived; `moved/pushed` with a date or "was" is read as a postponement.
- **English only**; no Devanagari numerals, no other-language number words.
- Digests: the long-meeting digests are not themselves checked, only what the narrative makes of them (the narrative is checked against the whole transcript).

## The benchmark step that must still measure it

`eval/` skips the summary (`eval/metrics/mom.py:from_document`) and the baseline's section 3.4 scores "prose sentences in an AI summary … supported / unsupported / contradicted" by hand, so nothing here has a rate. The step that is still owed, in the shape section 3.4 and 3.6 already set:

1. Run the writer over the F23 corpus with the check **off**, hand-label every summary/narrative sentence (supported / unsupported / contradicted, with the S1 flag for price, date, owner, promised-shown-as-done) on meetings **not** used to design these rules. This gives the pre-check error rate by class.
2. Run the same outputs through `checkWriterFacts` (it is exposed in the CLI path via `narrate()`: `Narration.fact_dropped` / `fact_classes`, and the function is pure so the harness can call it on stored output) and score: *caught* (an unsupported S1 sentence that was removed), *missed* (survived — the number that matters), and *false drops* (a supported sentence removed). Report the three per class, with the count-first rule — no rate below the minimum.
3. Only then decide whether any rule needs changing, and re-measure on fresh meetings. No threshold exists to tune, but the *rules* (the small-number exemption, the currency-must-be-spoken rule, the ±15-token subject window, the four-token mood window) are exactly the things a false-drop rate would tell us to revisit.
4. Device: not run — on-phone behaviour (JNI symbol present in a release `.so`, the Summary line rendering, the "Write it again" clearing a stale count) is unverified until a phone run.

## Files

`cpp/minutes/fact_check.{h,cpp}`, `cpp/tests/test_fact_check.cpp`, `cpp/cli/CMakeLists.txt`, `cpp/CMakeLists.txt`, `cpp/minutes/llm_minutes.h` (`Narration.fact_dropped/fact_classes`), `cpp/minutes/llm_prompts.cpp` (`narrate()` guard; one prompt line in `narrativePrompt` and `summaryPrompt`: "Keep every number, amount, date and status exactly as it was said. Something promised or planned is not something done…"; `dictationPrompt` already carried the equivalent), `cpp/tests/test_llm_minutes.cpp`, `cpp/jni/audionotes_jni.cpp`, `NativeBridge.kt`, `FactGuard.kt`, `Narrator.kt`, `FactGuardTest.kt`, `src/screens/meeting/writerCheck.ts`, `SummaryTab.tsx`, and the two jest files.
