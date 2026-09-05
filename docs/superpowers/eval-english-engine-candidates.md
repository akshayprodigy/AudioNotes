# The English engine swap: Parakeet-TDT and Moonshine against whisper-base

**Measured 5 September 2026.** Answers `docs/NEXT.md` §1 item 3. Baseline and methodology:
`docs/superpowers/eval-baseline-whisper-base.md`.

English is the whole product, so its error rate is the product's error rate. whisper-base measures
WER 29.7% on AMI. This is what the two published alternatives actually do on the same four
meetings, through the same VAD spans, the same 30 s packing budget and the same runtime.

---

## The answer

**Parakeet-TDT is a third more accurate than whisper-base, and cannot ship as it stands.**

| engine | download | WER | vs whisper | peak RSS | ASR ×realtime |
|---|---:|---:|---:|---:|---:|
| whisper-base q5_1 | **57 MB** | 29.0% | — | 422–654 MB | 0.006–0.009x |
| Moonshine base en int8 | 287 MB | 27.2% | −6% rel | 975–1251 MB | 0.015–0.022x |
| **Parakeet-TDT 0.6B v2 int8** | **661 MB** | **20.2%** | **−30% rel** | **1576–1711 MB** | 0.018–0.022x |

Per fixture, all on identical audio:

| fixture | audio | whisper | Moonshine | Parakeet |
|---|---:|---:|---:|---:|
| ES2002a | 1273s | 33.0% | 30.6% | **22.6%** |
| ES2002b | 2280s | 26.1% | 24.3% | **17.9%** |
| ES2003a | 1140s | 24.9% | 24.3% | **15.3%** |
| IS1000a | 1583s | 35.6% | 33.6% | **27.4%** |
| **overall** | | **29.0%** | **27.2%** | **20.2%** |

Parakeet wins on every fixture, by 8–10 points each time. The published ~16% claim is
directionally real and reproduces here at 20.2% on meeting audio.

---

## What stops it shipping

### 1. It returns an empty string on quiet audio, and reports success

The first run came back **20.7% / 73.3% / 69.7% / 27.4%** — bimodal, and not a quality signal.
Two fixtures had **0% silent windows**; two had **~60% of decode windows return no text at all**.
Those windows contain ordinary speech, which whisper reads without difficulty:

    empty_w1  ->  whisper:  "Well, I think we're ready to begin. Right. My name's Adam Diggard…"
    empty_w1  ->  Parakeet: (nothing)

Gain is the only variable that moves it:

| clip | RMS | ×1 | ×2 | ×3 | ×4 | ÷4 |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `empty_w1` | −40.8 dBFS | ✗ | ✗ | ✓ | ✓ | — |
| `text_w3` | −40.9 dBFS | ✓ | — | — | — | ✗ |

Those two are **0.1 dB apart**, with near-identical exact-zero content (3.44% vs 3.80%), and land
on opposite sides. So the cliff is not predicted by level alone — AMI sits on its edge, and which
side a given window falls is close to a coin flip. That is why the failure looked like a property
of the *meeting* rather than of the window.

Ruled out, by reading sherpa's own debug output rather than by guessing:

- `model_type="nemo_transducer"` is correct. sherpa detects TDT itself via `IsTDT()` and logs
  `TDT model. vocab_size: 1025, num_durations: 5`.
- Features are right: `feat_dim=128` (sherpa overrides our config from model metadata),
  `normalize_type=per_feature`, `subsampling_factor=8`.
- **sherpa reports no error and no warning.** The recognizer returns an empty string and the
  process exits 0.

**This is the worst failure mode this product has.** It is the cousin of the 43-invented-words bug
in `8ea6f60`: instead of fabricating a meeting it deletes one, and looks identical to a quiet room
either way. `docs/NEXT.md` §0 says cheap-phone testing is the highest-yield activity in the
project because a Galaxy A07 found three bugs in one meeting — a phone with a poor mic is exactly
the audio that lands under this cliff.

