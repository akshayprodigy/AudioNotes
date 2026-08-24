# Phase 1b — Accuracy Eval Harness (Design)

Date: 2026-08-24
Status: Approved for planning
Type: Sub-project spec (Phase 1b of the in-person MOM roadmap)
Parent: `docs/superpowers/specs/2026-08-12-in-person-mom-cross-platform-roadmap.md`

## 1. Goal

Put a number on transcript, attribution, minutes, and speed quality, so Phase 2 accuracy work can be
engineered instead of guessed at.

Today every accuracy claim about AudioNotes rests on reading a couple of sample outputs. Phase 2 is
*entirely* accuracy work — multilingual Whisper tiers, promoting the LLM to primary minutes writer,
diarization tuning — and none of it is decidable without measurement: swap whisper-base for a
multilingual small model and nobody can currently say whether it helped.

Phase 1b delivers a harness that runs the shared core over a benchmark set and reports:

- **Transcript** — Word Error Rate
- **Attribution** — diarization error rate, and % of action items with the right speaker
- **MOM quality** — recall of true decisions/actions/questions, plus a hallucination check
- **Performance** — × realtime per stage and peak RSS (the device→tier matrix inputs, §5 of the roadmap)

Note the roadmap's other Phase 1b item — porting minutes + the LLM map-reduce into C++ so the CLI
emits a full MOM — **is already done**, delivered in the Phase 1a orchestrator slice. Only the
scoring half remains.

## 2. Non-goals

- **Battery and thermals.** The roadmap lists them under success metrics, but they need on-device
  instrumentation over long runs. They belong with Phase 3 tiering, not here.
- **CI integration, dashboards, multi-device orchestration.** This is a local dev tool.
- **Comparability with published AMI leaderboard numbers.** Those use specific scoring recipes
  (Kaldi/ESPnet). Matching one is a project in itself and buys us nothing: we need to detect *our*
  changes, not rank against papers. See §5.1.
- **Changing the core.** The harness consumes the CLI's existing `--json` contract. If it needs a
  core change, that is a signal the contract is wrong, and gets its own discussion.

## 3. Architecture

A Python harness under `eval/` that shells out to the existing `audionotes_cli` and scores its
`--json` output.

```
  eval/run.py
      │  for each fixture:
      ├─► audionotes_cli <models> fixture/audio.wav --vad … --diar-seg … --llm … --json out.json
      │        (the shared C++ core — unchanged)
      └─► score out.json against fixture/truth.json + fixture/minutes.json
             ├── metrics/wer.py
             ├── metrics/der.py
             ├── metrics/mom.py ──► judge.py (local GGUF via llama.cpp)
             └── metrics/perf.py
                    └─► results/<run-id>/{results.json, report.md}
```

**Why Python, not C++:** WER alignment, text normalisation and report generation are miserable in
C++, iteration speed matters more than runtime here, and this is dev tooling that must never end up
in the shipped library. Python 3.13 is already on the machine.

**Why shell out rather than link the core:** `--json` is the stable contract the C ABI already
emits, built for exactly this. Driving the CLI keeps the harness at arm's length from core
internals, so refactors inside the core cannot break the harness as long as the document shape
holds.

**No third-party Python dependencies.** WER is ~40 lines of Levenshtein, DER needs a small
Hungarian assignment, and the judge talks to llama.cpp. Avoiding `jiwer`/`pyannote.metrics`/`numpy`
keeps the harness runnable with a bare `python3` and makes the scoring auditable — when a number
looks wrong we can read the code that produced it.

## 4. The fixture format (the load-bearing contract)

Everything downstream reads this format and nothing downstream knows AMI exists. Your own
recordings become a benchmark by writing these two files — no harness changes.

```
eval/fixtures/<meeting-id>/
    audio.wav      16 kHz mono PCM16 (what the CLI already requires)
    truth.json     ground-truth transcript + speaker timeline
    minutes.json   reference minutes
    meta.json      provenance + licence
```

`truth.json`:
```json
{
  "audio_ms": 1834000,
  "segments": [
    {"start_ms": 1200, "end_ms": 4800, "speaker": "A", "text": "so shall we start with the remote control"}
  ]
}
```
`speaker` is an opaque label; the scorer never assumes it matches our cluster numbering (see §5.2).

