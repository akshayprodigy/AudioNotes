# Baseline — whisper-base, 2026-08-24

What the shared core scores today, and what the harness found on its first real pass. Regenerate
the tables with `python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models eval/models`;
re-score saved runs after a metric change with `--rescore <run-dir>`.

Config: `ggml-base-q5_1.bin`, Silero VAD, pyannote segmentation-3.0 + 3D-Speaker CAM++,
auto-clustering, language auto. Desktop (Apple Silicon) — ×realtime does NOT transfer to phones,
where base has measured ~0.68x against ~0.01x here.

## Accuracy — AMI (4 meetings, 1h47m, 16 speakers)

| fixture | audio | WER | S | D | I | DER | attribution |
|---|---:|---:|---:|---:|---:|---:|---:|
| ES2002a | 1273s | 30.8% | 329 | 304 | 159 | 60.4% | 48.7% |
| ES2002b | 2280s | 27.3% | 690 | 1011 | 180 | 33.3% | 61.9% |
| ES2003a | 1140s | 24.9% | 224 | 224 | 56 | 46.2% | 52.9% |
| IS1000a | 1583s | 38.1% | 447 | 496 | 100 | 71.9% | 25.2% |

**WER 29.7%** (4220 errors / 14220 reference words) — published whisper-base on AMI headset audio
sits around 20-30%, so ASR is where it should be for this model.

**DER 48.8%** over 3465s of scored speech, and the split says where it comes from: confusion
1190s against missed 227s and false alarm 275s. Segmentation is roughly fine; the *clustering* is
the problem.

## The finding: auto-clustering does not cluster

Hypothesis clusters per meeting, against 4 real speakers each:

| ES2002a | ES2002b | ES2003a | IS1000a |
|---:|---:|---:|---:|
| 62 | 62 | 28 | 101 |

One decisive run — the same audio with `--speakers 4`, forcing the true count:

| ES2003a | clusters | DER | attribution |
|---|---:|---:|---:|
| auto | 28 | 46.2% | 52.9% |
| `--speakers 4` | 4 | 42.1% | **80.1%** |

Attribution goes from a coin flip to 80% on the strength of the speaker count alone. The
embeddings separate speakers perfectly well; the auto mode's merge threshold (0.5, sherpa's
default, `cpp/diar/diarizer.cpp`) is simply wrong for CAM++ on this audio, so it splits one
person into dozens of clusters.

DER improves much less than attribution because DER is time-weighted and the remaining error is
segmentation (missed + false alarm), which forcing the count cannot touch. Attribution is the
user-visible half — it is what decides whether an action item gets the right name next to it.

Two levers, both cheap: tune the threshold (`--diar-threshold` now exists for exactly this
sweep), or ask the user how many people are in the room. The app already has a manual Speakers
screen, so the second is a product decision, not a research problem.

## The other finding: the real meeting

A user-supplied Hindi/English meeting (8.5 min, online-meeting capture) surfaced two things AMI
structurally cannot, because AMI is monolingual British English recorded on headsets in 2005.

**1. It crashed the pipeline.** whisper emitted a byte that is not valid UTF-8 — a character
split across a chunk boundary — and nlohmann's `dump()` threw on it, uncaught, *after* the entire
meeting had been transcribed, diarized and summarised. Exit 134. The Android path reaches the
same byte through `NewStringUTF`, which aborts the ART VM. Fixed at the source in `cpp/util/utf8`
and covered by `test_utf8`; a run that used to lose everything now completes.

**2. whisper-base cannot transcribe code-switched Hinglish**, and it fails in two different ways
depending on the language setting:

| language | foreign-script utterances | repeated lines | ASR time |
|---|---:|---:|---:|
| `auto` (shipped) | 49 / 133 (37%) | — | 35s |
| `en` | 0 | 23 / 140 | 12s |

With `auto`, whisper re-detects per 30s chunk (`no_context` is set), lands on Hindi or Urdu, and
writes **Arabic script for Hindi speech** — one meeting comes back in three scripts. With `en`
pinned it stops doing that and starts hallucinating fluent English instead: "And that's what
we've posted." appears six times in a row over speech that says nothing of the sort.

The second failure is the more dangerous one. Wrong script is visibly wrong. Fluent invented
English is not, and it flows straight into the minutes as though it were a real sentence.

Neither is a setting problem. `--language` exists now so the choice can be measured, but the
honest reading is that the model is too small for this audio, and the next question is whether
`ggml-small-q5_1` (already in `ModelCatalog.kt`) clears the bar.

## Caveats that belong on every number here

- AMI is a proxy for regressions, not evidence the product works: 2000s meeting-room audio,
  headset mics, mostly British/European speakers, scenario-driven, monolingual.
- The real meeting has no ground truth yet, so it has no WER or DER — only the failures above,
  which needed no reference to see.
- Overlapping speech is excluded from DER and reported separately (118s / 323s / 32s / 156s).
