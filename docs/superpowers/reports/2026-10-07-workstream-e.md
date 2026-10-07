# Workstream E — useful sharing and acquisition (software part)

Branch `dev/october-plan`, 7 Oct 2026. Commits: `9a2d832` (native document builder), `0d7e760` (Share screen),
`a59e636` (copy guard). Nothing was run on a phone.

## What was built

**One document, many writers.** `ShareDocument.kt` (new) builds a `Doc` from the same `Content` the exports
already read (corrected transcript text, live speaker names, owners resolved from the speaker row — the F14/F15
reads are untouched). Markdown, plain text, the PDF block list and the share preview are all written from that
`Doc`. `FileExportModule.compose(content, format, marker, options)` is the pure step after the reads; `share`,
`shareWith` and `preview` all go through it, so the preview is the file:

* `preview` returns the file's own body for md/txt/srt; for PDF it returns the words of the PDF's blocks in order.
* `ShareDocumentTest.thePreviewIsTheMarkdownExportBody` asserts preview == Markdown body for the same input, with
  and without the credit.

**What the document says (honest content).**

| Situation | Written as |
|---|---|
| Action with no owner (or the extractor's `— Unassigned`) | `· Owner not set` (the word "Unassigned" is never printed) |
| Action with no due date (no `(due …)`, no normalised date, no date *said*) | `· No date given` |
| Item the review queue is holding (`needs_review` AND classified — the queue's own test) | `· Needs a look` |
| Item the person ticked (`item_done` by id, or `action_done` by text hash) | `· Done` |
| Hand-typed item | included, no stamp, same flags |
| Decision / question | only `Needs a look` / `Done` (they have no owner or date to be missing) |
| No summary / no minutes | nothing; no placeholder prose |
| Sample meeting | the banner is screen chrome and is in no format; the title ("… (sample)") is the meeting's own |

Nothing is invented: a missing owner never takes a speaker's name, a missing date never takes a day.

**Attribution.** `ShareDocument.ATTRIBUTION = "Created with Verbale — private meeting notes"`, off by default,
persisted in `settings` key `shareAttribution`. On: Markdown ends with a rule and the line in italics, text ends
with the line, PDF gets one 8 pt grey block as the LAST block (flows after the body, cannot overlap it). Never in
SRT, never in the copied-transcript format. **Behaviour change:** the previous build appended an always-on
`Created with Verbale — verbale.innocorelabs.com` footer to every export; that is removed (`EXPORT_CREDIT` gone).

**Share screen** (`src/share/SharePreviewScreen.tsx`, route `Share`): format picker (PDF, Markdown, Text,
Subtitles — all four kept, all free), the preview text (flags drawn in an amber chip, `Done` in faint grey,
credit small and grey, a one-line legend when anything is unresolved), the credit toggle (hidden for Subtitles),
and a Share button that calls `FileExport.shareWith(meetingId, format, attribution)`. Share is disabled only while
the preview is loading or a share is in flight; if the preview fails the person can still share.
`share`/`render` (the old entry points, still used by Meeting's copy button) read the saved toggle natively.

**Availability.** Nothing under `src/share/` imports from `billing/`, and `ShareDocument.kt` has no licence or
allowance parameter. `ShareAvailability.test.tsx` renders with the allowance exhausted and a lapsed licence in the
native mocks: Share is enabled, the document is requested, `shareWith` is called, and `Licence.allowance` /
`Licence.status` are never called. Two static tests (JS imports, Kotlin source) keep it that way.

## THE HOOK the Meeting screen needs (Workstream D owns the file; I did not edit it)

`src/screens/MeetingScreen.tsx` line **869** (at the time of writing):

```tsx
const onExport = () => setExportSheet(true);
```
becomes
```tsx
const onExport = () => navigation.navigate('Share', { meetingId });
```

That is the single call. The route is already registered (see "Repo note" below). After it, the old export sheet is
dead and can be deleted by D: `exportSheet` state (line 868), `exportActions` (lines 898-907) and the two
`<Sheet … title="Export minutes" …>` blocks (about lines 1162 and 1491). `FileExport.share(...)` there is the
legacy path without a preview; `onCopy`/`copyDoc` (`FileExport.render`) can stay as they are — they now honour the
saved credit toggle too.

## Tests

Kotlin (`ShareDocumentTest`, 33 tests; `ExportItemsTest` 10 expectations updated for the new flags): preview ==
Markdown body; preview of txt/srt/pdf; owner not set; date not given; neither → nobody named, no date; Unassigned
never printed; both present → no flag; normalised date / said-but-unnormalised date → not "No date given";
decision/question not asked for owner or date; Needs a look (and the machine's own flag on an unclassified row is
not it); Done by id, by old text hash, and surviving a hand correction; hand-typed item with nothing invented;
renamed owner on every format; PDF flag line amber+bold / done-only grey; credit absent everywhere when off and by
default; once, last, below the transcript in md/txt; exact line text; never in SRT or transcript; PDF credit is one
small grey last block; forced-transcript warning still leads and the credit still trails; corrected transcript under
the current name; no summary → exact minimal document; no sample banner; every format carries the same flags;
signature has no licence/allowance input.

Jest (`src/share/__tests__`, 26): `markers.test.ts` (segmenting; **the marker words equal the Kotlin constants**,
read from `ShareDocument.kt`), `SharePreviewScreen.test.tsx` (shows the native text line for line; asks for the
format it will share; four formats; flags styled apart; spoken "Done" not styled; sample banner absent; toggle off
by default / on writes `1`, previews the line once at the end, shares with it / starts on when remembered / SRT
never carries it / off writes `0`; failed preview still shareable), `ShareAvailability.test.tsx` (3),
`copyClaims.test.ts` (2). Server: `test_the_landing_page_makes_no_unmeasured_speed_claim`.

## Mutants (each made, a named test failed, restored; backups under the scratchpad `we/` directory)

| Mutant | Killed by |
|---|---|
| Owner-not-set flag dropped | `anActionWithNoOwnerSaysOwnerNotSet`, `unassignedIsNeverPrintedAsAnOwner`, +7 |
| No-date flag dropped | `anActionWithNoDateSaysNoDateGiven`, `everyFormatCarriesTheSameFlags`, +12 |
| Needs-a-look ignored | `anItemTheReviewQueueIsHoldingSaysNeedsALook` |
| Needs-a-look without the `item_type` condition | `theMachinesOwnFlagOnAnUnclassifiedRowIsNotNeedsALook` |
| Done ignored | `aTickedItemShowsAsDone`, `aDoneOnlyFlagIsGreyAndNotBold`, +2 |
| Old-hash ticks ignored | `aTickKeyedOnTheOldTextHashShowsAsDone`, `aCorrectedItemStaysDone` |
| Said-but-unnormalised date ignored | `aDateThatWasSaidIsNotNoDateGiven` |
| "— Unassigned" kept in the line | `unassignedIsNeverPrintedAsAnOwner`, +2 |
| Credit on by default | `theAttributionIsOffByDefault`, `thePdfWithoutItHasNoFooterBlock` |
| Credit added to SRT / to the copied transcript | `subtitlesAndTheCopiedTranscriptNeverCarryIt` |
| PDF credit first, not last | `thePdfAttributionIsASmallGreyLastBlock`, `theWarningLeadsAndTheAttributionTrails` |
| PDF credit twice | `thePdfAttributionIsASmallGreyLastBlock` |
| PDF credit 12 pt instead of 8 | `thePdfAttributionIsASmallGreyLastBlock` |
| Markdown credit above the content | `onTheAttributionIsOneLineAtTheEndOfMarkdownAndText`, `thePreviewIsTheMarkdownExportBody` |
| PDF preview = empty body | `thePdfPreviewIsTheWordsOnItsPages`, +2 |
| JS: Owner-not-set not in the unresolved list | `markers`/screen tests (3) |
| JS: shares with the toggle even for SRT | `subtitles never carry it` |
| JS: toggle not persisted | `turns on…remembers`, `turning it off writes 0` |
| JS: unresolved drawn as plain text | `draws what was not settled apart…` |
| JS: preview ignores the chosen format | 3 tests |
| JS: Share needs the preview / needs the allowance | `says so and still lets the person share` / availability tests |
| JS: bullet guard removed (spoken "Done" styled) | 4 tests |
| JS: preview text trimmed | `shows the native text, line for line` |
| Landing line gains "the moment it ends" | `copyClaims` and the server test |

Survivor, equivalent: initial `useState(true)` for the toggle — the first preview waits for the saved value, so the
initial state is never rendered into a request.

## Gate

`npx tsc --noEmit` clean. `src/share` jest 26/26; the new Kotlin tests pass; `:app:compileDebugAndroidTestKotlin`
clean. `GATE_STAGES="types js scans mutations kotlin" scripts/gate.sh`: **not green, for files I did not touch**,
retried once after two minutes:

* `mutations`: a Reconciler mutant is sitting uncommitted in the working tree
  (`Reconciler.kt`: `MIN_OVERLAP_MS = 2L` and the `n't` rule removed) — someone else's mutation run; 4 mutations
  "PATCH DID NOT APPLY".
* `kotlin`: 4 failures, all `ReconcilerTest` (same working-tree change).
* `js`: `MeetingScreen.test.tsx › progress inside a stage` fails while Workstream D has uncommitted edits in
  `src/screens/meeting/*`.
* `types` and `scans` passed.

## Repo note

Another agent's commit `84986da` (Workstream F) committed `src/navigation/RootNavigator.tsx` with my uncommitted
`Share` route and `SharePreviewScreen` import in it, so `84986da` alone does not compile (`src/share/…` arrived in
`0d7e760`). Together they are consistent. `RootStackParamList.Share = { meetingId: string }`.

## Decisions and open questions for the founder

* The preview and every file include the **whole transcript**, as the exports always did. There is no "minutes
  only" option; that would be a new format toggle. Say if you want one — the model (`Doc.turns`) makes it a small
  change.
* "No date given" means *no due date is recorded on the item*. A hand-corrected action that says "by Friday" in
  prose, without a `(due …)` tail, still reads "No date given". Free-text date reading was left out on purpose
  (it would be inventing).
* The old always-on credit pointed at `verbale.innocorelabs.com`; the new one carries no URL by design
  ("private meeting notes"). If you want the URL back it is one constant.

## DOCX: evaluated, not built

A DOCX export needs a real OOXML writer: a zip with `[Content_Types].xml`, `document.xml`, styles and numbering
parts, written natively (no Word library is in the app and the dependency would cost size and a licence check), a
mapping of `Doc` blocks to paragraph styles and list numbering, an escape pass for the XML, and a device-side
check in Word, Google Docs and LibreOffice — in practice about 300 lines of Kotlin plus a fixtures-based test, and
a FileProvider MIME entry. It is cheap *because* `ShareDocument.Doc` already holds the structure. The plan says to
build it only if target users need editable documents beyond Markdown/PDF/text; that is a question for people, not
code, so ask it in the interview round — the task script's share task is where: after they send the notes, ask
"what would you do if you wanted to change a line before it went out?" and "where would you open it?" before
showing any format list.

## Acquisition copy (software part)

Searched `src`, `android/app/src/main`, `server/app` for "the moment it ends" and its variants: **no in-app,
export or landing string says it**, so nothing was changed in app or `landing.py`; a jest scan and a server test now
fail if one is added. For the founder (store assets, not edited):

* `docs/store/tools/aso.py` line 20: caption "Plain English, the moment it ends." (screenshot 02, "Your meeting,
  written up"). Replace with a claim that is true on every phone, e.g. "Plain English, on your phone." and
  re-render screenshot 02.
* `docs/store/README.md` table row 02 repeats the headline; keep it in step.
* New screenshot candidate: the Share preview with "Owner not set" / "No date given" visible — it is the honest
  differentiator for the first campaign. Capture only after the device check below.
* Play listing text and the paywall/landing copy were not re-audited against the allowance numbers here (landing
  already states five meetings a month, up to an hour, and a test pins it).

## Device checks owed (nothing here was run on a phone)

* The system share sheet opens with each of the four formats and the file arrives with the right type and name;
  Share still works with the allowance at zero and with Pro lapsed.
* The PDF: amber flag line under a flagged item, the credit as a small grey line at the foot of the LAST page
  (and when the last page is nearly full: it flows to a new page, never over text), a long meeting paginating.
* Large text (font scale 200%): the Share screen's format picker labels, the credit row (text vs switch), the
  Share button, the preview scrolling; back button and TalkBack reading of the preview and the toggle.
* Preview speed on a one-hour transcript (about 500 `Text` lines in one `ScrollView`).
* First run after install: the saved toggle is read by native (`settings.shareAttribution`) for the Meeting
  screen's copy button.
