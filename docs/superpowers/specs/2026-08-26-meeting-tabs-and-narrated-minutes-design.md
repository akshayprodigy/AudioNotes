# Meeting tabs and narrated minutes — design

**Date:** 2026-08-26
**Status:** approved, ready for an implementation plan

## Goal

Stop a meeting and the phone produces, unattended, a written record you can read: a one-line
description on the library row, a short prose summary when you open it, full minutes, a worklist,
and the transcript — each behind its own tab instead of one long scroll.

Two halves that ship together:

1. **Narrated minutes.** The on-device LLM runs as a pipeline stage, so a meeting stopped from the
   PiP window or the notification is narrated in the background with no app in the foreground.
2. **A tabbed details screen.** Summary / MOM / Actions / Transcript, landing on Summary.

## What we measured first

Run on the real `real-neosym-2026-08-19` fixture (8.5 min, Hindi/English code-switched) through the
shipping C++ path, and on a Pixel 7 Pro. These measurements changed the design, so they are recorded
here rather than left as assumptions.

### The model is adequate; the prompt is not

The shipping path's summary for this meeting:

> "No decisions were explicitly stated. No actions were taken regarding the vendor code issue."

Meta-commentary about absence, contradicted by the two action items printed below it. The identical
model and transcript, given a prompt that asks only for a summary:

> "The meeting discussed the implementation of a new vendor system in a company. The group worked
> through the process of uploading vendor details from a PHP application to a SAP system. They
> identified a character limit issue and discussed how to handle it. The meeting ended with the
> group agreeing to share the vendor details in an Excel file for further processing."

And asked for one sentence under 15 words:

> "The meeting discussed the implementation of a new vendor system in a company's PHP application."

**Conclusion: the summary must be its own generation call.** Inside the JSON extraction schema at
`cpp/minutes/llm_minutes.cpp` `reducePrompt`, the `"summary"` field reads to the model as commentary
on what it managed to extract. Asked directly, the same weights write what happened.

### Defects the run exposed

| # | Defect | Evidence |
|---|---|---|
| D1 | Single-chunk meetings get the raw transcript under a prompt that opens *"These are notes from consecutive parts of ONE meeting"* — the map phase is skipped when `chunks.size() == 1` | This 8.5-min meeting is 5,705 chars = 1 chunk. Every meeting under ~9 min hits this. |
| D2 | Minutes are non-deterministic. `LlamaEngine::load` defaults `greedy = false`; `pipeline.cpp:167` calls the 3-arg overload, so sampling runs at temp 0.3 | Two runs over the identical transcript produced completely different summaries. |
| D3 | The LLM deletes grounded detail. `db.replaceMinutes` overwrites all rows | Rules found 7 actions with verbatim quotes; the LLM returned 2, with `"due": "After uploading the file"` on both. |
| D4 | The reduce prompt overruns the context on long meetings, returning nothing | Measured density 671 chars/min → ~14 chunks ≈ **2 hours** exceeds `n_ctx` 8192. |

### Four more, found while building (2026-08-26)

Each of these was invisible until the real audio ran through the real code. They are recorded here
because each one changed the design, not just the implementation.

| # | Defect | Evidence | Fix |
|---|---|---|---|
| D5 | Greedy decoding degenerates into repetition loops | The map step emitted `- Speaker 2: "I'll do it."` **forty times** until it hit the token limit. Caused by the D2 fix. | A repetition penalty (1.15 over the last 256 tokens). Deterministic — it reshapes the distribution, and argmax over it is still argmax. |
| D6 | The extraction notes manufacture absences | Every chunk came back with `DECISIONS: - No further action is required.` and `ACTIONS: - None`, which the narrative then reported to the reader as if it were the meeting. | Three rules on `mapPrompt`: leave empty sections empty, omit unsaid fields, never state that something was not said. Same chunk then yields real decisions. |
| D7 | Prose written from the notes comes back as lists | Fed the notes, the model answered with `#### Actions:` and numbered bullets under every wording tried. A small model mirrors the shape of its input. | The prose chain no longer touches the notes. See "What the narrative is written from" below. |
| D8 | Markdown survives every instruction not to use it | `**Meeting Topic:**` and `### Summary` persisted under all prompt wordings. The app renders plain text, so the reader would see the asterisks. | `stripMarkdown()`, applied to the narrative and the summary. Deterministic; leaves line structure alone. |

**D5 is worth dwelling on.** The fix for D2 caused it. Determinism and degeneration are the two
failure modes of the same knob, and only one of them is visible without running real audio through
it. The repetition penalty is a **separate parameter** from `greedy`, never implied by it: the eval
judge answers twenty claims per batch mostly with the same word, and penalising repeats there would
push it off a correct verdict for no reason but having just given it.

### Cost on device (Pixel 7 Pro)

- Model load: **2,427 ms**
- Decode: **~10 tokens/sec**
- Prefill on a ~1,700-token prompt: **not measured** — must be measured during implementation.
- Estimated total for a short single-chunk meeting: **15–40 s**, against ASR at 0.68× realtime. The
  LLM is a small fraction of total processing time.

### Incidental confirmation

