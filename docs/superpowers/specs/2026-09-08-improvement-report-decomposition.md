# The improvement report, decomposed

**Written Tuesday 8 September 2026, 15:37 IST** (`2026-09-08T10:07Z`).
Source: `Verbale_improvement_report.md`, prepared 7 September 2026.

The report is a roadmap, not a task. Read literally it is roughly forty workstreams across
capture, recognition, attribution, interpretation, storage, privacy, measurement and release
engineering. This document does three things: records which parts of it **are already built or
already settled here**, splits the remainder into **six sub-projects** that can each be specced
and shipped on their own, and records the **four founder decisions** taken on 8 September that
fix the order.

---

## 1. What the report asks for that already exists

This matters more than it sounds. A roadmap written from `ARCHITECTURE.md` cannot see the
measurements taken after it, and about a third of the report describes work this repository has
already done — in several cases done, measured, and deliberately rejected.

| The report asks for | State here |
|---|---|
| Compare Whisper against Moonshine and Parakeet on identical audio | **Done 5 Sep.** Parakeet-TDT 20.2% WER against whisper's 29.0% — and ruled out: empty strings on quiet windows with a success return, 661 MB against 57 MB, 2.4-2.9x the ASR time. `docs/superpowers/eval-english-engine-candidates.md` |
| Score accents; do not hide weaknesses in one average | **Done 5 Sep.** Six EdAcc conversations, 23.3%-30.2% WER, no accent falls off a cliff. It found a different defect: Indian English at 79.1% attribution against 92.6% American — words right, speaker wrong. `docs/superpowers/eval-accent-baseline.md` |
| Encrypt audio and sensitive files; manage keys through Keystore | SQLCipher throughout, `KeystoreKeyManager.kt` |
| An enforceable privacy boundary, with verification | Privacy proof screen (Settings → "What left this phone") plus `scripts/check-network-egress.py` failing the build on a fifth call site |
| Describe the announcement as evidence it was captured, never as proof of agreement | Exactly what `AnnouncementVerifier` implements, down to the loudness check |
| Speaker merge and rename | `src/screens/SpeakersScreen.tsx` |
| Test noise reduction on a separate copy before adopting it | Recording gain normalisation was built, measured, and **rejected** — it degraded the recordings it was written to rescue. `docs/superpowers/specs/2026-09-04-recording-gain-rejected.md` |
| Bounded audio processing so memory does not follow the meeting | Windowed diarization was built, measured and **shelved** — mean DER 26.2-27.7 against 20.0 for one pass. The `DiarBudget` guard shipped instead. `docs/superpowers/specs/2026-09-06-windowed-diarization-design.md` |
| A live chunk queue; keep the model loaded across chunks | Spec and plan written 7 Sep, not yet implemented |
| An evaluation harness with results by condition | `eval/`, with `wer.py`, `der.py`, `attribution.py`, `judge.py`, `mom.py` |
| Model integrity checks | `models.sha256`, enforced on install |

**The rule this implies, and it should survive this document:** a report item is not work until it
has been checked against the measurements. Three of the rows above describe things that were
tried and found wrong. Redoing them would cost weeks and produce the same answer.

## 2. The six sub-projects

Everything in the report that is genuinely unbuilt, grouped so each group has one clear purpose,
one owner surface, and can be specced without waiting on the others.

| # | Sub-project | What it contains | Depends on |
|---|---|---|---|
| 1 | **Evidence spine** | Stable item IDs, source utterances and timing on every generated item, tap-to-play provenance, output validation, typed evidence record, review queue, prompt-injection fence, grammar-constrained JSON | — |
| 2 | **Attribution repair** | Per-turn speaker reassignment, splitting a wrongly-merged speaker, an "uncertain" label when two speakers are equally plausible, honest overlap marking | 1 (items must survive a speaker change) |
| 3 | **Capture assurance** | Microphone check and placement guidance, clipping / persistently-weak-speech / low-storage warnings, foreground-service timeout handling, 90-minute *capture* endurance as a release gate | — |
| 4 | **Wait-time honesty and speed** | The measured ETA against the correct stage, then the written live-transcript plan, then selective refinement of difficult passages | — |
| 5 | **Vocabulary and dictation** | Local glossary biasing recogniser and narrator, correction memory, a separate dictation workflow | 1 (corrections need stable identity) |
| 6 | **Measurement and privacy hardening** | Overlap-inclusive DER, per-category accuracy for names / numbers / dates / negations, device tiers from a local benchmark, the no-internet-permission build, OEM backup verification | 1-5 produce what it measures |

Report items in its own "Next" and "Later" columns — ask-this-meeting, semantic search, meeting
templates, decision history, meeting preparation, persistent voice profiles, DOCX — sit after
these six. They are features on top of a foundation, and the report agrees.

## 3. The four decisions taken on 8 September

Recorded because each one closes a fork that would otherwise be reopened.

**Report work comes before the launch list.** `docs/NEXT.md` §1 stays as written and stays
paused. The open items there that are genuinely the founder's — prices, Sentry DSN, Play listing,
bandwidth ceiling, staged rollout — are unblocked by this and can proceed in parallel.

**Sub-project 1 goes first, at full scope.** The evidence record and the review queue, not the
links alone. The review queue is phased last inside that spec so it is designed against the
classifier's real confidence signals rather than guessed ones.

**Provenance is free; interpretation is Pro.** A free user has no LLM weights on disk at all —
`ModelCatalog` gates them on subscription and `Narrator.run` refuses without an entitlement — so
an LLM classification pass cannot run for them under any design. Free therefore gets the whole
provenance spine: stable IDs, source turns, tap-to-play, timestamped export. Item typing,
contradiction detection, owner confidence and normalised dates are Pro.

**The accepted consequence, stated plainly:** free minutes stay un-interpreted. A rule-extracted
request will still be listed as an action for a free user. The mitigation carried in the spec is
wording, not modelling — a free item is presented as a quoted passage with its timestamp, never
as a verified commitment. This was put to the founder with the alternative and chosen knowingly.

## 4. What is deliberately not in sub-project 1

Not deferrals of convenience. Each has a reason.

| Not in it | Reason |
|---|---|
| Speaker reassignment, split, overlap and uncertain labels | Different tables, different screen, no shared code with the evidence model. Bundling doubles the spec and delays provenance for nothing. |
| Microphone check, capture warnings, service timeouts, endurance gate | Touches capture. Zero overlap with how notes are recorded or shown. |
| ETA, live transcript, selective refinement | The live-transcript plan is already written and stands alone. |
| Glossary, correction memory, dictation | Lives on the ASR path, not the minutes path. |
| Overlap-inclusive DER, per-category accuracy, device tiers, no-internet build, OEM backup checks | Measures the other five. Runs after there is something to measure. |
| **Rebuilding narration from the evidence set** | **Cut on evidence, not on time.** See §3 of the spine spec: a 1.5B model fed structured notes writes bullet lists and denies its own extractions, and both failures are recorded in `cpp/minutes/llm_minutes.h` from real measurements. The validator obtains the same guarantee without reopening the regression. |
| An event-sourced evidence log | Considered and dropped. It buys decision history, which the report itself places in Later. |

---

**Next document:** `docs/superpowers/specs/2026-09-08-evidence-spine-design.md`.
