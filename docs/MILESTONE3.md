# Milestone 3 — Rule-based minutes (Free-tier floor)

**Goal (BUILD_PLAN §9):** deterministic, model-free minutes so the Free tier is genuinely useful
and the app never depends on an LLM being available. Full cycle now: record → VAD → transcript →
**structured minutes**.

## What was implemented

**Extractor** (`src/pipeline/minutes.ts`) — pure, deterministic, no model/network:
- **Action items** with best-effort **owner** (first-person → the speaker; "Name will …" → that
  name; "can you …" → Unassigned) and **due date** detection (today/tomorrow/by Friday/next week/
  EOD/…). Rendered as `text — Owner (due …)`.
- **Decisions** ("we decided", "we agreed", "going with", "approved", …).
- **Open questions** (sentences ending in `?`, or leading question words).
- A factual **overview** line (counts of actions/decisions/questions).
- Sentence-level scanning, de-duplication, and sensible caps (30 actions / 20 decisions / 20 questions).
- English-first patterns, structured as cue lists so more languages can be added.

**Wiring** (`src/pipeline/PipelineController.ts`)
- After native VAD+ASR resolves, the JS layer reads the transcript, runs `extractMinutes`, writes
  the `minutes` table, and sets status `done`. This runs in JS on purpose — it's small text work,
  so it's shared across Android + iOS with zero native code and is unit-testable.
- If no transcript exists yet (whisper model not installed), it no-ops and leaves status at `vad`.

**UI** — the Meeting screen renders the minutes and polls while processing runs (record → navigate
happens immediately; VAD+ASR+minutes complete in the background).

**Correctness fixes** — `db.minutes/utterances/speakers` now alias snake_case columns to the
camelCase the TS types expect (`content_json→content`, `speaker_id→speakerId`, etc.), so minutes,
transcript, and speaker names render correctly.

## Tests

`__tests__/minutes.test.ts` (jest) covers summary-first ordering, decision capture, first-person and
named-owner attribution, due-date detection, question capture, and de-duplication. Run:

```bash
npm test
```

(The logic was also validated here headlessly against a sample transcript — all assertions pass.)

## Notes & limits (by design)

- Owners are mostly `Unassigned` until milestone 4 adds diarization (speaker labels). Named owners
  ("Priya will …") are still detected from the text today.
- "Can you send X today?" is captured as an **open question** (it ends in `?`), not an action — a
  deterministic floor can't perfectly disambiguate requests-as-questions. The on-device LLM
  (milestone 5) refines this; the floor stays conservative.

## Next

- Milestone 4: diarization (sherpa-onnx) + manual speaker labelling/merge UI → real owners.
- Milestone 5: on-device Qwen3 (llama.cpp) to *enhance* these minutes (summary prose, better owners),
  with the rule-based output as the guaranteed fallback.