The 1.0 diarization merge threshold holds on real audio: this run found **4 speakers plus
unassigned**; the pre-fix run of the same meeting found **24**. Since `transcriptLines()` feeds
`Speaker N:` labels into the prompt, that fix is a prerequisite for any summary being coherent.

## Decisions

| Decision | Choice |
|---|---|
| Where the map-reduce loop lives | C++ owns the logic, Kotlin owns the loop, via thin JNI calls |
| What the LLM writes | Summary and MOM narrative only |
| Where list items come from | Rule extraction — every item traceable to a quote |
| Minutes storage | Both sources retained; nothing deleted |
| Tabs | Four: Summary, MOM, Actions, Transcript |
| MOM vs Actions | MOM is a shareable document; Actions is a checkable worklist |
| Landing tab | Always Summary |
| Model download | Offered at first run with size shown and a "later" option; auto-downloads on unmetered networks |

## Architecture — processing

### Stage

`ResumePlan.Stage` becomes `{ VAD, ASR, DIARIZE, MINUTES, NARRATE }`.

Rule-based minutes stay unconditional — they cost 8 ms and are the floor. `NARRATE` is gated on its
own output existing, so a resumed meeting does not redo it. `ResumePlan.State` gains
`hasNarrative: Boolean`, true when a `minutes` row exists with `kind='summary' AND source='llm'`.

### Progressive condensation

The naive shape is three generations off the transcript, each paying a ~1,700-token prefill — the
expensive part on a phone. Instead, each output feeds the next:

```
source ──► narrative (MOM prose)          one large prefill
             └──► summary (2-3 sentences)      tiny prefill
                    └──► headline (<=15 words)     tiny prefill
```

One expensive call instead of three, and the tabs cannot contradict each other because each is a
condensation of the one above.

### What the narrative is written from

**Not the extraction notes** — that was the original plan and D7 killed it. What the prose is
written from decides how it reads:

| Meeting length | Source for the narrative | Generations |
|---|---|---|
| Fits one prompt (≲ 9 min, ≲ 6000 chars) | The dialogue itself | 3 |
| Longer | Per-chunk **prose digests**, condensed in groups until they fit | N + 3 |

`digestPrompt` turns a chunk of transcript into three or four sentences of prose; `condensePrompt`
merges several digests into a shorter account, same shape in and out so it can repeat. Neither ever
produces a list. The DECISIONS/ACTIONS/QUESTIONS notes still exist for `enhanceMinutes`, but nothing
in the shipping prose chain consumes them — the rule extractor owns the list items, so the prose
chain never needed them.

### Division of labour

Six thin JNI entry points, added to `cpp/jni/audionotes_jni.cpp` and `NativeBridge.kt`:

- `nativeLlmChunks(texts, speakerIds, spkIds, spkNames) -> String[]`
  (`transcriptLines` + `chunkTranscript`)
- `nativeLlmMapPrompt(chunk) -> String`
- `nativeLlmFoldPrompt(notes) -> String` — **new C++**, merges notes into notes
- `nativeLlmNarrativePrompt(notes)`, `nativeLlmSummaryPrompt(narrative)`,
  `nativeLlmHeadlinePrompt(summary)` — **new C++**

Kotlin holds only the loop, the progress callback, the cancellation check, and a DB write per chunk.
No prompt text, no chunking rule, no JSON parsing in Kotlin — so nothing drifts from the C++ that
the eval harness scores, and the desktop CLI exercises the same code that ships.

`foldPrompt` fixes **D4**: when accumulated notes approach the context budget, fold them in groups
and repeat until they fit. A two-hour meeting degrades in quality rather than silently producing
nothing.

### Checkpointing

New table `llm_notes(meeting_id, chunk_index, note)`. Each chunk's note is committed as it is
produced; on resume, chunks already present are skipped. A process killed at chunk 5 of 9 resumes at
chunk 5.

### Determinism

Pass `greedy = true` on the minutes path — fixes **D2**. `LlamaEngine::load` already takes the flag;
`pipeline.cpp` and `nativeLlmLoad` must forward it. A meeting reprocessed twice yields identical
minutes.

### Single-chunk path

Fixes **D1**: with one chunk, run the narrative prompt directly against the transcript. Never hand a
raw transcript to a prompt that calls it "notes".

### The desktop pipeline ships the same configuration

`cpp/pipeline/pipeline.cpp` no longer lets the LLM replace the rule minutes. It keeps every rule
item, drops only the rules' own `summary` row (a count — "7 action items, 0 decisions"), and puts
the LLM's `summary`, `narrative` and `headline` in front of them. `minutes_source` becomes
`"rule+llm"`.

This matters beyond tidiness: the eval harness scores what the CLI produces. Until the CLI was
changed it scored LLM-authored items that the phone would never show, so its recall and invented
numbers described a configuration that does not exist.

### Source-scoped writes

`replaceMinutes(meetingId, source, items)` deletes only rows of that source — fixes **D3**. This also
makes `PipelineController.regenerateMinutes`'s tier-preservation dance unnecessary: the rule rebuild
can no longer destroy the narrative.

### Degradation

