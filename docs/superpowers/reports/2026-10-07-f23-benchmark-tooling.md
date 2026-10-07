# F23: quality-benchmark tooling

Date: 2026-10-07. Branch `dev/october-plan`. Implements Section 3.3-3.6 of
`2026-10-07-phase-0-baseline.md`. Everything is under `eval/`; Python 3 standard library only.

## What was built

| File | Role |
|---|---|
| `eval/facts.py` | Schema and validation for `facts.json` (prices, dates, commitments, decisions, owners note). Enums are named constants (`CLASSES`, `STATES`). `validate()` returns plain-English problems: duplicate ids (unique across the whole file, because a match row names a fact by id alone), span end before start, unknown state, missing/unknown fields, bad ISO dates, spans outside `audio_ms` when `truth.json` exists. |
| `eval/corpus/facts_label.py` | Verbs `init`, `import`, `validate`, `agreement`. `init` writes an empty valid `facts.json` and a plain-text `facts.sheet.txt` (one section per class, examples in comments). `import` parses the edited sheet and refuses with line numbers, and while the `STATUS: UNLABELLED` line is still there (mirrors `truth_draft`'s guard). `agreement` matches two labellers' sets by span overlap, one to one, and lists per class matched / only-A / only-B plus owner/state/amount/currency/period/date differences. No score, no threshold. |
| `eval/score_facts.py` | `python3 -m eval.score_facts`. Reads `facts.json` (+ optional `truth.json`, `meta.json` cohort tags) and a run document (`--run`) or a generic list (`--produced`). Without `--matches` it writes `matches.todo.json` (candidates from shared words, plus a blank template) and exits non-zero, never scoring. With matches it validates, then writes `facts_score.json`, `facts_errors.csv`, `facts_report.md`. |
| `eval/aggregate_facts.py` | Pools several `facts_score.json` into one report; the refusal gate is applied to the pooled counts with the `--min-instances` given at aggregation time. Refuses a meeting listed twice. |
| tests | `test_facts.py` (19), `test_facts_label.py` (32), `test_score_facts.py` (60), `test_aggregate_facts.py` (9) |

Test count: **226**, all passing (`python3 -m unittest discover -s eval/tests`; 106 before).

## Commands

    python3 -m eval.corpus.facts_label init real-<id>
    # label from the audio, delete the STATUS line
    python3 -m eval.corpus.facts_label import real-<id>
    python3 -m eval.corpus.facts_label agreement real-<id> a.json b.json
    python3 -m eval.score_facts --fixture eval/fixtures/real-<id> --run run.json      # writes matches.todo.json
    python3 -m eval.score_facts --fixture eval/fixtures/real-<id> --run run.json --matches matches.json
    python3 -m eval.aggregate_facts eval/results/facts-*/facts_score.json --min-instances 30

Outputs default to `eval/results/facts-<meeting-id>/` (gitignored).

## How the rules are implemented

- **One outcome per reference fact.** `correct`, `wrong_value` or `missing`. Zero rows or two rows for a fact is a validation error naming the fact.
- **Produced side.** Every produced `action`, `decision`, `price` or `date` must be matched, `spurious`, or `ignored` with a written note. `question` and `summary` items need no row (they have no reference class); a matched row may still point at one (a price spoken inside the summary prose).
- **`wrong_value` names its fields.** Added to the specified row shape: `fields` (e.g. `["owner"]`, `["state"]`, `["amount"]`). Without it commitment-owner and commitment-state could not be scored separately from one outcome per fact.
- **Metrics per class.** price accuracy, date accuracy, commitment owner (over matched commitments), commitment state (same), commitment recall, commitment precision, decision recall; each as counts, and as a rate with a Wilson 95% interval (z = 1.96) only when the gate allows.
- **Count-first gate.** A rate is printed only if `min(reference instances of the class, the metric's own denominator) >= --min-instances` (default 30). Otherwise the line reads "rate not printed (k of n; N reference instances, fewer than the M required)" and the report lists that class's individual errors. The `min` matters for precision: six produced actions against one reference commitment must not clear the gate on the produced count.
- **Silent S1.** An S1 error (`wrong_value`, `missing` or `spurious`, severity S1) whose produced item was not `flagged_for_review`. A missing fact has no produced item to flag, so it is counted on its own line ("N further S1 errors were missing facts") rather than folded into either figure. If a run carries no `flagged_for_review` data at all, the report says every S1 counts as silent because of the input.
- Also reported: anchor results on matched items (`resolves`, `wrong-moment`, `summary`, `none`, `na`), the first-lost stage counts, and every table repeated per cohort tag value (`device`, `capture_path`, `tier`, `meeting_type`, `field_density`; absent tags read `unknown`).
- No pass/fail, no thresholds, and the report says so; a test asserts the words are absent.

## Mutation checks (house rule)

Each rule was broken in `eval/score_facts.py`, the named tests failed, and the file was restored (git shows no residue).

| Mutant | Killed by |
|---|---|
| refusal gate removed (`gate < min_instances` dropped) | `CountFirstRuleTest`: `test_below_minimum_no_rate_is_printed`, `test_one_below_the_minimum_is_refused`, `test_summary_marks_refusal_without_a_rate`, +3 |
| refusal off by one (`<=`) | `test_at_the_minimum_the_rate_is_printed_with_an_interval`, `test_one_below_the_minimum_is_refused`, +1 |
| gate on `n` instead of `min(reference, n)` | `test_precision_cannot_be_printed_on_the_back_of_many_spurious_items` (this mutant first **survived**; the test was added to kill it) |
| silent S1 inverted (counts flagged) | `SilentS1Test`: `test_silent_s1_is_an_s1_error_whose_item_was_not_flagged`, `test_flagging_the_item_makes_it_not_silent`, `test_report_prints_the_silent_s1_line` |
| silent S1 includes missing facts | same three |
| silent S1 counts S2 errors | `test_s2_errors_are_never_silent_s1`, +3 |
| two outcomes per reference allowed | `MatchValidationTest.test_reference_with_two_outcomes` |
| no outcome for a reference allowed | `test_reference_with_no_outcome`, `test_scoring_malformed_matches_raises_with_every_problem` |
| Wilson centre term changed | `WilsonTest` (5 tests) |
| Wilson half-width term changed | `WilsonTest` (5 tests) |
| Wilson z 1.96 -> 1.645 | `WilsonTest` (5 tests) |

The Wilson tests use hand-computed values (5/10 -> 0.2366..0.7634; 27/30 -> 0.7438..0.9654; 81/100 -> 0.7222..0.8749) and the closed form for 0 of 30 (upper bound z^2/(n+z^2) = 0.1135).

## Deliberately not built

- **An automated matcher.** `matches.todo.json` candidates come from shared words only and do not normalise numbers ("four ninety nine" does not meet "$499"), so a price pair may not even appear. Protocol 3.4 item 6: the match is human-adjudicated for the baseline, because a matcher is the instrument whose error rate is unknown. The next step, once enough adjudicated matches exist, is to evaluate the calibrated judge against them, not to trust it.
- **An adapter for the app's own exports.** `--produced` takes a generic list, and `--run` reads the CLI's `minutes[]` (`kind`, `content`, `source`). The app's real export (a phone share/copy of the minutes) is not read. An adapter would need: (1) the export format fixed (the Copy/Share text or SRT is prose, not records); (2) stable item ids carried through the export so a match row can name them (the evidence-spine ids exist in the app but are not in the text export); (3) `anchor_ms` and `flagged_for_review` per item in a machine-readable form; (4) price and date items as items, since today they live in prose; (5) a `source` marker (rules vs writer) for the Free-versus-Pro cohort. Until then, convert by hand to `produced.json`.
- **Sentence-level summary verdicts** (`--summary-labels` in the protocol): out of scope for this task.
- **Run-to-run determinism and desktop-versus-phone agreement** (3.6 items 4 and 5): need real runs, not tooling.

## Deviations from the brief

1. `wrong_value` rows require `fields` (above).
2. An extra outcome value `ignored` for produced-only rows, as the brief's "ignored row with a reason" requires; it is not in the brief's outcome enum.
3. Ids in `facts.json` are unique across the whole file, not per class.
4. `agreement` also compares currency, period, resolved_date and due_date, not only owner/state/amount; owner text is compared ignoring case and spacing only.
5. Silent S1 excludes missing facts (no produced item exists), with those reported on an adjoining line.
6. `score_facts` exits non-zero when it writes only candidates, so a script chaining the two steps cannot proceed on nothing.

## What still needs a human

Recording with consent, labelling from the audio (two people apart), adjudication, confirming every match pair, and choosing `--min-instances` before the first real run (the protocol suggests no lower than 30). No real fixture was touched; every test fixture is JSON built inside the test.
