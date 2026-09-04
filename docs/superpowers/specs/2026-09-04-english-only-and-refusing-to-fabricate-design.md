# English only, and refusing to fabricate — design

**Status:** implemented 2026-09-04 — 11 C++, 157 JS, Kotlin unit tests green
**Date:** 2026-09-04
**Supersedes:** the "ask the engine for its languages" rationale in `nativeSupportedLanguages()`
and `src/screens/languages.ts`

## What happened

A real 61-minute meeting, five speakers, mostly Bengali, recorded on a Pixel 7 Pro. The transcript
was unusable. The **summary read as broadly correct** to the person who had been in the room.

Measured afterwards on the busiest five minutes, against a control (clean German audio through the
same code, which both engines transcribed correctly — so the pipeline is sound):

| condition | words | Bengali script | Latin | other |
|---|---|---|---|---|
| raw + English + whisper-base | 368 | 0.0% | 100% | — |
| raw + Bengali + whisper-base | 563 | **0.0%** | 99.5% | 0.5% |
| +21.6 dB + Bengali + whisper-base | 493 | **0.0%** | 87.5% | 12.5% |
| +21.6 dB + Bengali + whisper-small | 467 | **0.3%** | 93% | 6.6% |
| +21.6 dB + Bengali + Qwen3-ASR | 695 | **13.1%** | 11.9% | **75%** |

