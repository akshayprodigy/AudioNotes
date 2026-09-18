# Phase 5 — Custom vocabulary and dictation mode (the design)

*18 September 2026. Sub-project 8 of the release plan, from the improvement report of 7 Sep
("Keep a local vocabulary" and "Dictation mode"). This document holds the decisions and the
measurements behind them; the builder never reads it — it reads the execution sheets
(`2026-09-18-phase-5-session-1-execution.md`, then Session 2 and Session 3, written after each
review). Decisions taken in the founder's absence are marked ⚑ — overrule by saying so.*

## 1. What the report asks for, in its own words

- **Vocabulary:** "Allow users to add names, companies, abbreviations, and project terms.
  Support a correction such as *'When I say Innova, do not write in over.'* Use recognition
  hints where supported and show suggested replacements elsewhere. A glossary entry should not
  force a matching word into unrelated audio. Store accepted corrections locally and make them
  editable and removable."
- **Dictation:** a separate workflow for one person creating something — skip diarization;
  survive long pauses without inventing text; add punctuation while keeping the original
  recognised wording; an explicit command mode for "new paragraph"; corrections with undo;
  turn the content into a note using only what was said; a verbatim view alongside; apply the
  local vocabulary. "Do not interpret 'delete that' as a destructive command during an ordinary
  meeting."

## 2. What was measured before deciding (18 Sep, on the Mac)

**Recognition hints hurt more than they help on this recogniser.** Whisper-base was given the
eight names of AMI ES2003a as its initial prompt (`--vocab`, commit `9f05928`):

| fixture | prompt | WER | deletions | name mentions right |
|---|---|---|---|---|
| ES2003a (has the names) | none | 24.9% | 224 | 7 of 14 |
| | the names | 26.2% | 249 | **12 of 14** |
| ES2002a (has none of them) | none | 29.7% | 304 | — |
| | the names | **32.5%** | **417** | none forced in |
| | as a sentence | 36.0% | 474 | none |

Every prompt shape makes whisper drop words (deletions +37–56% on the unrelated meeting).
Rescuing five name mentions in the meeting that has them costs every other meeting 3–6 points.
**⚑ Decision: the product does not feed the recogniser a prompt.** The hook stays in the core
for re-measurement with a different engine. Vocabulary is built as **correction rules applied
after recognition** — "in over" → "Innova" — which is exactly the report's own example, costs
unrelated audio nothing, and is testable without a model.

**The dictation write-up works, with two rules around it.** The real writer (Qwen 1.5B,
greedy) given a dictated record keeps names, amounts, negations and doubt and drops fillers
(`test_narrate_live`, dictation case). Two things it does that the phone must undo: it opens
with the addressee as a label ("The note for Priya:"), which the phone's `stripLabels` would
throw away — `foldDictation` turns the colon into a full stop; and it bullets short sentences —
the same fold joins them back into a paragraph. One thing no prompt wording fixes: given a
**run-on clause** ("…ship on Monday, uh, the vendor codes are…") it invents a cause ("due to");
given dictated full stops it keeps the facts apart. So dictation asks the speaker to say the
marks, and the by-hand test speaks them.

## 3. Decisions

1. **Vocabulary = rules.** Table `vocabulary(id, heard UNIQUE COLLATE NOCASE, meant, source
   'typed'|'learned', created_at, uses)`. `Vocabulary.apply(text, rules)` (Kotlin, pure):
   whole-word, case-insensitive, longest `heard` first, `meant` written as typed. Applied to
   every utterance at the end of the ASR stage, both modes; the recogniser's wording is kept in
   `utterances.text_raw` whenever a rule changed a line (NULL otherwise), so nothing is lost.
   ⚑ Pro only, like every cross-meeting memory (the founder's rule of 17 Sep); a free user's
   corrections stay corrections.
2. **Rules are learned from "Correct the words".** When a transcript line's edit is saved and
   the difference between the recognised and corrected text is one contiguous substitution of
   one to three words each side, the app asks once: *"Always write 'Innova' when it hears
   'in over'?"* — Yes stores a `learned` rule and applies it to the rest of this meeting; No
   stores nothing. Rules can also be typed in Settings › Vocabulary (heard → meant) and are
   editable and removable there. (Session 2.)
3. **Dictation is a mode of a meeting.** `meetings.mode TEXT` ('dictation'; NULL = meeting),
   chosen on the Record screen before recording (a setting `record_mode` remembers the last
   choice; the default is meeting) and stamped at creation. In dictation: diarization is
   skipped ("one voice"); spoken punctuation (`applySpokenPunctuation`, C++: full stop, comma,
   new line, new paragraph, question mark, exclamation mark — never "period" or "colon", which
   are nouns) is applied at the ASR stage with the raw wording kept in `text_raw`; the meeting's
   template is fixed to `dictation`, whose narrative is the note itself (§2), Pro like every
   narrative; the rule-based items still run (a dictated action is an action). Free gets
   dictation mode with the verbatim transcript and rule items; the written note is Pro.
4. **The verbatim view is the Transcript tab; the note is the Summary/MOM.** No new screen.
   `text_raw` is stored for the record and for exports; a "show recognised wording" toggle is
   out of scope for this phase.
5. **No live-transcript changes.** Rules and commands apply when the recording is processed,
   not in the PiP window. (The live pass decodes windows that are handed to the final pass as a
   cache; a vocabulary would have to be identical in both — moot, since the recogniser is not
   prompted.)
6. **Undo of a correction** is the existing "put the original back" on the edited line; a
   learned rule is removed in Settings. No further undo machinery.

## 4. Sessions

- **Session 1 — native and data** (sheet written): schema (`mode`, `text_raw`, `vocabulary`,
  backup), `Vocabulary.kt` + golden, `AudioDb` functions, the ASR-stage hook, the dictation
  branches in the pipeline, the JNI for spoken punctuation, `StorageModule` methods, device
  tests, the probe.
- **Session 2 — screens** (sheet after Session 1's review): Record-screen mode choice;
  Settings › Vocabulary; the rule proposal on "Correct the words"; the "Dictation" label.
- **Session 3 — device** (sheet after Session 2's review; run only with the Pixel attached):
  the by-hand dictation with spoken marks, a learned rule, a typed rule, free vs Pro.

## 5. Out of scope

Recognition-hint prompting (measured, off); live-transcript rules; a verbatim toggle in the
UI; voice commands beyond the six marks ("delete that", "undo"); formatting choices (note /
list / draft — the note is the shape); any change to the Hindi path; export changes.
