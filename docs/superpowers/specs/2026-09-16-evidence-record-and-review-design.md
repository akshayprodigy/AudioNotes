# Evidence Phase B and C — the typed record, and the review queue

*Sub-project 4 of the improvement-report work. 16 September 2026. Builds on the evidence spine
(Phase A, `2026-09-08-evidence-spine-design.md`), whose decisions stand: full scope; provenance
free, interpretation Pro; `items`/`item_sources`; the queue is per-meeting, a banner on Summary
opening a card flow. Founder decisions today: only what the model is unsure about enters the
queue; a card offers Confirm · Fix · Not an item.*

Phase A gave every item a stable id and an audio anchor. What it could not do is read the
second turn. The report's lead example — *"Can you send the proposal Friday?"* answered by
*"Only a draft; the final version needs another week"* — is still extracted as a request for the
proposal on Friday, because rules see one sentence. This sub-project adds the reader that sees
the reply, records what it read in the columns Phase A reserved, and asks a person only about
the things it could not settle.

## 1. The typed record (Phase B)

**When it runs.** Inside the narrate stage, Pro only (the same gate as narration: no weights on
disk for a free user). After the rule pass has produced the meeting's items and before the
prose is written, so the narrator's validator can hold the prose against typed items. Progress
reports through the existing `onStage("narrate", done, total)` with the classifier's items added
to the total; a thermal pause lands between items like any other unit of work.

**What it reads.** One bounded window per item: the turn the item was lifted from and the next
turns up to `REPLY_WINDOW_TURNS = 4` or `REPLY_WINDOW_MS = 90_000`, whichever ends first, each
turn prefixed with its speaker name and ordinal. That is where a qualification or a contradiction
lives. The window is fenced as recorded speech through the one helper (`cpp/minutes/fence.h`);
`check-prompt-fencing.py` keeps it there.

**What it answers.** A grammar-constrained JSON object — `llama_sampler_init_grammar` with a
GBNF grammar built once in C++ — so the model cannot produce anything but:

```
{
  "type":       "proposal" | "agreement" | "commitment" | "request" | "rejection" | "unresolved" | "uncertain",
  "status":     "open" | "qualified" | "contradicted" | "withdrawn",
  "owner":      { "kind": "speaker" | "person" | "unassigned", "name": "<quoted span or empty>" },
  "date_said":  "<quoted span or empty>",
  "cited":      [ <turn ordinals within the window> ],
  "confidence": "high" | "low"
}
```

**The validator** (pure C++, `evidence_record.cpp`, tested off a device with hand-written model
outputs): `owner.name` and `date_said` must appear verbatim (case-insensitive, whitespace-folded)
in the text of a cited turn, or they are blanked and `confidence` becomes `low`; `cited` must
name the source turn (ordinal 0) or the record is rejected and the item keeps `item_type =
'uncertain'`; a `status` other than `open` must cite at least one turn other than the source, or
it falls back to `open`. The model can only ever quote.

**Owner resolution.** `kind = speaker` → the source turn's speaker id (the classifier never
guesses a name for a voice; "I will" is the speaker). `kind = person` → the quoted name; matched
case-insensitively against the meeting's speaker names, and stored as
`{kind:'speaker', id}` when it matches one, else `{kind:'person', name}`. `unassigned` stays so.
Confidence is the classifier's, downgraded by the validator.

**Date normalisation is a rule, not the model.** `DateNorm` (pure Kotlin, mirrored in TS for
display, both tested against one golden table): `date_said` + the meeting's date → `date_norm`
epoch-ms or null. Resolvable: "tomorrow", "today", weekday names (the next such day after the
meeting; "this Friday" the same; "next Friday" the one after), "end of the week" (Friday), "by
the 3rd" / "on the 21st" (this month, or next if passed), "in two weeks". Not resolvable, and
deliberately null: "next week", "soon", "after the launch", "another week", anything relative to
an unknown event. `date_said` is kept always.

**What needs review** (`ReviewRule`, pure, both languages, one golden table): an item enters
the queue — `review = 'needs_review'` — when any of: `item_type = 'uncertain'` or
`confidence = 'low'`; `status ≠ 'open'` (a later turn pushed back; a person should see it);
`kind = 'action'` and owner `unassigned`; `date_said` set and `date_norm` null. An item confidently
typed with a resolved owner and no date trouble is `suggested` and shown with its label, never
asked about. A person's `confirmed` / `rejected` is never overwritten by the rule.

**Storage.** The five reserved columns are written on `items` by the classifier through
`AudioDb.classifyItem(id, record)`. `replaceItems` and the `Reconciler` carry them forward on a
confident match exactly as `created_at` and `gen_version` are carried — this is the warning the
Phase A author left in `replaceItems`, and it is the first thing Phase B does. On an ambiguous
match they are carried and `review` becomes `needs_review`, as today. `gen_version` becomes
`"rules@N+qwen2.5-1.5b/classify@1"` for a classified item.