No model installed, device under 3 GB RAM (`LlmModule.kt:36`), or a generation that does not parse →
no `llm` rows are written. The Summary tab renders an at-a-glance view built from rule items. Never
blank, never blocked. This is a supported path, not a failure path.

### JS enhancement retires

`PipelineController.enhanceMinutes` is removed once `NARRATE` runs natively. Keeping both means two
code paths writing the same rows, one of which only runs when the app happens to be in the
foreground.

## Architecture — UI

### File structure

`src/screens/MeetingScreen.tsx` is 675 lines and does everything. It splits into a shell plus four
tab views:

```
src/screens/MeetingScreen.tsx          shell: header, processing state, tab bar, export sheet
src/screens/meeting/SummaryTab.tsx     prose + duration + participants + top 3 actions
src/screens/meeting/MinutesTab.tsx     MOM — narrative + decisions + actions, exportable
src/screens/meeting/ActionsTab.tsx     checkable worklist + open questions
src/screens/meeting/TranscriptTab.tsx  FlatList, speaker-attributed
src/screens/meeting/MinuteCard.tsx     shared item card
src/screens/meeting/UtteranceRow.tsx   shared transcript row
```

`Segmented` — the tab primitive, which does not exist today — goes in `src/components/ui.tsx`
alongside the other primitives, matching the existing convention of one primitives file.

### Transcript performance

`TranscriptTab` uses `FlatList`, not a `.map()` inside a `ScrollView`. Today every utterance renders
at once; the 8.5-minute fixture is 133 rows and an hour-long meeting is roughly 900.

### Checkbox persistence

New table `action_done(meeting_id, item_key, done_at)` where `item_key` is a hash of the normalized
action text, **not** a row id. Minutes rows are replaced wholesale on reprocessing; keying on row id
would silently uncheck everything the user had ticked off.

### Library row

`LibraryScreen` shows `meetings.summary_line` when present, and the live stage otherwise:
"Transcribing… ~12 min" → "Writing minutes…" → the one-liner. A row must never be blank while work
is in flight — that reads as broken.

### Summary tab content

Prose summary, meeting duration, participants, and the top three action items. If it holds only two
or three sentences it is a near-empty screen and users learn to skip past it.

## Data model

All schema changes go in `AudioDb.SCHEMA` (new tables, `CREATE TABLE IF NOT EXISTS`) and
`AudioDb.ADDED_COLUMNS` (new columns, a `Triple(table, column, decl)` list that
`addMissingColumns()` applies via `ALTER TABLE` on open — it currently holds one entry).

> **Trap:** `src/db/schema.ts` is imported nowhere. `StorageModule` delegates to `AudioDb`, so the
> Kotlin declaration is the only one that runs. A column added to `src/db/schema.ts` will not exist.
> Update it for documentation, but it is not the source of truth.

| Change | Purpose |
|---|---|
| `meetings.summary_line TEXT` | Library row one-liner; on the meeting row so the list needs no join |
| `llm_notes(meeting_id, chunk_index, note)` | Per-chunk resume |
| `action_done(meeting_id, item_key, done_at)` | Checkbox state surviving reprocessing |
| `MinuteKind` gains `'narrative'` | The MOM prose body; update `src/pipeline/types.ts:47` and the C++ kinds |
| `MinuteKind` gains `'headline'` | The one-line description, mirrored onto `meetings.summary_line` |

## Code layout note

`cpp/minutes/llm_minutes.cpp` is split in two. The Android target could not link it: nlohmann is
deliberately absent from `libaudionotes` (see the note in `cpp/jni/audionotes_jni.cpp` about paying
~200 KB of template machinery to parse two small arrays). Rather than silently reverse that
decision, the prompt builders, chunking, `foldPlan`, `stripMarkdown` and `narrate` moved to
`cpp/minutes/llm_prompts.cpp`, which needs no parser. `parseMinutesJson` and `enhanceMinutes` stay
in `llm_minutes.cpp`. Android links only the half it uses.

## Testing

- **C++ unit tests** for `foldPrompt`, the new prompt builders, and the single-chunk path — the
  existing `cpp/tests` pattern, with an injected `GenerateFn` so no model is needed.
- **Golden parity** for any prompt text shared with TypeScript, matching the existing
  `MinutesParityTest` approach.
- **Instrumentation test** on device: run `NARRATE` over a fixture transcript and assert it produces
  a `summary` row, a `narrative` row, and a `summary_line`. Extend it to log per-chunk milliseconds —
  this is where prefill gets measured.
- **Resume test**: kill after chunk N, re-run, assert chunks 0..N-1 are not regenerated.
- **Determinism test**: run twice, assert identical output.
- **Eval harness**: score the narrated minutes with the judge built on 2026-08-25 before treating
  the summary as production quality. Calibration is still ungated — the harness reports the numbers
  as provisional until 20 items are human-labelled.

## Out of scope

- Improving ASR for code-switched Hindi/English. The summary faithfully summarizes whatever the
  transcript says; leading with it makes the ASR gap the first thing visible. That is Phase 2 and is
  tracked separately.
- Diarization *segmentation* error, now the residual DER after the clustering fix.
- Any change to recording, PiP, or the foreground service.
