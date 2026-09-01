# The ASR engine layer — design

**Date:** 2026-09-01
**Status:** Approved (design)
**Platform:** Shared C++ core (desktop CLI + eval harness this cut; Android JNI swap follows)
**Related code:** `cpp/asr/whisper_asr.{h,cpp}`, `cpp/pipeline/pipeline.{h,cpp}`,
`cpp/jni/audionotes_jni.cpp`, `cpp/cli/main.cpp`, `cpp/minutes/llm_prompts.cpp`,
`eval/run.py`, `src/screens/SettingsScreen.tsx`,
`android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt`

## Overview

Verbale transcribes with exactly one engine, whisper.cpp, reached through one concrete class with
no interface. That was the right shape while there was one engine. It is now the thing standing
between the product and the audio its users actually record.

The immediate trigger is Hindi/English. A real meeting came back in five scripts including Korean
and Chinese, because whisper re-detects the language every 30 s chunk. But fixing that by pinning
the language exposes a second problem: whisper-base pinned to `en` on Hindi speech does not
transcribe Hindi, it emits English tokens for Hindi audio. Qwen3-ASR reads the same recording at
1,211 words and 87.6% Devanagari against whisper-base's 891 words and 8.8%.

So the work is not "add a second model". It is to build the layer that lets this product recognise
speech in the language it was spoken in, on any of several engines, in a way that can be measured.

## The product frame

Verbale launches in India, the US and Europe. That sets the rule the whole design follows:

> **Recognition is always faithful. The default is English.**

The app never asks an engine to emit one language for audio in another. Speak English, get
English. Speak German, get German. Speak Hindi, get Hindi. English is the default because most
first meetings will be in English — not because the other paths are second-class.

This is a deliberate reversal of the "switch the default from auto to English" item in
`docs/LAUNCH.md`. Pinning `en` globally is correct for the default case by coincidence and
destroys every other one, irreversibly: once a meeting is stored as invented English, what was
actually said is gone. It also cannot survive a European launch.

## Goals

- One `AsrEngine` interface, several implementations, one place that chooses between them.
- Qwen3-ASR available as a second engine, scored against whisper base and small on the same
  fixtures with the same chunk boundaries.
- Language chosen per meeting from the full set the engines support, defaulting to English.
- Text normalisation applied to every engine's output, once, in one place.
- The whisper path's current output preserved byte-for-byte across the refactor, provably.

## Non-goals

- No Android/JNI swap in this cut. `ProcessingEngine` keeps calling `nativeTranscribe`; the
  factory argument it passes changes in the follow-up.
- No `ModelCatalog` multi-file support, no VPS mirroring, no tier gating. Those wait on the
  "where does the 955 MB model live" decision.
- No streaming or transcribe-during-recording. Still blocked on model reload and streaming VAD.
- No change to diarization, VAD, or the minutes extractor beyond the output-language parameter.

## What is actually broken

Six defects, all in the current ASR path. The missing engine is the least of them.

### 1. Unbounded chunks

`whisper_asr.cpp:48-58` starts a new chunk only when appending the next VAD span would exceed
30 s. A single span *longer* than 30 s becomes one chunk of its full length — a four-minute
monologue is a four-minute chunk. Whisper hides this by re-windowing internally. Qwen3-ASR would
silently discard everything past roughly 38 s of it: `offline-recognizer-qwen3-asr-impl.cc:689`
clamps `audio_token_len` to fit `max_total_len` with only a debug-level warning.

### 2. Hard cut boundaries with no context

`wparams.no_context = true`, and chunks are butt-joined at VAD edges. A word spanning a boundary
is lost or doubled, and there is no overlap or merge. The UTF-8 fragment crash this codebase
already fixed was a symptom of exactly this, patched where it hurt rather than where it came from.

### 3. Normalisation trapped inside whisper's decode loop

`sanitizeUtf8` and `stripDialogueDash` are applied at `whisper_asr.cpp:145-152`, inside the
per-segment loop of one engine. A second engine that does not replicate them reintroduces a
`nlohmann::json::dump` `type_error.316` (SIGABRT after a whole meeting has processed) and a JNI
`NewStringUTF` VM abort. Cleaning model output is a property of the layer, not the etiquette of
each engine author.