whisper emitted a hallucinated English sentence eleven times over (*"Have you gone to your DBT
program?"*). Qwen wandered into Devanagari **and Thai**. Amplifying the audio did not help, which
rules out level as the cause.

**None of the three models we ship can transcribe Bengali.** And the minutes were plausible anyway,
because the LLM assembled a coherent meeting out of noise and stray English fragments. It read as
correct only because the reader already knew what the meeting was about.

That is the failure this spec exists to make impossible.

## The decision

**Verbale transcribes English. Nothing else, until each language is measured.**

Not hidden, not deprioritised — not offered. A language appears in the picker when there is a
number behind it, one language at a time.

## The rationale being reversed

`nativeSupportedLanguages()` enumerates whisper's full ~99-language table, and says why:

> Asked of the ENGINE rather than written down, because a hand-maintained shortlist drifts from
> what the model can actually do — and the failure that causes is a user unable to select the
> language they are about to speak.

The reasoning is sound and the conclusion is wrong, because it answers the wrong question. The
engine's table is what whisper's *tokenizer* knows, not what this *product* can deliver. Asking the
engine produced a picker offering Bengali, which produced a fabricated summary of a real meeting.

A drifting shortlist means somebody cannot select their language and knows it. An over-promising
list means somebody selects their language, is given fluent nonsense, and **does not know it**. The
second failure is far worse, and it is the one we shipped.

`asr_factory.cpp` already has the right discipline written down — *"Rows are added only when
MEASURED"* — and the picker contradicted it. This makes both read from one table.

## Design

### 1. One table, in C++, read by everything

`cpp/asr/asr_languages.{h,cpp}`:

```cpp
struct Language { std::string code; std::string label; };
const std::vector<Language>& supportedLanguages();
bool isSupported(const std::string& code);
```

One row today: `{"en", "English"}`. It sits beside `prefersQwen`'s routing table because they are
the same kind of claim — a statement about what has been measured — and they must not be able to
disagree.

Adding a language is one row **plus the eval number that justifies it**, recorded in the comment
above it, exactly as `prefersQwen` records Hindi's.

### 2. whisper reports what it heard

`whisper_lang_auto_detect` on the first chunk fills `AsrRun.detected_language`, which already
exists and which only Qwen populates today. One encoder pass over 30 seconds — negligible against
an hour of decoding.

### 3. Detect early, stop, and say so

If the detected language is not supported, the run **stops before transcribing** rather than
producing an hour of noise:

- No transcript is written.
- No minutes, and above all **no LLM narration** — the fabrication cannot happen if the stage never
  runs.
- The meeting is marked with what was heard: *"This recording sounds like Bengali. Verbale
  transcribes English today."*
- **The audio is kept.** The recording is not destroyed for being in the wrong language, and
  Reprocess picks it up the day the language is supported.

Stopping early is not only safer, it is cheaper: an hour of unsupported audio currently costs an
hour of CPU and battery to produce something worthless.

### 4. Confidence, and the cost of being wrong

Detection is not free of error, and the two errors are not symmetric:

- **Refusing English that was really English** loses somebody their meeting. Unacceptable.
- **Accepting Bengali as English** produces the fabrication above. Also unacceptable, but recoverable
  — the audio is kept.

So the check is deliberately reluctant: refuse only when the detector is **confident** the audio is
a language we do not support. Ambiguity, silence, heavy code-switching and low confidence all
resolve to "carry on in English". Indian English meetings code-switch constantly and must not be
refused.

The threshold is a measured number, not a guess, and it belongs in the eval harness.

### 5. Qwen3-ASR becomes unreachable

`prefersQwen` returns true only for `"hi"`. With Hindi out of the picker, nothing selects Qwen, and
offering a **972 MB** download that can never run is user-hostile.

The engine, its tests and the mirror all stay — they work, and they cost nothing dormant. Only the
download is withdrawn from the list, and it returns with Hindi.

## What this costs

Hindi was the reason Qwen was integrated and 972 MB mirrored. Withdrawing it is a real loss for an
India launch. It is still the right call today, because **Hindi has never been measured for
accuracy either** — 69.8% Devanagari says it writes the right script, not the right words. Shipping
it would be the same bet that just failed, at better odds.

Hindi returns first, the moment there is a WER number behind it.

## Non-goals

- Fixing the recording gain (`AudioSource.UNPROCESSED`, −24 dBFS over an hour). A real bug, tracked
  separately; it degrades English too, and it is not what broke Bengali.
- Adding a Bengali model. That is a project, not a fix.
- Per-utterance confidence in the UI. This spec is about refusing whole recordings.

## How we will know it worked

- The picker offers exactly what `supportedLanguages()` contains, asserted by a test.
- A Bengali recording produces a clear refusal and a retained audio file — never a summary.
- An English recording with Hindi and English mixed together is **not** refused.

---

## Outcome — 2026-09-04

Implemented and measured. The threshold in `kRefuseConfidence` is the number this run produced,
not an estimate:

| audio | heard | p | outcome |
|---|---|---|---|
| the real Bengali meeting, as recorded | bn | 0.70 | **refused** |
| the same, amplified 21.6 dB | bn | 0.76 | **refused** |
| clean German | de | 0.998 | refused |
| clean French | fr | 0.995 | refused |
| noisy English | en | 0.987 | transcribed, 365 words |
| heavy code-switching | en | 0.449 | transcribed |

The code-switching sample is what sets the floor at 0.60: mixed speech reads as **low confidence**,
not as a foreign language, so it stays on the transcribing side. Indian English meetings
code-switch constantly and refusing one would be the worse mistake.

Two things the plan did not anticipate:

1. **Android never runs `Pipeline`.** It drives the stages from Kotlin, so the refusal added to
   `pipeline.cpp` covered the CLI and nothing else. `nativeTranscribe` returned a bare JSON array,
   which meant a refused recording would have reached Kotlin as `[]` — indistinguishable from
   silence, the exact confusion the codebase warns about elsewhere. It now returns an object
   carrying `unsupported_language`, and `ProcessingEngine` stops on it.
2. **Qwen3-ASR became unreachable the moment Hindi left the picker**, because the routing table
   sends only `hi` to it. `ModelSpec.offered` withdraws the 972 MB download without deleting the
   row, the hashes or the mirror — `mirror-models.py` still lists all 13 files.

Both guards were mutation-tested: adding `bn` to the table fails `test_asr_languages` on two
assertions, and the suite is green again on revert.