`minutes.json`:
```json
{
  "decisions": ["The casing will be made of rubber."],
  "actions":   [{"text": "Draft the interface spec", "owner": "Industrial Designer", "due": ""}],
  "questions": ["Whether the budget covers a second prototype."]
}
```
`owner` and `due` may be empty strings when the reference does not state them; scoring treats an
empty reference field as "not required" rather than as a miss.

`meta.json` records `source` (`ami` | `own` | `scripted`), `licence`, and free-text `notes` — so a
report can always say where a number came from, and so CC BY 4.0 attribution is mechanical.

### 4.1 AMI adapter

`eval/corpus/ami.py` converts AMI into the above. AMI gives us, under CC BY 4.0:

- manual per-speaker orthographic transcripts with word-level timings → `truth.json`
- abstractive summaries under `ABSTRACT` / `DECISIONS` / `PROBLEMS/ISSUES` / `ACTIONS` headings →
  `minutes.json` (`DECISIONS` → decisions, `ACTIONS` → actions, `PROBLEMS/ISSUES` → questions)
- Mix-Headset audio → `audio.wav` after resampling to 16 kHz mono

**Unverified at spec time:** the exact download route and per-meeting size. The first implementation
task is to fetch a single meeting and confirm the format before any adapter code is written, so a
wrong assumption costs one task rather than the slice. If the raw corpus proves awkward, a
HuggingFace mirror of AMI is the fallback.

**Known limits of AMI as a proxy** — recorded in `meta.json` and repeated in every report so nobody
reads these numbers as product truth: 2000s meeting-room audio, headset and far-field mics, mostly
British/European accents, scenario-driven rather than spontaneous, and no code-switching. It is a
good instrument for *detecting change* and a poor one for claiming the product works for real users
in a room with a phone on the table. That is what the user's own recordings are for.

## 5. Metrics

### 5.1 WER

Standard word-level Levenshtein over normalised text: `WER = (S + D + I) / N_reference`.

Normalisation, applied identically to reference and hypothesis, in order:

1. Unicode NFKC; lowercase
2. Strip AMI annotation markup and bracketed non-speech (`[laugh]`, `<vocalsound>`)
3. Remove punctuation except apostrophes inside words (`don't` survives, `don't,` loses the comma)
4. Expand a fixed contraction table (`don't` → `do not`, …) on both sides
5. Delete a fixed disfluency list on both sides: `uh, um, mm, hmm, er, erm, mmhmm, uhhuh`
6. Expand digit strings to number words (integers 0-999; larger left as-is), NOT the reverse —
   `25` becomes `twenty five`, so a multi-word reference matches a digit hypothesis token for token.
   Mapping words to digits would leave `twenty five` as two tokens against `25` as one, scoring a
   correct transcription as an error.
7. Collapse whitespace

Step 5 matters more than it looks: AMI annotates disfluencies and Whisper mostly does not, so
without it we would measure annotation convention rather than transcription quality — hundreds of
spurious deletions per meeting. Step 6 likewise stops `25` vs `twenty five` reading as an error.

Reported: overall WER, per-meeting WER, and S/D/I counts (the breakdown is what tells you *how* a
model is failing — insertions mean hallucination, deletions usually mean VAD dropped speech).

### 5.2 Diarization

Two numbers, because they answer different questions.

**DER** — the standard research metric, over the reference speech timeline:
`DER = (missed + false_alarm + confusion) / total_reference_speech_ms`

- Our cluster ids are arbitrary integers, so first compute the optimal one-to-one mapping between
  our clusters and reference speakers by maximising total overlap (Hungarian assignment).
- A 250 ms forgiveness collar around every reference boundary, the usual convention, since exact
  boundary placement is neither achievable nor perceptually meaningful.
- **Overlapping speech is excluded in v1** and the excluded fraction is reported. Our pipeline
  assigns exactly one speaker per utterance, so it cannot score overlap; hiding that would flatter
  us silently.

**Action-item attribution** — the roadmap's user-visible metric: of the action items our MOM
produced, what fraction carry the correct speaker as owner. This is what a user actually notices,
and it can move independently of DER.

### 5.3 MOM quality — local LLM judge