### 4. Engine failures are swallowed

`whisper_full(...) != 0` at `whisper_asr.cpp:130` falls through to `continue`. A meeting in which every chunk failed
produces an empty transcript that `ProcessingEngine` then logs as "no speech detected". The two
most different outcomes in the pipeline are indistinguishable to the user and to us.

### 5. No provenance

`AudioDb.setLanguage` records the language a meeting was transcribed in. Nothing records which
engine ran, which model file, or what the engine detected. A user reporting a garbled meeting
cannot be answered.

### 6. No interface

`WhisperAsr` is concrete, constructed at `pipeline.cpp:117` and `audionotes_jni.cpp:106`, and it
owns the `Utterance` type that `pipeline.h` includes it for. Every one of the above is harder to
fix because there is no seam to fix it behind.

## Design

### 1. `cpp/asr/asr_engine.h` — the interface

Declares `Utterance`, `AsrProgressFn`, `AsrCancelFn` — moved out of `whisper_asr.h`, which is the
wrong home for them the moment a second engine returns the same type — and:

```cpp
class AsrEngine {
 public:
  virtual ~AsrEngine() = default;
  virtual bool ok() const = 0;
  virtual const char* name() const = 0;       // "whisper" | "qwen3" — recorded as provenance
  virtual int64_t maxChunkMs() const = 0;     // the engine's own audio budget
  virtual bool supports(const std::string& lang) const = 0;
  virtual AsrRun transcribe(const std::string& pcm_path,
                            const std::vector<Segment>& segments,
                            int sample_rate, int threads,
                            const AsrProgressFn&, const AsrCancelFn&) = 0;
};
```

Only three files include `whisper_asr.h` today (`pipeline.h`, `whisper_asr.cpp`,
`audionotes_jni.cpp`), so the move is contained.

### 2. `AsrRun` — the return type

`transcribe` stops returning a bare vector. It returns:

```cpp
struct AsrRun {
  std::vector<Utterance> utterances;
  int chunks_total = 0;
  int chunks_failed = 0;      // closes defect 4
  bool cancelled = false;
  std::string engine;         // provenance
  std::string model_path;
  std::string language;       // what was requested
  std::string detected_language;  // what the engine reported, where it can; "" otherwise
};
```

`chunks_failed == chunks_total && chunks_total > 0` is the state that must never again be
reported as silence.

### 3. The factory and its policy table

`makeAsrEngine(const AsrConfig&)` is the only code that maps a language to a class. Not inference,
not magic — an explicit, readable table:

| Requested language | Preferred engine | Reason |
|---|---|---|
| `en` and the other ~99 whisper covers | whisper | The international floor: fast, 60 MB, free tier |
| `hi` | Qwen3-ASR | 1,211 words vs 891; 87.6% Devanagari vs 8.8%; 1.0% Urdu junk vs 21.1% |

Fallback is explicit and recorded: if the preferred engine's model is not installed, the factory
falls back to one that is, and `AsrRun.engine` says which ran. A Hindi meeting transcribed by
whisper because Qwen was not downloaded is a legitimate, inspectable outcome — not a silent
downgrade. CJK joins the Qwen row only once measured; the table is not a place for guesses.

`AsrConfig` carries `engine` (`""` = choose by policy, or an explicit override for the eval
harness), `model_path`, and `language`.

### 4. Qwen's four artifacts resolve from one directory

Qwen3-ASR needs `conv_frontend.onnx`, `encoder.onnx`, `decoder.onnx` and a `tokenizer/` directory.
`AsrConfig::model_path` stays a single string: for whisper it is a file, for Qwen a directory, and
the engine resolves its own artifacts from it by convention.

This keeps the CLI, the JNI and the eval harness all passing one string, and it pre-answers the
`ModelSpec` problem in the follow-up work: the catalog gains one directory-shaped entry rather
than four file-shaped ones.