Moonshine does **not** have it. On the original, ungained ES2003a it scores 23.8%, against 24.3%
on the gained copy — level-robust, like whisper.

### 2. Size and memory

661 MB against whisper-base's 57 MB, a **11.6x** increase, on top of a first-run download that is
already ~114 MB. Peak RSS is **1.7 GB** against whisper's 0.5 GB. On a 4 GB phone — the class of
device §1 item 2 is about — that is a plausible OOM, and it is not a tuning problem.

The one variant that would fit the size budget, `sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en`,
is an **empty repository** on HuggingFace: `.gitattributes` and nothing else.

### 3. Speed

Parakeet's ASR stage costs **2.4–2.9x** whisper's on the same audio (Moonshine 2.0–2.5x). Desktop
×realtime does not transfer to phones, but the *ratio* between two engines on one machine largely
does. whisper-base measures 0.68x realtime on a Pixel 7 Pro, so Parakeet extrapolates to somewhere
near 1.6x — a 90-minute meeting taking over two hours. §1 item 5 exists to measure that number for
whisper; it would need re-asking for any swap.

---

## Method, and what these numbers do not say

**Both engines were given whisper's chunking**, not their own comfortable window: 30 s budget,
`kPack`, 12 s maximum merge gap. `asr_chunker.h` states the rule — two engines' numbers are
comparable only if they see identical boundaries, because a WER gap that is really a chunking
artefact is worse than no measurement.

**The gain normalisation is applied to all three engines equally.** Each fixture was RMS-normalised
to −32 dBFS, never attenuated, clipping ≤0.004% of samples. IS1000a was already loud enough and
received ×1.00 — and scored 27.4% both with and without, which is the control that says the
normalisation itself is not doing the work. whisper scores 29.0% on the gained audio against 29.7%
on the original, so gain moves whisper by 0.7 points and Parakeet by more than 30.

**Ignore the DER and attribution columns for the two new engines.** Both return one untimestamped
result per decode window, so a 30 s window carries a single speaker label where whisper produces
several. Parakeet's DER of 38.2% against whisper's 19.1% measures that shape difference, not
diarization quality. Only WER is comparable, because WER concatenates the whole meeting on both
sides before aligning and cannot see utterance boundaries at all.

**AMI is British and European meeting-room speech from the 2000s.** §1 item 4 — an accent-diverse
English test set — is unbuilt, so none of this is evidence about American, Australian, Indian,
Singaporean or Scottish speakers. A 30% relative gain on one corpus is a reason to keep going, not
a reason to swap.

---

## What follows

1. **Do not swap on this evidence.** The accuracy is real; the silent-empty failure is
   disqualifying on its own, and size and speed are each independently serious.
2. **The cliff needs a root cause, not a workaround.** It is upstream of us — in the int8 export,
   or in sherpa's NeMo feature path. Worth checking the fp16 export
   (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-fp16`) and v3 before concluding it is inherent to the
   model, because "int8 quantisation collapses on low-energy features" is a testable and quite
   likely story.
3. **This couples to a parked decision.** `docs/NEXT.md` §5 parks recording gain normalisation —
   "Built, measured, rejected", `2026-09-04-recording-gain-rejected.md`. That rejection was
   measured against whisper, which is level-robust. If Parakeet ever becomes the engine, gain stops
   being an optional improvement and becomes a precondition. §5 says do not re-raise without new
   evidence; this is new evidence, and it applies only in the world where the swap happens.
4. **Moonshine is not worth it.** 5x the download for a 6% relative gain, and it is slower. Its one
   virtue is that it has no cliff.

Reproduce:

    python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models eval/models \
      --fixtures eval/fixtures-gain \
      --asr-engine parakeet --sherpa-model eval/models/parakeet-tdt-0.6b-v2-int8

`SHERPA_DEBUG=1` turns on sherpa's own model-loading diagnostics, which is how the feature
dimension and TDT detection above were confirmed rather than assumed.