The mismatch that rules out lexical scoring: AMI's reference decisions are *abstractive*
one-liners ("the casing will be made of rubber"), while our rule-based minutes emit *extractive*
transcript sentences ("so I think we should go with rubber for the case then"). Those are the same
decision and share almost no tokens. Token-overlap scoring would report a correct MOM as a failure.

**Recall.** For each reference decision/action/question, ask the judge whether our produced minutes
capture it, given the full produced MOM. `recall = captured / total_reference_items`, reported per
category. The judge returns a verdict plus the line it matched, so every score is auditable — you
can read *why* an item was counted.

**Hallucination / precision.** For each item we produced, ask the judge whether it is supported by
the ground-truth transcript. This becomes critical in Phase 2 when the LLM becomes the primary
minutes writer: a model that invents plausible decisions would otherwise score well on recall.

**Owner and due correctness.** For action items the judge matched, compare owner and due against the
reference, skipping fields the reference leaves empty.

**Determinism.** Pinned model file, `temperature 0`, fixed seed, prompts stored in the repo. Runs
will still not be bit-identical across llama.cpp versions; the model and version go in the report.

**Judge model.** A larger GGUF than the shipped 1.5B — the dev Mac (M2 Pro, ~11 GB usable GPU) hosts
a 7–14B comfortably. Deliberately *not* the shipped model: a judge should be stronger than the
system under test, or it will simply reward output resembling its own.

### 5.4 Judge calibration (a gate, not a nicety)

The judge is the weakest link in the harness, so before any MOM number is believed:

1. Sample 20 judged items across categories and outcomes.
2. The user hand-labels them captured / not captured.
3. Report agreement.

Below ~85% agreement the MOM numbers are noise and the report must say so rather than print a
confident percentage. This is cheap insurance against building Phase 2 on a broken instrument.

### 5.5 Performance

From the CLI's existing `timings` block plus `audio_ms`: × realtime per stage
(`stage_ms / audio_ms`) and end-to-end. Peak RSS from `/usr/bin/time -l` around the CLI process.
These are the desktop-side inputs to the device→tier matrix; the phone-side numbers come from the
existing `PipelineBenchmark` instrumented test in Phase 3.

## 6. Outputs

`eval/results/<run-id>/results.json` — every number, plus the per-item judge verdicts, for
diffing two runs.

`eval/results/<run-id>/report.md` — human-readable: a summary table across fixtures, per-meeting
detail, the corpus caveat from §4.1, and the model/versions used.

`eval/run.py --baseline <run-id>` prints a delta table against a previous run. That is the
day-to-day Phase 2 workflow: change something, run, read the delta.

## 7. Testing

The harness is measurement equipment; if it is wrong, every number it produces is wrong, so it gets
its own tests (`eval/tests/`, plain `unittest`, no network, no models):

- **WER** — hand-computed cases: pure substitution, deletion, insertion, empty hypothesis, empty
  reference, and one case per normalisation rule (disfluency, contraction, number).
- **DER** — synthetic timelines with known answers: perfect match, fully swapped labels (must score
  0 after Hungarian mapping, catching an inverted-mapping bug), a missed region, a false alarm.
- **MOM** — a stubbed judge returning scripted verdicts, so recall/precision arithmetic and the
  empty-reference-field rule are tested without invoking a model.
- **Adapter** — a small checked-in AMI annotation excerpt converts to the expected fixture JSON.

## 8. Delivery slices

Each slice ends with something runnable, so the harness is useful before it is complete.

1. **Fixture format + AMI adapter + WER.** Confirm the AMI download, build one fixture, run the CLI,
   report WER. Proves the whole path end to end and delivers the metric Phase 2's ASR work needs.
2. **Diarization + performance.** DER, action-item attribution, × realtime, peak RSS. Completes the
   deterministic metrics and the tier-matrix inputs.
3. **LLM judge + MOM.** Judge runner, recall/precision/owner-due, and the §5.4 calibration gate.

## 9. Open items

- **AMI acquisition route and size** — resolved by the first task of slice 1 (§4.1).
- **Judge model choice** — a specific 7–14B GGUF, picked during slice 3 and pinned in the report.
- **The user's own recordings** — the real validity set. Independent of this build: the fixture
  format is designed so they drop in with no harness change. Long lead time (consent, hand
  transcription, writing ideal MOMs), so worth starting to gather in parallel.
