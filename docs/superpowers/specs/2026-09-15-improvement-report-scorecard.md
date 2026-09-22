# The improvement report, scored against the code — 15 September 2026

Source: `~/Downloads/Verbale_improvement_report.md` (7 September). First scored against `main` at
`951481e`, after the 14 September device pass; **re-scored 22 September against `f516de5`**, after
every phase of the release plan (`docs/superpowers/plans/2026-09-17-release-phases.md`) was built
and the full device suite ran on the Galaxy A07. Companion to the 8 September decomposition, which
recorded what was *already* built; this records what is built **now**, what is partly there, and
what has not been started. "Done" means present in the code and exercised on a phone — by the
automated device suite at least; the by-hand runs still owed are named in the plan.

Legend: ✅ done · ◐ partly · ✗ not built · ⛔ tried and rejected on evidence

## The experience the report would build

| Ask | State | Evidence |
|---|---|---|
| Meeting vs Dictation choice before recording | ✅ | segmented control on the record screen, `record_mode` setting (Phase 5, 21 Sep) |
| Storage / microphone / models check before recording | ◐ | models ✅; storage ✅ — a low-storage warning while recording (15 Sep) and a download refused with both numbers (21 Sep); no mic check |
| Audio check + placement guidance | ✗ | not in the release plan; capture warnings shipped instead (below) |
| Optional language / topic / names / terms hints | ◐ | language (Settings); names and terms as correction rules in Settings › Vocabulary (Phase 5) — applied after recognition, deliberately not as a hint; no topic |
| Recording indicator, elapsed time, level | ✅ | RecordScreen, notification, PiP |
| Bookmark ("mark a moment") button | ✅ | Mark from the record screen, the PiP window and the notification → Highlights, in every export (15 Sep, Pixel-verified) |
| Clipping / weak-speech / interrupted / low-storage warnings | ◐ | too loud, voices faint, storage low — inline banner + notification body (15 Sep); no "interrupted"; below the level the VAD still hears, no warning can fire (open finding) |
| Provisional transcript shown during recording | ⛔ | decided against 15 Sep (founder): the record screen stays the meter, the clock, Mark and Pause; the live pass is a cache for the final transcript |
| Recording survives heavy processing | ✅ | separate foreground services; verified A07 + Pixel, screen off |
| Status after recording: processing / draft / final | ◐ | status badges (QUEUED, TRANSCRIBING, PAUSED, READY, NOT ENGLISH, NO SPEECH); no "draft" state; ETA learned per phone with live counts (shipped 16 Sep) |
| Summary, decisions, actions, questions, transcript | ✅ | four tabs |
| Every item opens its passage and plays the audio | ✅ | evidence spine; verified both phones |
| Review queue for uncertain names / numbers / dates / speakers | ✅ | shipped 17 Sep: typed record + per-meeting card flow, Pixel-verified |
| Later: search, ask questions, track actions, prepare | ✅ | keyword + meaning search and ask (17 Sep), action tracker (16 Sep), prepare = the thread screen's "Still open" across a tag's meetings (17 Sep) |

## Improving what was said

| Ask | State | Evidence |
|---|---|---|
| Mic test, placement guidance, clipping and weak-speech checks | ◐ | clipping and weak-speech warnings ✅ (15 Sep); mic test and placement guidance ✗ — not in the release plan |
| Test UNPROCESSED vs VOICE_RECOGNITION across devices | ✗ | UNPROCESSED only; three devices now (Pixel, A07, Tab A), the comparison never run |
| Keep the original recording; test noise reduction on a copy | ✅ / ⛔ | gain normalisation built, measured, rejected (`2026-09-04-recording-gain-rejected.md`) |
| Compare engines on identical audio | ✅ | Parakeet 20.2 % / Moonshine 27.2 % / whisper 29.0 % WER — kept whisper (`eval-english-engine-candidates.md`) |
| Score by condition: accents, dictation, distance, overlap, vocabulary | ◐ | six accents scored (`eval-accent-baseline.md`); the rest not |
| Fast pass + selective refinement of difficult passages | ◐ | fast pass exists (live decode during capture, reused post-hoc); no refinement, no difficulty signals |
| Window-boundary overlap benchmark | ✗ | non-overlapping VAD-span chunks; `test_asr_chunker` pins behaviour, not the loss |
| Local vocabulary / correction memory | ✅ | rules learned from "Correct the words" or typed in Settings › Vocabulary, applied after recognition with `text_raw` kept (Phase 5, 21 Sep; a recogniser prompt was measured and rejected — it drops words) |

## Improving who said it

