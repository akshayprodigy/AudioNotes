# F25 — relevance floor for search by meaning

*7 October 2026. Branch `dev/october-plan`. Measured first, then built (`FP` rule: "measured, never guessed"). Nothing here was run on a phone.*

## Result in four lines

- **Floor: `Retriever.MEANING_MIN_SIMILARITY = 0.60`** (cosine of the query vector with the stored passage vector, `VecCodec.dot`). A meaning hit below it is dropped before fusion; a hit exactly at it stays.
- The signal is **weak**: bge-small's cosines are compressed, and relevant and irrelevant pairs overlap heavily. No floor separates them cleanly; 0.60 is a trade, chosen as the highest floor that still leaves 20 of 21 answerable queries with a relevant row.
- At 0.60 on the bench: irrelevant rows shown per query fall from 36.6 to 5.2 (-86 %), 8 of 13 queries with **no** relevant passage show nothing at all, and 20 of 21 answerable queries still show at least one relevant row. Cost: only 47 of 92 relevant "≈" (meaning-only) rows survive.
- The sample is small and comes from **AMI headset meetings, not phone recordings**. 0.60 is a measured starting value to re-check on real meetings, not a calibrated threshold.

## What was measured

Script: `eval/measure_search_floor.py` (standard library; embeds with the app's own `EmbedEngine` through `cpp/tests/embed_dump.cpp`, a throwaway tool built against the libraries already in `cpp/cli/build`; model `eval/models/bge-small-en-v1.5-q8_0.gguf`). Re-run: `python3 eval/measure_search_floor.py --work <scratch dir> [--show] [--min-words N]`.

**Passages (214).** The four AMI fixtures' `truth.json` (ES2002a, ES2002b, ES2003a, IS1000a) chunked exactly as `SearchChunker.kt` does: turns in time order merged up to 100 words, split on a silence over 30 s (174 chunks), plus each fixture's `minutes.json` decisions, actions and questions as short `item` passages (40), the way `Embedder.wanted` adds items. Not included: the summary row, and the real app's speaker and live-transcript quirks. Passage vectors are quantised to int8 + one scale like the stored ones, so the dot product is the one `AudioDb.meaningHits` computes (query float x quantised passage).

**Queries (34), hand-written.** 21 with answers: short keywords ("pricing", "budget", "teletext", "speech recognition", "battery", "gaming", "touch screen", "company colour") and phrases or questions ("when is the next meeting", "who is writing the minutes", "who is our target market", "will we sell internationally", "which buttons does the remote need", ...). 13 with **no** relevant passage ("quarterly revenue forecast", "hiring and salary", "server outage postmortem", "invoice payment terms", "who owns the quarterly report", "book the demo room for Friday", ...), which judge the floor on rejecting noise. The word "pricing" is labelled answerable here because AMI's remote-control meetings do discuss price; the A07 case (a pricing query that surfaced a room booking) is the 13-query no-answer group.

**Labelling rule.** For every query I read all 214 passages and listed those that substantively address the topic (a passing mention does not count; a minutes item that states the topic does). A regular expression only found candidates; substring traps ("closing" for "losing", "agenda" in a palm-pilot remark) and passing mentions were removed by hand. The lists are in the script (`QUERIES`); a test checks every id is a real passage. **Anything unlabelled counts as irrelevant**, so an on-topic passage I missed makes a floor look worse than it is. One labeller, no second opinion.

**Keyword side.** For the "what the person sees" columns the keyword list is approximated (every token must match, the last as a prefix, as `AudioDb.ftsQuery`; no stemming, so "pricing" does not find "price"). An approximation, not FTS5.

## Distribution of the dot product

| pairs | n | min | q1 | median | q3 | p95 | max |
|---|---|---|---|---|---|---|---|
| relevant (query, passage) | 161 | 0.369 | 0.524 | 0.577 | 0.640 | 0.750 | 0.816 |
| irrelevant | 7115 | 0.214 | 0.400 | 0.445 | 0.494 | 0.571 | 0.767 |
| best relevant row per answerable query | 21 | 0.550 | 0.645 | 0.691 | 0.753 | 0.796 | 0.816 |
| top-1 row of an answerable query | 21 | 0.619 | 0.671 | 0.702 | 0.753 | 0.796 | 0.816 |
| top-1 row of a **no-answer** query | 13 | 0.538 | 0.562 | 0.591 | 0.604 | 0.624 | 0.633 |

The irrelevant top-1 rows of the no-answer queries are mostly short passages: a "Mm-hmm" chunk, a one-line minutes item such as "The remote will use regular batteries." (0.72 for "people keep losing the remote"), or a shared word. Any short passage sharing a topic word with the query scores as high as many genuinely relevant long chunks.

## Candidate floors

"All pairs" is over every (query, passage) pair. The right-hand columns are what a person would see: keyword rows plus the meaning rows (top 40, as `MEANING_TOP`) at or above the floor; "≈ rows" are the meaning rows the keyword list did not already have. 0.30 is effectively no floor.

| floor | relevant kept | irrelevant rejected | ≈ rows relevant / irrelevant | answerable queries with no relevant row | no-answer queries left with 0 rows | irrelevant rows per query |
|---|---|---|---|---|---|---|
| 0.300 | 100.0 % | 1.4 % | 92 / 1242 | 0 of 21 | 0 of 13 | 36.6 |
| 0.450 | 95.0 % | 53.0 % | 92 / 1221 | 0 of 21 | 0 of 13 | 35.9 |
| 0.500 | 83.9 % | 77.6 % | 92 / 1022 | 0 of 21 | 0 of 13 | 30.1 |
| 0.525 | 74.5 % | 86.1 % | 86 / 768 | 0 of 21 | 0 of 13 | 22.6 |
| 0.550 | 64.6 % | 92.1 % | 80 / 506 | 0 of 21 | 2 of 13 | 14.9 |
| 0.575 | 52.8 % | 95.4 % | 64 / 307 | 1 of 21 | 6 of 13 | 9.1 |
| **0.600** | **39.1 %** | **97.5 %** | **47 / 176** | **1 of 21** | **8 of 13** | **5.2** |
| 0.625 | 31.1 % | 98.8 % | 38 / 87 | 4 of 21 | 12 of 13 | 2.6 |
| 0.650 | 23.6 % | 99.2 % | 29 / 54 | 5 of 21 | 13 of 13 | 1.6 |
| 0.700 | 11.8 % | 99.8 % | 13 / 15 | 9 of 21 | 13 of 13 | 0.5 |
| 0.800 | 0.6 % | 100.0 % | 1 / 0 | 10 of 21 | 13 of 13 | 0.0 |

(Full 0.025-step table: run the script. Dropping passages under six words, `--min-words 6`, barely moves it: at 0.60, 46 / 147, 1 of 21, 9 of 13.)

## Why 0.60

- Up to 0.55 nothing is lost but little is cleaned (2 of 13 no-answer queries empty, 15 irrelevant rows per query).
- 0.60 is the highest floor at which at most one answerable query (the first one to go is "budget", whose best relevant row is 0.550) loses every relevant row; it empties 8 of 13 no-answer queries. The A07 symptom (a "≈" row with nothing to do with the query) is the case this removes.
- 0.625 would empty 12 of 13 no-answer queries but leave 4 of 21 answerable queries (19 %) with no relevant row; that is a bigger visible failure than a noisy row.
- Trust over recall, but not to the point of silence: a "≈" row is an extra that keyword search did not find, so losing some of them is the cheaper error.

## Things the measurement says plainly

- **The floor is blunt.** At 0.60 five of the 13 no-answer queries still show a row (their top rows scored 0.601 to 0.633), and "pricing" itself keeps only 2 of its 20 relevant rows (best 0.634): short keyword queries embed weakly against 100-word chunks. A better filter than an absolute cosine is probably a margin below the query's own best score, or not embedding very short passages; neither was built (out of scope and unmeasured).
- Items (one-line minutes rows) are the dominant noise, more than backchannel chunks.
- The relevant "≈" rows lost at 0.60 are about half (92 to 47).

## What was built

- `Retriever.MEANING_MIN_SIMILARITY = 0.60` with the measurement cited in its comment; pure `Retriever.aboveFloor(meaning, floor)` (below dropped, at-floor kept, order preserved) and `Retriever.search(keyword, meaning, floor) = fuse(keyword, aboveFloor(meaning, floor))`.
- `AudioDb.searchHits(..., minSimilarity = Retriever.NO_FLOOR)` calls `Retriever.search`; `searchJson` (the search screen, and the meeting screen's search) passes `MEANING_MIN_SIMILARITY`.
- **Ask shares `searchHits` -> `meaningHits`**, and so would inherit the floor. It does not: `Asker.ask` calls `searchHits` with the default `NO_FLOOR`, so Ask retrieval is unchanged (a test pins that `search(..., NO_FLOOR)` equals plain `fuse`). Ask's questions are longer and Ask has its own cites-or-nothing guard; a floor for it would need its own measurement.
- The search screen shows no count of dropped hits and was not touched.

## Tests and mutants

`RetrieverFloorTest` (12 tests, JVM). Mutants, each killed by named tests and restored (`git diff --stat` showed only the intended change after each):

| mutant | killed by |
|---|---|
| filter removed (`aboveFloor` returns its input) | `aHitBelowTheFloorIsDropped`, `theOrderOfTheSurvivorsIsKept`, `anEmptyResultIsFine`, `whenEveryMeaningHitIsBelowTheFloorTheResultIsKeywordOnlyWithNoApproximateRows`, `anUnrelatedMeetingsWeakHitDoesNotAppearWhenAnotherMeetingMatchesTheWords`, `aMeaningHitThatClearsTheFloorStillShowsAsApproximate` |
| off by one (`>` for `>=`) | `aHitExactlyAtTheFloorIsKept` |
| floor applied after fusion | `theFloorIsNotAppliedToFusedScores`, `keywordHitsAreNeverFilteredByTheFloor`, `whenEveryMeaningHitIsBelowTheFloor...`, `anUnrelatedMeetingsWeakHitDoesNotAppear...`, `aMeaningHitThatClearsTheFloorStillShowsAsApproximate`, `aRowTheKeywordListAlsoFoundKeepsItsWordsMark...` |

Not covered by a unit test (needs the database and the embedder): that `searchJson` passes the floor and that `Asker` passes none. Read in the diff; **Device: not run.**

## Known gaps

- 34 queries, 4 meetings, one labeller, English headset audio. Re-run `measure_search_floor.py` with phone recordings (the A07 meeting, once its transcript is a fixture) before treating 0.60 as more than a starting value.
- The summary row type is not in the passage set.
- Quantisation is imitated in Python (round half up, like `Math.round`); differences from the Kotlin path are far below the 0.025 step of the table.
