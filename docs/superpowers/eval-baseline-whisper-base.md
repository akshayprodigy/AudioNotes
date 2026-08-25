# Baseline — whisper-base, 2026-08-24

What the shared core scores today, and what the harness found on its first real pass. Regenerate
the tables with `python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models eval/models`;
re-score saved runs after a metric change with `--rescore <run-dir>`.

Config: `ggml-base-q5_1.bin`, Silero VAD, pyannote segmentation-3.0 + 3D-Speaker CAM++,
auto-clustering, language auto. Desktop (Apple Silicon) — ×realtime does NOT transfer to phones,
where base has measured ~0.68x against ~0.01x here.

## Accuracy — AMI (4 meetings, 1h47m, 16 speakers)

Diarization threshold 1.0 (the new default; the 0.5 column is what shipped before):

| fixture | audio | WER | S | D | I | DER @0.5 -> @1.0 | attribution @0.5 -> @1.0 |
|---|---:|---:|---:|---:|---:|---:|---:|
| ES2002a | 1273s | 30.8% | 329 | 304 | 159 | 60.4% -> **28.7%** | 48.7% -> **86.6%** |
| ES2002b | 2280s | 27.3% | 690 | 1011 | 180 | 33.3% -> **8.5%** | 61.9% -> **92.1%** |
| ES2003a | 1140s | 24.9% | 224 | 224 | 56 | 46.2% -> **15.9%** | 52.9% -> **95.8%** |
| IS1000a | 1583s | 38.1% | 447 | 496 | 100 | 71.9% -> **30.9%** | 25.2% -> **73.8%** |

**WER 29.7%** (4220 errors / 14220 reference words) — published whisper-base on AMI headset audio
sits around 20-30%, so ASR is where it should be for this model.

**DER 18.3%**, down from 48.8%, on one changed constant — confusion time fell from 1190s to
132s while missed (227s) and false alarm (275s) did not move at all. What remains is almost
entirely segmentation, which is a different stage and a different fix.

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

**Resolved: the default is now 1.0** (`cpp/diar/diarizer.h`). Validated on ES2002b and IS1000a,
which took no part in choosing it — DER 33.3% -> 8.5% and 71.9% -> 30.9%, attribution 61.9% ->
92.1% and 25.2% -> 73.8%. The Android path picks it up automatically, since the JNI constructs
Diarizer without an explicit threshold. NOT yet verified on device.

Asking the user how many people are in the room remains available and is now worth less: at 1.0
the sweep beats `--speakers 4` outright, because forcing an exact count makes merges the audio
does not support.

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
| 0.9 | 7 | 18.1% | 91.1% | 21 | 28.9% | 85.9% |
| 0.95 | 7 | 18.1% | 91.1% | 18 | 28.7% | 86.6% |
| **1.0** | 5 | **15.9%** | **95.8%** | 13 | **28.7%** | **86.6%** |
| 1.2 | 3 | 48.3% | 71.2% | 4 | 27.2% | 89.9% |
| `--speakers 4` | 4 | 41.8% | 80.1% | | | |

**The curve turns, and that is what makes 1.0 trustworthy.** At 1.2 ES2003a over-merges to 3
clusters — fewer than the 4 people in the room — and DER snaps back to 48.3%, worse than the
shipped setting. 1.0 is a peak, not the edge of the range that happened to get tested.

Splitting DER into its parts shows the mechanism with no ambiguity:

| | segmentation (missed + false alarm) | confusion |
|---|---:|---:|
| ES2003a @ 0.5 | 14.0% | 32.2% |
| ES2003a @ 1.0 | 14.0% | **1.8%** |
| ES2003a @ 1.2 | 14.0% | 34.3% |
| ES2002a @ 0.5 | 23.1% | 37.3% |
| ES2002a @ 1.0 | 23.1% | **5.6%** |

Segmentation is constant to the decimal at every threshold, because the threshold cannot touch
it. All that moves is confusion, and at 1.0 it is nearly gone: clustering stops being the
bottleneck and the residual DER becomes the segmentation stage, which is a different fix.

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

## Device verification (Pixel 7 Pro, 2026-08-25)

`scripts/device-verify.sh`. 12 instrumented tests pass; the LLM one skips because the Qwen GGUF
is not installed on that phone.

| | measured |
|---|---|
| diarization clusters, single-speaker fixture | **1** — the 1.0 threshold holds on ARM |
| diarization speed | 2.7s for 15s audio (**0.18x realtime**) |
| ASR | 7.8s for 7.8s of detected speech (**0.52x** against total audio) |
| ASR output | "and so my fellow americans ask not what your country can do for you, ask what you can do for your country." — exact |
| VAD | 15s audio to 7.8s speech across 5 segments |
| minutes | byte-identical to the TypeScript goldens |

The diarization number is the one that mattered: the threshold change was chosen on desktop AMI
runs and supersedes behaviour that had been device-verified at the old value. One voice comes
back as one speaker.

What this run does NOT cover: the UTF-8 crash fix. The invalid bytes originate inside C++ from
whisper, and Kotlin strings are always valid UTF-16, so no test on the Kotlin side can inject one
to prove NewStringUTF survives it. `test_utf8` covers the logic on the host; the ARM-specific
risk is low but unmeasured.

Anchoring the model question: base ASR runs at 0.52x realtime here, and small measured 3.8x
slower than base on desktop. If that ratio holds, small lands near **2x realtime on this phone** —
roughly 17 minutes to process an 8.5-minute meeting. Still a ratio applied to a measurement
rather than a measurement, and worth taking directly before it decides anything.

## Caveats that belong on every number here

- AMI is a proxy for regressions, not evidence the product works: 2000s meeting-room audio,
  headset mics, mostly British/European speakers, scenario-driven, monolingual.
- The real meeting has no ground truth yet, so it has no WER or DER — only the failures above,
  which needed no reference to see.
- Overlapping speech is excluded from DER and reported separately (118s / 323s / 32s / 156s).
