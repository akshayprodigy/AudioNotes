# Speaker repair — who said this line

*Sub-project 3 of the improvement-report work. 16 September 2026. Founder decisions: the gesture
lives on the Script (long-press a line, or tap the name at the head of a turn); a change offers
three scopes; a person's corrections survive diarization running again.*

Text is correctable today (long-press a line, keyed on the line's id, stored in `edits`); who
said it is not. Wrong attribution is the top diarization complaint in every review, and the
6 Sep measurement made it a number: Indian-accented English scores 79.1 % attribution against
92.6 % for American — same recogniser, same settings. Until diarization improves, this is the
mitigation.

**The reduction.** The Script groups consecutive same-speaker lines into a turn. "Split a turn"
is "from this line on, it was someone else"; "merge two turns" is "this turn was the same person
as the one before". Both are reassignments of lines to a speaker. So the whole feature is one
gesture — change who said these lines — with a scope. No line is ever cut mid-sentence (that
would need word timestamps); no new data shape is invented.

## 1. Data and durability

**Write-through, recorded as an edit.** `db.setLineSpeaker(meetingId, lineIds, speakerId)`
runs one transaction: `UPDATE utterances SET speaker_id = ?` for each id, and `INSERT OR
REPLACE INTO edits(meeting_id, 'speaker', <line id>, <speaker id>)`. Writing through means
exports, minutes, search and the narrator see the change with no new code; recording it means
diarization can be re-run without losing it.

**A new voice.** `db.addSpeaker(meetingId, name)` inserts a `speakers` row with `cluster_label
= 'human'` and the given name (blank → "Speaker N", N one past the current count). The
Speakers screen lists it like any other; merge works on it.

**Re-diarization keeps human work.** `AudioDb.assignSpeakers` (Kotlin; the only writer of
machine attribution) today deletes every speaker row and reassigns every line. It now:

1. collects the *protected* speakers — every `speakers` row that is human-created
   (`cluster_label = 'human'`), renamed (`display_name` not of the form "Speaker N"), or
   referenced by any speaker edit of this meeting — and the *pinned* lines — every line with a
   speaker edit;
2. deletes only unprotected speakers; assigns clusters only to unpinned lines; re-applies
   every speaker edit whose speaker row still exists (they all do — it was protected);
3. drops empty machine clusters and renumbers the machine speakers as before, leaving
   protected rows' names alone.

The decision — which ids are protected, which lines are pinned — is a pure object,
`SpeakerRepair`, with JVM tests; AudioDb does the SQL.

**No per-line revert.** A wrong reassignment is fixed by reassigning again, and a duplicated
voice by merging on the Speakers screen. The word-correction "put the original back" has no
honest equivalent here: the machine's assignment is not kept once a person has overruled it.

**What a reassignment does not touch.** Items already extracted carry their owner in their text
("— Speaker 1"), as they do after a rename today; the MOM prose is rewritten by "Write it again".
Both are the existing behaviour for word corrections and stay so.

## 2. The gesture

**Long-press a line** now opens a small `Sheet` with two actions: **Correct the words** (the
existing prompt) and **Change who said it**. The hint under the Script header becomes "Tap a
line to hear it. Long press to correct it or change who said it."

**Tap the speaker name** at the head of a turn: "Change who said it" for the whole turn.

**The picker** is a `Sheet` titled with the line's first words ("Who said “Sure, after looking
at the…”?"):

- one row per speaker in the meeting, the current one marked; then **Someone new** (asks for
  a name with the existing `TextPrompt`);
- a scope row of three chips, shown when the line is in a turn with more than one line: **Just
  this line** (default) · **From here to the end of the turn** · **The whole turn**. From the
  turn head, the scope is the whole turn and the chips are not shown.

Choosing a speaker applies it at the chosen scope and refreshes the Script; the turns regroup
on their own, which is what makes a split or a merge appear.

**Scope → ids** is a pure function, `linesForScope(turn, lineId, scope)`, tested.

## 3. Tests

Every new test mutation-checked.

- `SpeakerRepairTest` (JVM): protected = human-created, renamed, referenced by an edit; not
  protected = a machine "Speaker N" with no edit; pinned lines are exactly the edited ones;
  the re-apply list is every edit whose speaker survives.
- `schema.test.ts` / `SchemaTest.kt`: nothing new (no schema change; `edits` and `speakers`
  exist).
- `speakerRepair.test.ts`: `linesForScope` for the three scopes at the first, middle and last
  line of a turn; `nextSpeakerName` for the blank-name case.
- `MeetingScreen.test.tsx`: long-press a line → the sheet offers both actions; choosing a
  speaker with "whole turn" calls `db.setLineSpeaker` with every id in the turn; "Someone new"
  adds a speaker then assigns.
- `TranscriptTab.test.tsx` (new): tapping the turn head calls `onReassignTurn` with the turn's
  ids.
- Device: on the Pixel, a two-voice meeting: reassign one line (a new turn boundary appears),
  reassign "from here" (the turn splits), reassign a whole turn to the previous speaker (the
  turns merge), create "Someone new"; export Markdown shows the new attribution; the Speakers
  screen lists the new voice; then force diarization to run again (a meeting recorded with the
  speaker models absent, or a Redo on a diarize-skipped meeting) and confirm the corrections
  and the name survive.

## Out of scope

Splitting a line mid-sentence; propagating a reassignment into already-extracted items' owners;
voice enrolment ("remembered voices" is sub-project 7); undo.

## Device verification — Pixel 7 Pro, Android 17, 16 Sep 2026

Release APK; the 3-minute two-voice meeting recorded earlier that day, which diarization had
returned as **one** speaker — the exact case this exists for.

**Gestures and scopes.** Long-press "Sure." → the two-action sheet titled with the line →
"Change who said it" → the picker: title "Who said “Sure.”?", three chips ("Just this line"
selected), Speaker 1 ticked, "Someone new". "Someone new" → "Who is this?" → "Daniel" → Add:
Daniel appears as a turn. Long-press "After looking at…" → "From here to the end of the turn"
→ Daniel: the rest of Speaker 1's turn moved and merged into Daniel's turn (the split and a
merge, from one regrouping). Tap the "Daniel" turn head → picker with no chips, Daniel ticked →
Speaker 1: the whole turn moved back and merged with the turn above. Long-press "Sure." → Daniel
again for the export check.

**Everywhere else.** Summary header: "2 speakers". Speakers screen lists Daniel with the merge
control like any other voice. Copy (the Markdown document): `**Daniel:** Sure.` between Speaker
1 lines — write-through, no export code touched.

**Durability.** `SpeakerRepairDbTest` on the phone (2 tests, listed in device-verify): a
renamed speaker keeps its id and name across a second `assignSpeakers` that re-clusters
everything the other way, the line a person spoke for keeps its speaker, the untouched lines
are re-clustered, no two speakers share a name, a human-created voice with no lines is kept.
Mutation-checked on the phone: removing the protected delete fails both tests; removing the
pinned-line skip AND the re-apply loop together fails (each alone is redundant with the other,
by design — belt and braces). No meeting in the library had diarization skipped, so a
re-diarization through the app itself was not exercised; the instrumentation test is the proof.

**One defect found in the run, fixed.** On every opening of the picker after the first, Android
shrank the first chip and cut its text to "Just this". `flexShrink: 0` on the chips; verified on
the next opening. (The Pixel dropped off USB before the opening after that could be captured.)

**Not exercised.** Reassigning on a meeting whose audio was deleted (the Script's long press
still works there — the gesture does not depend on the player).
