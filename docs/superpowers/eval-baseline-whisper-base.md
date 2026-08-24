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

**2. whisper-base picks the wrong language.** The meeting is Hindi/English code-switched. Which
script each model chose for its 133 / 68 utterances:

| model | language | Arabic/Urdu | Devanagari | Latin only | repeated lines | ASR (509s audio) |
|---|---|---:|---:|---:|---:|---:|
| base | `auto` (shipped) | **37** | 12 | 84 | 27 (20%) | 35s |
| base | `en` | 0 | 0 | 140 | 23 (16%) | 12s |
| small | `auto` | **0** | 59 | 9 | 2 (3%) | 135s |
| small | `en` | 0 | 0 | 99 | 15 (15%) | 25s |

base with `auto` writes **Arabic script for Hindi speech** in 37 utterances and flip-flops across
three scripts in one meeting, because `no_context` is set and the language is re-detected every
30s chunk. base pinned to `en` stops that and starts hallucinating instead: "And that's what
we've posted." six times over speech that says nothing of the sort. That failure is the more
dangerous one — wrong script is visibly wrong, invented fluent English is not, and it flows into
the minutes as a real sentence.

**small fixes the language identification outright**: no Urdu, Devanagari for the Hindi, Latin
for the English, and the hallucination loops largely stop (3% repeated lines against base's 20%).
The Devanagari itself is phonetic and rough — "अकाुंट खुल्डर" for "account holder" — so this is
"the right language, badly spelled", not "solved". How badly is unmeasurable until the recording
has a corrected reference.

The cost is speed: 135s against 35s for the same audio, 3.8x. base measures ~0.68x realtime on a
Pixel 7 Pro against ~0.07x here, so small extrapolates to roughly **2.6x realtime on device** —
an 8.5 minute meeting would take something like 22 minutes to transcribe. That is an
extrapolation from one device measurement, not a measurement, and it needs checking on hardware
before it drives a decision.

## The diarization threshold sweep

`--diar-threshold`, auto-clustering, against 4 real speakers per meeting:

| threshold | ES2003a clusters | DER | attribution | ES2002a clusters | DER | attribution |
|---|---:|---:|---:|---:|---:|---:|
| 0.5 (shipped) | 28 | 46.2% | 52.9% | 62 | 60.4% | 48.7% |
| 0.6 | 23 | 41.5% | 59.7% | 52 | 59.3% | 49.3% |
| 0.7 | 19 | 25.7% | 81.2% | 36 | 37.7% | 70.3% |
| 0.8 | 10 | 23.4% | 85.3% | 25 | 33.6% | 78.4% |
| 0.9 | 7 | **18.1%** | **91.1%** | 21 | **28.9%** | **85.9%** |
| `--speakers 4` | 4 | 41.8% | 80.1% | | | |

Missed and false-alarm time are IDENTICAL across every threshold (54s / 31s on ES2003a) — only
confusion moves, 195s at 0.5 down to 71s at 0.7. One parameter, one error bucket, which is what
makes this a clean result rather than a coincidence. The remaining DER is segmentation, which no
clustering threshold can touch.

**The floor that makes these numbers legible:** collapse every utterance into ONE cluster and
score that. ES2003a gets DER 64.9% / attribution 53.6%, ES2002a DER 69.4% / attribution 50.6%.
Any real result has to beat that, or the sweep is only riding toward a degenerate answer.

It also says something uncomfortable about what ships today. At threshold 0.5, attribution is
52.9% and 48.7% — i.e. **the shipped diarization is no better at putting the right name on an
utterance than assigning the entire meeting to a single speaker**, and on ES2002a it is
marginally worse. The high thresholds clear the floor by 35+ points, so they are measuring
something real.

Note that 0.8 beats forcing the true speaker count. Forcing exactly 4 clusters makes bad merges
where the audio does not support them; a higher merge threshold leaves the uncertain fragments
in small clusters of their own instead, where they cost far less.

## Caveats that belong on every number here

- AMI is a proxy for regressions, not evidence the product works: 2000s meeting-room audio,
  headset mics, mostly British/European speakers, scenario-driven, monolingual.
- The real meeting has no ground truth yet, so it has no WER or DER — only the failures above,
  which needed no reference to see.
- Overlapping speech is excluded from DER and reported separately (118s / 323s / 32s / 156s).