### 5. `cpp/asr/asr_chunker.{h,cpp}` — shared, and correct

`makeChunks(segments, max_chunk_ms)` lifted out of `whisper_asr.cpp:48-58`, with the hard split it has
never had: a VAD span longer than the budget is *cut*, not passed through whole. Each engine
declares its budget via `maxChunkMs()`.

Both engines therefore see identical chunk boundaries at the same cap, which is what makes their
WER numbers comparable rather than partly an artefact of how each one happened to slice the audio.

Boundary overlap and merge is included: chunks overlap by a small margin and the merge drops the
duplicated tail, so a word spanning a cut survives instead of being halved. This is the cause-level
fix for defect 2, and it is what the UTF-8 scrub has been compensating for.

### 6. `cpp/asr/asr_postprocess.{h,cpp}` — one normalisation stage

`sanitizeUtf8` and `stripDialogueDash` move here and are applied by the layer to every engine's
output. Engines return raw model text; they do not clean it. This is the change that stops the
`json::dump` and `NewStringUTF` crashes from returning through a new engine.

### 7. Language, end to end

`SettingsScreen.tsx:111` hard-codes three choices — `auto`, `en`, `hi`. That is an India-only list
in a product launching in the US and Europe.

The list is instead **enumerated from engine capability** via `whisper_lang_max_id()`,
`whisper_lang_str()` and `whisper_lang_str_full()` (`whisper.h:358-376`), surfaced through the
existing JNI bridge. Default `en`. The handful the product supports well are pinned to the top of
the list; the rest follow alphabetically. `auto` remains available but stops being the default,
because per-chunk re-detection is the original bug.

### 8. Output language for the minutes

`llm_prompts.cpp` contains no language instruction at all, so minutes come out in whatever
language the model drifts to. It gains an explicit output language, defaulting to the language the
meeting was recognised in. English in, English out — stated rather than lucky.

## Data flow

```
VAD segments ─▶ asr_chunker (engine budget, hard split, overlap)
                   │
                   ▼
             AsrEngine::transcribe          whisper.cpp  │  sherpa-onnx Qwen3-ASR
               (raw model text)             pinned lang  │  SetOption("language", …)
                   │
                   ▼
             asr_postprocess (UTF-8 scrub, dash strip, boundary merge)
                   │
                   ▼
                AsrRun ──▶ pipeline align ──▶ minutes (output language)
                   │
                   └─▶ provenance: engine, model, language
```

Qwen receives its language hint through `SherpaOnnxOfflineStreamSetOption(stream, "language", …)`
(`c-api.h:1382`), the same `asrLanguage` value whisper is pinned with. This is the fix for the
Chinese-leak finding: one chunk in eight returning Mandarin from Hindi audio is what an unhinted
Chinese-team model does. Rather than filter the output, the eval harness reports a per-fixture
script histogram (Devanagari / Latin / CJK / Arabic %) so the leak is a number in the results. A
filter written before we know whether anything gets through would be dead code that can silently
delete real speech.

## Error handling

| Condition | Behaviour |
|---|---|
| Model file/dir missing or unreadable | `ok() == false`, construction succeeds, run reports the reason. sherpa segfaults on unreadable paths — the `Diarizer::readable` guard is reused. |
| Single chunk fails to decode | Counted in `chunks_failed`, run continues |
| Every chunk fails | Surfaced as a failure, never as "no speech detected" |
| Preferred engine unavailable | Explicit fallback, recorded in `AsrRun.engine` |
| Cancel requested | Polled between chunks as today; partial utterances kept, `cancelled` set |
| Chunk exceeds engine budget | Impossible — the chunker enforces `maxChunkMs()` |

## Testing

There are no ASR characterization tests. `cpp/tests/golden/` holds seven files, all
`minutes_*.json`. This is the gap that decides whether the rewrite is safe, so closing it comes
first, before any restructuring:

