# Whose English does this work for?

**Measured 5 September 2026.** Answers `docs/NEXT.md` §1 item 4. Baseline and methodology:
`docs/superpowers/eval-baseline-whisper-base.md`. Corpus tooling: `eval/corpus/edacc.py`.

Until today the only English benchmark here was AMI — British and European meeting speech recorded
in the 2000s on headset mics — and the launch is global. "Our WER is 29.7%" was a number with no
answer to *for whom*.

Six EdAcc conversations, whisper-base, the shipping configuration.

---

## The answer

**No accent falls off a cliff.** The spread is 23.3% to 30.2% — under seven points end to end,
with every fixture landing in the same band as the AMI meetings (24.9%–35.6%). There is nothing
here like the Bengali or Hinglish failures that produced the English-only decision.

| fixture | self-reported accent | WER | S | D | I | DER | attribution |
|---|---|---:|---:|---:|---:|---:|---:|
| edacc-C31_P1 | American | **23.3%** | 128 | 226 | 107 | 12.0% | 92.6% |
| edacc-C08 | Scottish (Fife); Scottish inflections | **23.4%** | 297 | 216 | 49 | 21.7% | 93.1% |
| edacc-C09 | Indian | 26.6% | 366 | 462 | 86 | 19.0% | **79.1%** |
| edacc-C35_P1 | Kenyan; African | 27.1% | 603 | 446 | 87 | 21.8% | 88.8% |
| edacc-C32_P2 | Southern London | 29.8% | 324 | 177 | 54 | **41.9%** | 91.8% |
| edacc-C29_P1 | Nigerian; African | **30.2%** | 827 | 810 | 119 | 11.7% | 88.1% |

## Three things worth knowing

### Scottish is not the problem everyone assumes

23.4%, a tenth of a point behind American, and the best diarization attribution in the set. The
intuition that a strong regional British accent is the hard case does not survive contact with the
measurement — and it was the intuition behind putting Scottish speakers on the list.

### "Native versus non-native" does not predict anything

Southern London — a native British accent, and the closest thing here to AMI's own speakers —
scores 29.8%, second worst. Nigerian English scores 30.2% and Indian English 26.6%. The ordering
does not sort by first language, so the mental model to drop is "L1 good, L2 bad".

### Indian English loses the speaker, not the words

26.6% WER, better than three of the four AMI meetings — but **79.1% attribution**, the worst in
the set, with 113s of confusion against 15s of false alarm. The words are transcribed and handed
to the wrong person.

That is the diarization embedding model, not the recogniser, so no ASR change fixes it. It matters
because India is a named launch market and because wrong attribution is, per the research, the top
diarization complaint the whole category gets. It also sharpens §2's "reassign the speaker on a
turn" from a nice-to-have into the mitigation for a measured defect.

Southern London's 41.9% DER is a different failure — 246s *missed*, by far the worst, which is
segmentation dropping speech rather than confusing speakers.

---

## What this does not say

**These numbers are not comparable with the AMI ones.** EdAcc is two people on a video call with
decent microphones; AMI is four people in a meeting room. Fewer speakers and cleaner audio make
for an easier task, so reading "23.3% American beats 29.7% AMI" as "Americans are served better
than the AMI speakers" is wrong. The comparison that holds is **between accents inside this
table**, where the task is held constant.

**One conversation per accent, two speakers each.** A few points between neighbouring rows is well
within what two different people talking about a different subject would produce. This is a smoke
test for gross disparity — which it did not find — and not a powered study. Treat the ordering as
weak evidence and the *absence of a cliff* as the real result.

**Australian and Singaporean are still unmeasured.** Both are named markets; EdAcc contains
neither. They stay open, and they are what a recording session should target if one happens.

**Accents are self-reported, verbatim.** "Afrian", "Scottish (Fife)", "English with Scottish
inflections" are the speakers' own words. Re-bucketing them into tidy categories would be
inventing precision, and EdAcc's own README warns its derived L1/L2 labels are not fully reliable.

**Read-aloud passages are excluded.** Every EdAcc conversation opens with a control passage in a
different speaking style; EdAcc excludes it from its own scoring and so does the fixture builder,
via `scored_from_ms`. The footnoted rows are scored from the end of that passage.

---

## Two harness bugs this uncovered

Both were the same latent assumption — that a partial reference always has *both* ends — and
neither could fire until a fixture set a lower bound alone.

1. **`_within` crashed on an open-ended range.** `lo <= mid < None` raises TypeError. Every
   fixture that had ever used `scored_from_ms` also set `scored_to_ms`, so it had never run. Five
   of the six new fixtures hit it. Both ends are now independently optional.
2. **`report.render` divided `None` by 1000** formatting the same footnote, for the same reason.

And one robustness fix alongside them: a fixture with no `truth.json` took the entire run down
with a `FileNotFoundError` **after** every other fixture had been transcribed, so an hour of
inference was thrown away and no report was printed. Missing audio was already a skip; a missing
reference now is too.

---

## Reproduce

    python3 -m eval.corpus.build_edacc --list          # conversations and whose accents
    python3 -m eval.corpus.build_edacc EDACC-C09      # build one fixture
    python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models eval/models

The corpus is a single 5.5 GB archive from Edinburgh DataShare (CC BY-SA 4.0), cached under
`eval/corpus/_cache/edacc`. DataShare serves one connection at about 0.3 MB/s but honours range
requests, so fetching it in ten parallel ranges takes ~45 minutes instead of five hours.
