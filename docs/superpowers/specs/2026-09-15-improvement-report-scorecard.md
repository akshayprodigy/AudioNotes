# The improvement report, scored against the code — 15 September 2026

Source: `~/Downloads/Verbale_improvement_report.md` (7 September). Scored against `main` at
`951481e`, after the 14 September device pass. Companion to the 8 September decomposition, which
recorded what was *already* built; this records what is built **now**, what is partly there, and
what has not been started. "Done" means present in the code and exercised on a phone this week
unless noted.

Legend: ✅ done · ◐ partly · ✗ not built · ⛔ tried and rejected on evidence

## The experience the report would build

| Ask | State | Evidence |
|---|---|---|
| Meeting vs Dictation choice before recording | ✗ | one mode only |
| Storage / microphone / models check before recording | ◐ | models checked (onboarding, Settings); no storage or mic check |
| Audio check + placement guidance | ✗ | sub-project 3 |
| Optional language / topic / names / terms hints | ◐ | language only (Settings); no topic, names, terms |
| Recording indicator, elapsed time, level | ✅ | RecordScreen, notification, PiP |
| Bookmark ("mark a moment") button | ✗ | NEXT §2 |
| Clipping / weak-speech / interrupted / low-storage warnings | ✗ | sub-project 3 |
| Provisional transcript shown during recording | ✗ | the live pass exists only as a decode cache; nothing on screen |
| Recording survives heavy processing | ✅ | separate foreground services; verified A07 + Pixel, screen off |
| Status after recording: processing / draft / final | ◐ | status badges (QUEUED, TRANSCRIBING, PAUSED, READY, NOT ENGLISH, NO SPEECH); no "draft" state; ETA learned per phone with live counts (shipped 16 Sep) |
| Summary, decisions, actions, questions, transcript | ✅ | four tabs |
| Every item opens its passage and plays the audio | ✅ | evidence spine; verified both phones |
| Review queue for uncertain names / numbers / dates / speakers | ✅ | shipped 17 Sep: typed record + per-meeting card flow, Pixel-verified |
| Later: search, ask questions, track actions, prepare | ◐ | keyword + meaning search built (the two known bugs fixed 16 Sep); ask built 16 Sep; action tracker ✅; prepare ✗ |

## Improving what was said

| Ask | State | Evidence |
|---|---|---|
| Mic test, placement guidance, clipping and weak-speech checks | ✗ | sub-project 3 |
| Test UNPROCESSED vs VOICE_RECOGNITION across devices | ✗ | UNPROCESSED only; two devices |
| Keep the original recording; test noise reduction on a copy | ✅ / ⛔ | gain normalisation built, measured, rejected (`2026-09-04-recording-gain-rejected.md`) |
| Compare engines on identical audio | ✅ | Parakeet 20.2 % / Moonshine 27.2 % / whisper 29.0 % WER — kept whisper (`eval-english-engine-candidates.md`) |
| Score by condition: accents, dictation, distance, overlap, vocabulary | ◐ | six accents scored (`eval-accent-baseline.md`); the rest not |
| Fast pass + selective refinement of difficult passages | ◐ | fast pass exists (live decode during capture, reused post-hoc); no refinement, no difficulty signals |
| Window-boundary overlap benchmark | ✗ | non-overlapping VAD-span chunks; `test_asr_chunker` pins behaviour, not the loss |
| Local vocabulary / correction memory | ✗ | sub-project 5 |

## Improving who said it

| Ask | State | Evidence |
|---|---|---|
| Separate separation from identification; Speaker 1/2 then name | ✅ | Speakers screen |
| Bounded windows + global voice grouping | ⛔ | windowed diarization built, cost 6–8 DER points, shelved; `DiarBudget` guard instead (`2026-09-06-windowed-diarization-design.md`) |
| Validated clustering thresholds | ◐ | padding constant swept on four meetings; one threshold |
| Word-level alignment to speaker turns | ◐ | segment-level, limitation preserved |
| "Uncertain" speaker label | ✗ | sub-project 2 |
| Overlapping speech represented honestly | ✗ | sub-project 2 |
| Rename / merge / split / reassign passages, preview, preserve confirmed on reprocess | ✅ | rename ✅ merge ✅; split / reassign ✅ (one gesture, three scopes, shipped 16 Sep); speaker corrections survive re-diarization ✅; corrections and ticks survive reprocess ✅ |
| Remembered voices, enrolment, deletable | ✗ | NEXT §3, with the BIPA/GDPR note |