**Free tier.** Unchanged from Phase A §9: quotes with timestamps, the five columns NULL, no
labels, no queue.

## 2. The review queue (Phase C)

**The banner.** On the Summary tab, above the summary card, when the meeting has any
`needs_review` item and the user is Pro: "**3 items need a look** · what the model could not
settle" with a "Review" button. Hidden when the count is zero; hidden on free (nothing is ever
classified there).

**The card flow** (`ReviewScreen`, a stack screen, one card at a time, "2 of 3" in the header):

- the item as a quoted passage with its stamp and a play control (the Phase A provenance tap);
- **what the model read**, as chips: the type ("Request"), the status when not open
  ("Qualified — *only a draft; the final version needs another week*", with the cited turn's
  stamp, tap to play it), the owner ("Priya" / "Speaker 2" / "No owner"), the date ("Friday" and,
  when resolved, "→ Fri 19 Sep"; when not, "→ which day?");
- **why it is here**, one line from `ReviewRule`'s reason ("A later turn qualified this." / "No
  owner." / "The date could not be pinned to a day." / "The model was not sure what this is.");
- three actions: **Confirm** (`review = confirmed`, next card), **Fix** (opens the one field the
  reason names, or a small chooser when several: owner → the speaker picker from sub-project 3
  plus "Someone else…" for a typed name; date → a date picker seeded from `date_norm` or the
  meeting date, with "No date" — `date_said` is never changed; type → the seven types; each fix
  writes the field and sets `review = confirmed`), **Not an item** (`review = rejected`, hidden
  from every tab and export, next card).

Finishing the last card returns to the Summary, banner gone. Leaving mid-way keeps what was
done; the banner counts what is left.

**What a confirmed item looks like afterwards.** On the Actions tab and in exports, the same
row as before, with its label chips and — for a fixed owner or date — the person's value.
Rejected items disappear from Actions, MOM, Summary counts and exports (they are kept in the
table for the Reconciler, as `rejected`).

**Survival.** `review`, `owner_json`, `date_norm`, `item_type` all ride the Reconciler's
confident-match path, so a reprocess keeps a person's confirmations and fixes; an ambiguous match
re-queues the item, which is the honest outcome the spine spec already chose.

## 3. Tests

Every new test mutation-checked.

- C++ `test_evidence_record`: the grammar admits the seven types and nothing else (a fixed
  sampler over hand-written token streams is out of scope; the test checks the grammar string
  compiles in llama.cpp's parser and that a set of good/bad JSON strings are accepted/rejected by
  the validator); the validator blanks a non-verbatim owner, rejects a record that does not cite
  the source, downgrades a status with no second citation; the lead example's hand-written
  record — `request`, `contradicted`, cited `[0, 1]`, `date_said = "Friday"` — validates whole.
- `DateNormTest.kt` + `dateNorm.test.ts` against one golden JSON: the resolvable phrases above
  land on the right day for a fixed meeting date (a Wednesday), the unresolvable ones are null.
- `ReviewRuleTest.kt` + `reviewRule.test.ts` against one golden JSON: each trigger alone queues;
  a clean commitment does not; `confirmed` and `rejected` are never overwritten.
- `ReconcilerTest.kt`: a confident match carries `item_type`, `status`, `owner_json`,
  `date_said`, `date_norm`; an ambiguous one carries them and re-queues.
- `SchemaTest.kt` / `schema.test.ts`: no schema change (columns exist since Phase A).
- `ReviewScreen.test.tsx`: Confirm writes `confirmed` and advances; Not an item writes
  `rejected`; Fix owner opens the picker and writes `owner_json` + `confirmed`; the last card
  returns.
- `SummaryTab.test.tsx`: banner with the count on Pro with `needs_review` items; none on free;
  none at zero.
- Device (Pixel, Pro entitlement): record the report's lead example with two voices; after
  processing, the item reads *Request · Contradicted* citing both turns, `date_said = "Friday"`,
  `date_norm` null (the "another week" reply makes Friday not the answer — the classifier's
  status, not the normaliser, is what carries that); the banner says "1 item needs a look"; the
  card shows the qualification with its stamp; Confirm clears the banner; Redo → the confirmation
  survives. A second meeting with "Priya will send the deck tomorrow" produces a `commitment`,
  owner Priya, `date_norm` = the next day, and no card.

## Out of scope

Discovering items the rules missed (the classifier types what the rules found — bounded on
purpose); the narrator consuming the typed record (validated, not rewired — spine §7); a global
review inbox across meetings; changing item text on a card; undo.

## Device verification

*Pending — the Pixel was not on adb on 16 September. Code complete through Task 8b (`c8b830e`),
gate green. The Task 9 checklist is in the plan; in short: the grammar test in
`NativePipelineTest`, the lead example (Request · Contradicted, banner, card, Confirm, Redo), the
clean commitment (no card, chips), free tier (no labels, no banner).*