| Ask | State | Evidence |
|---|---|---|
| Separate separation from identification; Speaker 1/2 then name | ✅ | Speakers screen |
| Bounded windows + global voice grouping | ⛔ | windowed diarization built, cost 6–8 DER points, shelved; `DiarBudget` guard instead (`2026-09-06-windowed-diarization-design.md`) |
| Validated clustering thresholds | ◐ | padding constant swept on four meetings; one threshold |
| Word-level alignment to speaker turns | ◐ | segment-level, limitation preserved |
| "Uncertain" speaker label | ✗ | not in the release plan; speaker repair shipped instead (one gesture, three scopes, "Someone new", 16 Sep) |
| Overlapping speech represented honestly | ✗ | not in the release plan |
| Rename / merge / split / reassign passages, preview, preserve confirmed on reprocess | ✅ | rename ✅ merge ✅; split / reassign ✅ (one gesture, three scopes, shipped 16 Sep); speaker corrections survive re-diarization ✅; corrections and ticks survive reprocess ✅ |
| Remembered voices, enrolment, deletable | ✅ | Phase 4 (18 Sep): a voiceprint per named speaker, "Sounds like Priya?", off by default, consent copy, forget-all in Settings; automated tests on the A07 (22 Sep), by-hand run pending |
| Persistent voice profiles | ✅ | 18 Sep — Phase 4 (report `docs/superpowers/reports/2026-09-18-phase-4-remembered-voices.md`) |

## Dictation mode — ✅ (Phase 5, 21 Sep)

`meetings.mode`, one voice, spoken punctuation in C++, the note as the write-up with the transcript as the verbatim view; device-tested on the Tab A, the A07 suite 22 Sep; by-hand run pending. Dictation is free; the written-up note needs the writer (Pro).

## A better role for the language model

| Ask | State | Evidence |
|---|---|---|
| Small, specific jobs rather than one pass | ◐ | narration chunked with per-chunk digests; a grammar-constrained classifier reads each item's reply (17 Sep); narration itself is still one pass per chunk |
| Evidence record: stable ID, type, text, sources, timing, owner, date said, normalised date, review status, generation version | ✅ | `items` carries id, kind, item_type, text, anchors, owner_json, date_said, date_norm, review, gen_version (Phase B, 17 Sep) |
| Validate output: cited passages exist, names/amounts/dates supported | ◐ | Ask cites `[n]` or says nothing (17 Sep); typed items are re-read and the unsettled ones go to the review queue (17 Sep); the narrated summary is not checked against its passages |
| Summaries from the same evidence | ⛔ | cut on evidence — a 1.5B model fed structured notes writes bullet lists (`llm_minutes.h`) |
| Rules kept as baseline | ✅ | and extended 14 Sep ("we have decided", `<Name> will <verb>`) |
| Constrained JSON | ◐ | the classifier and Ask sample under a grammar (17 Sep); narration is still free-form, defended by hand in `summarize.ts` |
| Record versions, cache approved outputs | ◐ | gen_version on items; narration digests cached |
| Instructions separate from recorded speech | ✅ | prompt-injection fence + `check:fence` guard (Task 13) |

## Features that would make the app valuable