## Dictation mode — ✗ entirely (sub-project 5)

## A better role for the language model

| Ask | State | Evidence |
|---|---|---|
| Small, specific jobs rather than one pass | ◐ | narration is chunked with per-chunk digests; no classification pass yet |
| Evidence record: stable ID, type, text, sources, timing, owner, date said, normalised date, review status, generation version | ◐ | id, text, sources + timing, review, gen_version, `date_said` ✅ (Phase A); type, owner as a field, normalised date ✗ (Phase B — `date_said` column exists, empty) |
| Validate output: cited passages exist, names/amounts/dates supported | ✗ | Phase B |
| Summaries from the same evidence | ⛔ | cut on evidence — a 1.5B model fed structured notes writes bullet lists (`llm_minutes.h`) |
| Rules kept as baseline | ✅ | and extended 14 Sep ("we have decided", `<Name> will <verb>`) |
| Constrained JSON | ✗ | NEXT §2 |
| Record versions, cache approved outputs | ◐ | gen_version on items; narration digests cached |
| Instructions separate from recorded speech | ✅ | prompt-injection fence + `check:fence` guard (Task 13) |

## Features that would make the app valuable

| Feature | Report priority | State |
|---|---|---|
| Source playback from every note | First release | ✅ |
| Review queue | First release | ✅ (17 Sep) |
| Speaker merge, split, rename | First release | ✅ (split = reassign from a line on, shipped 16 Sep) |
| Dictation mode | First release | ✗ |
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
| Device tiers from a local benchmark | ✗ (only the `DiarBudget` memory guard) |
| llama.cpp vs LiteRT-LM benchmark | ✗ |
| Defer fine-tuning | ✅ |

## Enforcing the privacy requirement

| Ask | State | Evidence |
|---|---|---|
| Boundary covers transcripts, notes, embeddings, questions | ✅ | nothing leaves; ledger + `check:egress` |
| No-internet-permission build | ✗ | INTERNET kept for models and licence; sub-project 6 |
| Separate downloader identity | ✗ | |
| Encrypt audio files, not only DB rows | ◐ | database SQLCipher ✅; **`audio.pcm` is plain PCM in app-private storage** (Android file-based encryption only) — the consent card's "Encrypted" rests on the OS |
| Exclude from backup / transfer, verified across OEMs | ◐ | `allowBackup=false`; verified on Pixel + Samsung only |
| Content out of crash reports, logs, clipboard, notifications | ✅ | crash.ts rules; consent now genuinely gates collection (14 Sep) |
| No external sharing under the strict reading | ✗ by choice | sharing is a product feature |
| Delete search entries, caches with the source | ✅ | |
| "Audio no longer available" when notes kept | ◐ | retention copy says playback is given up; no per-meeting notice |
| Ledger + source scan as supplementary | ✅ | |
| ONNX runtime packaged, not downloaded | ✗ | still a separate download, hash-checked |
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
| Summary support / citation correctness | ✗ (Phase B) |
| Questions | ✗ |
| User correction effort | ✗ |
| Speed | ◐ measured ad hoc, not tracked |
| Reliability: endurance suite, interruptions | ✗ |
| Device cost | ◐ one 90-minute import measured |

## The count

Of roughly 75 concrete asks: **19 done, 24 partly, 27 not built, 3 tried and rejected on
measurement.** Of the report's six "first release" features: source playback ✅, speaker rename
and merge ◐, action tracker ◐ (unreachable), review queue ✗, dictation ✗.

What this means for the launch decision taken on 8 September (report work before the launch
list): sub-project 1 (evidence spine) is done through Phase A; sub-projects 2–6 are not started.
The app that ships today is the "dependable at four things" app from the report's own
recommendation — preserving the recording, capturing the words, identifying the speaker, showing
the evidence — with local search behind Pro. The rest is the roadmap.