1. **Pin current behaviour**, in two layers, because they have different costs:

   *Pure tests* (`cpp/tests/test_asr_chunker.cpp`, no models, run in CI): `makeChunks`'s current
   boundaries asserted exactly as they are today — including the over-long span it gets wrong, so
   commit 6's fix shows up as an intentional diff to a test rather than a silent behaviour change.

   *Characterization* (`eval/characterize.py`, needs whisper-base and a fixture, run by hand
   before and after): the CLI's full JSON output on a fixed fixture, stored and diffed. This is
   what proves commits 2-4 changed nothing. It cannot live in CI because it needs 60 MB of
   weights, and pretending otherwise would produce a test that is skipped and therefore lying.
2. **Refactor against them.** The interface extraction must reproduce whisper's output
   byte-for-byte. Any diff is a bug, and it shows up in the commit that caused it.
3. **Add Qwen** behind an interface that is already passing.
4. **Then fix the chunker**, as a deliberate behaviour change with its own updated golden.

New unit tests: chunker hard-split and overlap-merge; post-process applied to every engine;
`AsrRun` failure accounting; factory policy selection and fallback.

## Commit sequence

Each commit is independently revertable, and whisper's shipping behaviour is provably unchanged
until commit 6, which is the only one that intends to change it.

| # | Commit | Risk |
|---|---|---|
| 1 | Golden ASR fixtures + chunker unit tests pinning today's behaviour | None — tests only |
| 2 | Extract `AsrEngine`, `AsrRun`, move `Utterance`; `WhisperAsr` implements it | Proven by 1 |
| 3 | Extract `asr_chunker` and `asr_postprocess`, behaviour identical | Proven by 1 |
| 4 | `makeAsrEngine` factory + policy table; CLI `--asr-engine`; call sites use it | Proven by 1 |
| 5 | `Qwen3Asr` engine over sherpa-onnx, language hint, artifact resolution | New path only |
| 6 | Chunker hard split + overlap merge; golden updated deliberately | Intentional change |
| 7 | Eval harness: `--asr-engine`, script histogram, per-engine results | Harness only |

Separate, ahead of all of it: the language default commit — `en` instead of `auto` in
`whisper_asr.h`, `PipelineConfig`, `cli/main.cpp`, the JNI empty-string case, `ProcessingEngine`
and `SettingsScreen` — applying to every install that has not explicitly chosen.

## Rejected

**A standalone `Qwen3Asr` with an if/else at each call site.** Smallest blast radius, but the
branch duplicates in `pipeline.cpp` and the JNI, `Utterance` stays misfiled, and the shared-chunker
decision means `whisper_asr.cpp` changes anyway — so the benefit is illusory.

**One `Asr` class with a backend enum.** Fewest files, but one translation unit holding a ggml
engine and an ONNX engine with interleaved `#ifdef`s. Hard to read, and the opposite of bounded
units.

**A CJK output filter for the Chinese leak.** Deferred until the language hint is measured. A
threshold guessed before the evidence exists can silently delete real speech from a meeting.

**Forcing `en` globally, per `docs/LAUNCH.md`.** Correct for the default case by coincidence,
destroys every other one, and cannot survive a European launch. Superseded by the rule above.

## Still open

These do not block this cut, and are recorded so they are not lost:

- **Where the 955 MB Qwen model lives.** Free tier is 114 MB. Gates `ModelCatalog` and the mirror.
- **Whether Qwen is Pro-only.** Gates `needsSubscription`, which is keyed by id today.
- **The corrected ground-truth transcript.** `eval/fixtures/real-neosym-2026-08-19/truth.draft.txt`
  is still machine output. Every Hinglish accuracy claim is unmeasurable until a human fixes it.
  This design makes scoring a one-flag operation the moment it lands.
- **CJK routing.** Qwen may beat whisper on Chinese and Japanese too. Not in the policy table
  until measured.

## Estimate

Four to five days, against the two to three `docs/LAUNCH.md` budgets for "add a Qwen3-ASR
backend". The difference is the golden-test scaffolding (commit 1) and the chunker fix (commit 6),
neither of which was in the original estimate and both of which are real work. Flagged before
starting rather than discovered on day three.