| Feature | Report priority | State |
|---|---|---|
| Source playback from every note | First release | ✅ |
| Review queue | First release | ✅ (17 Sep) |
| Speaker merge, split, rename | First release | ✅ (split = reassign from a line on, shipped 16 Sep) |
| Dictation mode | First release | ✅ (21 Sep; Phase 5) |
| Local action tracker | First release | ✅ (Library card + header icon, shipped 16 Sep) |
| Ask this meeting | Next | ✅ (17 Sep; cites or says nothing) |
| Keyword + meaning-based search | Next | ✅ (17 Sep; bge-small, one fused list, "≈" for meaning-only hits) |
| Meeting templates | Next | ✅ (17 Sep; seven types, auto-suggested, remembered per tag) |
| Decision history | Later | ✅ (17 Sep; thread screen, "changes: …" links found by a rule over the item vectors) |
| Meeting preparation | Later | ✅ (17 Sep; the same thread screen's "Still open" section) |
| Validated additional languages | After evaluation | ◐ Hindi built (Qwen3-ASR), unmeasured, unreachable by design |

## Faster processing without risking the recording

| Ask | State | Evidence |
|---|---|---|
| Durable chunk queue during recording | ◐ | live pass reads the growing file and caches decoded windows |
| Model loaded across chunks | ◐ | during capture yes (one handle); post-hoc still one engine per meeting |
| Thermal / battery / memory scheduling | ✅ | `LiveBudget` backs the live pass off; `ProcessingBudget` pauses post-hoc at SEVERE / low battery and resumes (shipped 16 Sep) |
| Draft output before refinement finishes | ✗ | |
| Foreground-service time limits handled | ◐ | `dataSync` type, resume-by-stage; the 6-hour limit not designed for |

## Device and model strategy

| Ask | State |
|---|---|
| Model choice behind one interface | ✅ (`AsrEngine` factory) |
| Device tiers from a local benchmark | ◐ `DeviceFit` (21 Sep): memory, processor and disk read from the phone and said before the download, the trial and the price — facts, not a benchmark |
| llama.cpp vs LiteRT-LM benchmark | ✗ |
| Defer fine-tuning | ✅ |

## Enforcing the privacy requirement

| Ask | State | Evidence |
|---|---|---|
| Boundary covers transcripts, notes, embeddings, questions | ✅ | nothing leaves; ledger + `check:egress` |
| No-internet-permission build | ✗ by decision | measured in Phase 6a (21 Sep); founder chose INTERNET for launch, the permission-less build as the first post-launch release |
| Separate downloader identity | ✗ | |
| Encrypt audio files, not only DB rows | ◐ | database SQLCipher ✅; **`audio.pcm` is plain PCM in app-private storage** (Android file-based encryption only) — the consent card's "Encrypted" rests on the OS |
| Exclude from backup / transfer, verified across OEMs | ◐ | `allowBackup=false`; verified on Pixel + Samsung only |
| Content out of crash reports, logs, clipboard, notifications | ✅ | crash.ts rules; consent now genuinely gates collection (14 Sep) |
| No external sharing under the strict reading | ✗ by choice | sharing is a product feature |
| Delete search entries, caches with the source | ✅ | |
| "Audio no longer available" when notes kept | ◐ | retention copy says playback is given up; no per-meeting notice |
| Ledger + source scan as supplementary | ✅ | |
| ONNX runtime packaged, not downloaded | ✅ | in the APK since 21 Sep (Phase 6b Session 1) |
| Announcement described as evidence, not agreement | ✅ | |

## Engineering improvements

| Ask | State | Evidence |
|---|---|---|
| Explicit checkpoints with versions | ◐ | rows-as-truth resume (`ResumePlan`), per-chunk narration checkpoint; no stage state table, no config/model versions on stages |
| Invalidate dependents after transcript / speaker change | ◐ | Regenerate after speaker edits; not automatic |
| Stable IDs and reconciliation | ✅ | the evidence spine; ticks survive reprocess (verified Pixel) |
| Original text vs correction vs paraphrase distinguishable | ✅ | `edits` table, "EDITED BY YOU" |
| One schema definition, migration tests | ✅ | Kotlin ⇄ TS mirror tests (caught a column on 14 Sep) |
| One processing contract, desktop = Android | ✅ | C++ core + goldens replayed on both |
| CI | ✗ | no `.github/workflows`; every gate is run by hand |
| Scheduled physical-device tests | ✗ | `npm run test:device` exists; nothing schedules it |
| Protect recordings during test installs | ✅ | same-key signing; documented |

## Measuring whether it is better

| Measure | State |
|---|---|
| WER, by accent | ✅ |
| Names / numbers / dates / negations separately | ✗ |
| DER, attribution | ✅ (overlap-excluded) |
| Overlap-inclusive DER | ✗ |
| Actions / decisions precision | ◐ judge exists, uncalibrated |
| Summary support / citation correctness | ✗ (Phase B verified items, not the summary) |
| Questions | ✗ |
| User correction effort | ✗ |
| Speed | ◐ measured ad hoc, not tracked |
| Reliability: endurance suite, interruptions | ✗ |
| Device cost | ◐ one 90-minute import measured |

## The count

Re-scored 22 September, over the 91 rows above: **44 done, 26 partly, 18 not built, 3 tried and
rejected on measurement.** On 15 September the same tables read 19 / 24 / 27 / 3.

Of the report's six "first release" features, all six are done: source playback ✅, review queue
✅, speaker merge / split / rename ✅, dictation ✅, action tracker ✅, and (its seventh, "next")
ask this meeting ✅.

**What the 18 "not built" rows are, so nobody mistakes them for work in flight.** Two are
decisions (the permission-less build is post-launch by the founder's 21 Sep choice; external
sharing is a product feature). The rest fall into three groups the release plan never took on:

- *Capture research* — a mic test with placement guidance, the UNPROCESSED-vs-VOICE_RECOGNITION
  comparison across phones, the window-boundary benchmark. Capture warnings shipped in their
  place.
- *Diarization refinements* — an "uncertain" speaker label, overlapping speech shown as such,
  a draft shown before refinement. Speaker repair shipped in their place.
- *Engineering and measurement* — CI, scheduled device tests, the LiteRT-LM benchmark, a separate
  downloader identity, and six evaluation measures (names / numbers / dates scored separately,
  overlap-inclusive DER, summary citation correctness, questions, correction effort, an endurance
  suite). Every gate is run by hand and passes; nothing runs it unattended.

The 26 "partly" rows are each named above with what is missing; the ones that touch a user are
the missing mic check, the missing "interrupted" warning, no draft state while processing, the
narrated summary not being checked against its passages, and the 6-hour foreground-service limit
not being designed for.

What this means for the launch decision taken on 8 September (report work before the launch
list): the work the founder chose from this report on 15–17 September — the six phases — is
built, reviewed and green through the automated device suite on a 64-bit phone. What is not
built is what was never chosen, and it is listed here so that stays a choice rather than a
surprise.
