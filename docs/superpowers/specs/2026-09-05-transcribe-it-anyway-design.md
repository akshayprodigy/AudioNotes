# Transcribe it anyway — a way back from a wrong refusal

**Written 5 September 2026.** Answers `docs/NEXT.md` §1 item 6. Companion to
`2026-09-04-english-only-and-refusing-to-fabricate-design.md`, which built the refusal this
undoes.

## The problem

Most of item 6 already ships. A refused meeting shows a settled `NOT ENGLISH` badge, a library row
reading "Not transcribed — sounds like Turkish", and a detail screen that explains itself and says
the audio is kept. The refusal path returns before the retention step, so the recording really is
still there.

What it has no answer for is **the refusal being wrong**.

A five-minute English meeting on a Galaxy A07 was heard as Turkish at p=0.88. `e5d5e24` made that
much harder — detection now needs a strict majority of five windows to agree — but harder is not
impossible, and the failure it guards is asymmetric in exactly the way that matters: a wrong
refusal costs somebody the meeting they just recorded, and today they cannot get it back. Redo
re-runs the same detection and reaches the same verdict. There is no override, and no amount of
being certain the recording was English changes that.

**Scope.** One recovery action and the guarantees that must survive it. Not notifications when a
language ships; not promoting Redo generally.

## The tension this has to hold

The refusal exists because fluent invented English over foreign audio is indistinguishable from a
real transcript. An hour-long Bengali meeting came back as confident English prose with a summary
that read as correct to somebody who had been in the room. An override hands that failure back to
the user on request.

So the override is not "turn the check off". It is "record that a human overruled the check, and
never let the result pretend otherwise".

## Design

### Data

Two nullable columns, through the existing `ADDED_COLUMNS` migration helper in `AudioDb`:

    Triple("meetings", "transcribe_forced_at", "INTEGER")
    Triple("meetings", "forced_from_language", "TEXT")

Null `transcribe_forced_at` means never forced. A timestamp means a person was shown what forcing
costs and chose it.

**The request and the record are the same fact**, which is why forcing is one column and not a
transient flag plus a marker. Those two can disagree — a forced run that crashes leaves a marker
with no transcript, or a marker that never gets written leaves invented text looking genuine.

`forced_from_language` exists because the marker's whole claim — "heard as Turkish" — is otherwise
destroyed by the very run it describes. On the refusal path `ProcessingEngine` sets `language` to
what was HEARD; on the success path it sets `language` to what was REQUESTED. A forced run takes
the success path, so `language` becomes `en` and the heard code is gone by the time anything wants
to render it. Capturing it at the moment of forcing, into a column nothing else writes, is what
keeps the banner truthful three weeks later.

Deriving forcing instead (a `done` meeting whose detected language was unsupported) was rejected
for the same reason: it depends on a value the successful run overwrites.

### Native

`AsrConfig` gains `bool skip_language_refusal = false`. In `whisper_asr.cpp` it guards **only** the
`shouldRefuse` branch:

    if (!cfg_skip_refusal && shouldRefuse(heard, kRefuseConfidence)) { … }

Detection still runs. That is deliberate and load-bearing: `run.detected_language` and
`run.detected_confidence` are what the marker copy says out loud, and a run that skipped detection
could only say "you forced this", not "we heard Turkish and you overruled us". The cost is a
handful of encoder passes, already paid on every run.

`shouldRefuse` itself is untouched — it stays pure, and its existing tests stay valid.

### Kotlin

`ProcessingEngine` reads `transcribe_forced_at` alongside the language setting and passes the flag
through `nativeTranscribe`. The early return on `unsupported_language` is unchanged for meetings
that were not forced.

It must NOT clear `forced_from_language` when the forced run succeeds and sets `language` to `en`.
That is the one ordering mistake available here, and it silently empties the banner rather than
breaking anything.

A forced meeting that still comes back `unsupported_language` cannot happen — the flag suppresses
the only thing that sets it — but the branch is left in place rather than asserted away, because
a second engine could set that field for its own reasons.

### UI

**The action.** The refused screen gets a primary button, **"Transcribe it anyway"**. Today the
only route onward is Redo, buried in the overflow sheet, which re-runs the same detection and
lands in the same place — an action that appears to do nothing is worse than no action.

**The confirmation.** A dialog stating the trade in the terms that decide it. "Turkish" below
stands for whatever was detected; where nothing was named, the copy falls back to "does not sound
like English", matching `unsupportedLanguageNote`'s existing two-way split:

> **Transcribe it anyway?**
> This sounds like Turkish. If we heard wrong, this will transcribe it as English.
> If we heard right, the result will be invented text that reads as real.
> [Cancel] [Transcribe anyway]

Both outcomes, in the order the user cares about. Not a generic "are you sure".

**The marker.** Any meeting with `transcribe_forced_at` set carries a persistent, non-dismissible
banner:

> Forced transcript — heard as Turkish, transcribed as English.
> If it was not English, the words below are invented.

Non-dismissible because its whole purpose is to outlive the moment of decision. The person who
forced it knew; the person reading it three weeks later, or the colleague they forwarded it to,
did not.

Composed at render time from `forced_from_language`, never stored in `summary_line` — the mistake
`2026-09-04`'s design already records, where a status message parked in a content field outlived
its status.

### Exports

`FileExportModule.buildDocument` selects `transcribe_forced_at` and `forced_from_language` with
the rest of the meeting row
and prepends the marker to every format: Markdown, plain text, PDF (as a block, since a PDF is
laid out rather than concatenated) and SRT (as a leading cue).

**This is where the harm actually lands.** The in-app banner protects the person who forced it. The
export is the artefact that leaves the phone and gets forwarded, and a PDF of invented minutes
with no warning on it is the failure the refusal was built to prevent, merely relocated.

SRT gets a cue rather than a comment because subtitle players ignore comments.

## Testing

| what | where |
|---|---|
| `skip_language_refusal` suppresses refusal and leaves detection intact | `cpp/tests/test_asr_languages.cpp` — `shouldRefuse` is pure, and the flag is a branch around it |
| both columns round-trip and default null | Kotlin unit test, following `MinutesSourceTest` |
| a successful forced run leaves `forced_from_language` intact | Kotlin unit test — this is the one ordering mistake available, and it fails silently |
| a forced meeting transcribes instead of refusing | `NativePipelineTest` on device, using the existing English fixture with the flag forced on |
| every export format carries the marker | Kotlin unit test over `buildDocument` for md/txt/pdf/srt |
| the refused screen offers the action, and a forced meeting shows the banner | on device, `npm run test:device` scope permitting; otherwise by hand |

The device suite is the one that matters here — `0fb96e8` is a reminder that this JNI signature
changing is exactly the kind of thing whose tests go stale silently.

## What this deliberately does not do

- **No notification when a language ships.** Item 6 as written mentions it; it pays off only when
  Hindi lands and needs a migration hook and a notification path. Separate piece of work.
- **No global "never refuse" setting.** The override is per-meeting recovery. A preference that
  disabled the check for all future recordings would remove the guarantee rather than let somebody
  overrule it once, and the guarantee is the product.
- **Narration is not blocked on forced transcripts.** Considered — the summary is what gets
  forwarded and believed — but a genuinely-English false refusal would then be only half
  recoverable, and the marker travels into the exported summary anyway.
