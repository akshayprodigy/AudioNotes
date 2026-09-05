# Recording gain normalisation — built, measured, rejected

**Status:** rejected 2026-09-04. Code removed; this document is the reason it should not be
rebuilt without new evidence.
**Supersedes:** the "Non-goals" line in `2026-09-04-english-only-and-refusing-to-fabricate-design.md`
which called recording gain "a real bug, tracked separately".

## The claim that started it

> Fix the recording gain. −24 dBFS is starving every transcript, English included.

That claim was wrong, and it was wrong because of which statistic it came from.

A 61-minute Pixel recording was characterised as "peak −24.3 dBFS, median RMS −56 dBFS". Neither
number describes where the voices are. The peak is a transient — a door, a chair. The median is
silence, which is most of any meeting. Speech sits between them, and nobody measured it.

Measured properly, as the 99.5th percentile of 20 ms frame envelopes:

| source | p50 | **p99.5 (speech)** | max |
|---|---|---|---|
| real phone capture, the Bengali meeting | −52.8 | **−31.5** | −19.2 |
| AMI ES2002a, our reference corpus | −51.9 | **−23.2** | −3.0 |
| AMI ES2002a attenuated 26 dB (synthetic) | −78.3 | **−49.2** | −29.1 |

Real phone capture is **8 dB below the corpus that scores 25–30% WER**, not the 25 dB the original
framing implied. `AudioSource.UNPROCESSED` is quiet. It is not starved.

## What was built

A single constant gain per recording — not AGC, which follows the signal and makes a recogniser see
a different level every window. Level measured as a frame envelope over the whole file, so it needed
no VAD segments and could run before the VAD. Never attenuate, cap the amplification, and refuse to
amplify audio whose dynamic range showed no speech structure.

The design was sound. The premise was not.

## Why it was rejected

Measured on AMI, whisper-base, against the same corpus both ways:

| normal audio (AMI as recorded) | baseline | with normalisation |
|---|---|---|
| ES2002a WER | 29.78% | **33.98%** |
| ES2002a insertions | 174 | **284** |
| ES2002a DER | 28.0% | **40.5%** |
| ES2003a WER | 24.86% | **25.70%** |

Amplifying −23 dBFS speech to −3 dBFS clipped it and lifted the background enough for the VAD to
over-trigger: 110 extra hallucinated words on one meeting. Under the same policy the real phone
recording — 8 dB quieter than AMI — would have received *more* gain than AMI did, and so *more*
damage. **The change would have harmed the exact recordings it was written to rescue.**

## What is worth keeping from it

Three findings, all measured, none dependent on the rejected code:

1. **Level is measured as a frame envelope, never as a percentile of raw samples.** A waveform
   spends most of its samples near zero between peaks, so a per-sample percentile reads roughly
   25 dB low and asks for far too much gain. This error survived one full round of implementation
   and testing before the fixtures caught it.

2. **The VAD is the level-sensitive stage, not the recogniser.** Attenuating AMI by 26 dB cut ASR
   time from 22.3 s to 10.3 s and utterances from 338 to 184: the recogniser was never handed the
   words. whisper normalises its own mel frontend, so it is largely level-invariant; Silero is not.
   Any future work on quiet audio belongs at the VAD, and gain applied after segmentation cannot
   recover a segment that was never emitted.

3. **AMI is not "properly levelled"** — its speech sits at −23 dBFS and only a transient reaches
   −3 dBFS. Any future claim about levels must state which percentile it means.

## What would justify revisiting this

Not a level measurement. A **WER measurement on real phone capture**, showing that recordings in
the −30 dBFS region score materially worse than the corpus at −23 dBFS. That experiment needs
ground-truth English audio recorded on a phone, which is exactly the corpus we do not yet have and
which blocks far more than this.

Until then the honest position is that we have **no evidence level is a problem at all** in the
range real recordings occupy.

## Non-goals confirmed

- Switching `AudioSource` to `VOICE_RECOGNITION` to get OEM AGC. Untested, varies by manufacturer,
  and would not be justified by any evidence gathered here. If capture level is ever shown to
  matter, that is a device A/B experiment, not a code change.
