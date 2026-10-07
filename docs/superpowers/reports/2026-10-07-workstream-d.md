# Workstream D — Clearer results and navigation

Branch `dev/october-plan`, 7 Oct 2026. Eight commits, one per item. Nothing was run on a phone; every device claim is listed under "Device checks owed". I owned `src/screens/MeetingScreen.tsx` and `src/screens/meeting/` for this work.

Commits: 1 `7855786`, 2 `f056b3c`, 3 `59ea3c9`, 4 `2016d00`, 5 `4e49913`, 6 `5c6c092`, 7 `4ff793d`, 8 `5da090e`.

New screen-level tests live in `src/screens/__tests__/MeetingScreen.clarity.test.tsx` (one file, one setup, grown per item). Mutants were made with a runner that copies the file to a unique backup under the session scratchpad, applies one replacement, runs jest and restores; `git diff --stat` was checked clean of mutants after every batch.

## The plan says three tabs; the app has four

The brief's accessibility example reads "Minutes, tab 1 of 3". The meeting screen has **four** tabs (Summary, Minutes, Transcript, Actions), so the labels say "of 4": `Summary, tab 1 of 4`, `Minutes, tab 2 of 4`, `Transcript, tab 3 of 4`, `Actions, tab 4 of 4`. "selected" is carried by `accessibilityState.selected`, not repeated in the label (a label that also said "selected" would be announced twice). Whether TalkBack composes "Minutes, tab 2 of 4, selected" is a device check.

## 1. Labels (`7855786`)

- `src/screens/meeting/meetingTabs.ts` (new): `MEETING_TABS` = Summary / **Minutes** / **Transcript** / Actions. Keys unchanged (`summary`, `mom`, `transcript`, `actions`) because Search, Ask, the Summary strip and notifications open a meeting on them. `tabKey()` also accepts `'minutes'` as an alias for `'mom'`. Nothing persists a tab name, so no stored value needed an alias.
- Grep of `src/`, `android/app/src/main/java` for user-visible "MOM"/"Script": the only visible strings were the two tab labels. Export headings, Library badges/subtitles and hints never said MOM or Script (internal comments still do; left alone). No export golden pinned the old words.
- Tests changed: `MeetingScreen.test.tsx`, `ItemProvenance.test.tsx` (label lookups). Added `meetingTabs.test.ts` (3), two cases in the clarity file.
- Mutants killed: label back to `MOM`; alias removed.

## 2. Takeaway, then decisions and next steps (`f056b3c`, plus the Done-fold preview in `5c6c092`)

- `src/screens/meeting/takeaway.ts` (new, pure): `takeawayOf` = the writer's `headline` minute when present; otherwise the rule lead built by the existing `composeSummary` over the current decisions ("Decided: …"), or, with no decisions, over the next steps (owned first, owner suffix removed: "Next: …"); the closing tally sentence is stripped, so **never a count**; null when the rules found nothing. Clipped to 220 characters on a word boundary. `previewOf`, `oneLine`, `cardPreview`.
- Minutes tab order: takeaway (heading) → "Ask this meeting" entry (item 3) → **Decisions · N** → **Next steps · N** → **Questions · N** → **Written minutes** (the writer's prose with Edit and Copy, as before; the "no written minutes" explanation now says "above") → Export.
- Next steps show owner, due, and a ticked state in words and an icon ("Done", read once per opening from `db.doneItems` / `db.doneActions`, keyed as the Actions tab keys it). An action with no owner reads **"No owner yet"** (quiet ink); no due date prints nothing. The Actions tab says the same for an unticked action with no owner, and its folded "DONE · N" row shows the first finished item.
- Counts with a preview: the Summary tab's strip of three tiles became three full-width rows, order Decisions, Next steps, Open questions: `Decisions · 3` with the first item's text on one line beneath.
- Library cards: `src/db/cardPreviews.ts` (new) reads, in one query, each finished meeting's first decision and first action; `src/state/libraryStore.ts` `refresh` puts `cardPreview(...)` into `summaryLine` for a **finished** meeting that has none ("Decided: …", else "Next: …"). The writer's headline is never replaced, so `LibraryScreen.tsx` needed **no edit**: its existing subtitle line shows it. It still wraps to two lines there (the card's own `numberOfLines={2}`); one line would be a one-token change in LibraryScreen (`numberOfLines={1}` on the `subtitleOf` Txt, ~line 485), left for whoever owns that file.
- No tab badge exists on the tab bar today; none was added. Not done: a count badge with a preview.
- Tests: `takeaway.test.ts` (13), `cardPreviews.test.ts` (7, real SQL against the real DDL via `node:sqlite`), clarity cases (headline, order, no count, "No owner yet", Done, source links on every item, Summary previews, folded Done).
- Mutants killed (10 + 1): headline ignored; tally kept; unowned-first; no owner note; no done mark; no glance preview; library replaces headline; library ignores status; SQL order dropped; SQL rejected filter dropped; fold preview off.
- Known limit: the Library preview reads `items.text`, not the corrections overlay, and does not resolve a renamed owner (the preview strips the owner anyway).

## 3. Ask is discoverable and labelled (`59ea3c9`)

- Before: an icon-only header button and an overflow row, both straight to `AskScreen`; a Free person's first question opened the paywall from inside the screen.
- Now one handler (`onAsk`) behind the header icon, the overflow row and a **labelled entry** (`AskEntry`, "Ask this meeting" with "Answers from the transcript, with the moment each came from") on the Minutes tab (right after the takeaway) and the Summary tab. A small "Pro" mark appears for Free.
- `askAccess.ts` (pure) decides from `entitlement().paid` and `ModelManager.list()` through the existing `writerBlockedReason` (the same source the paywall uses):
  - Pro, capable phone, or not yet known: goes to Ask (an unknown state never blocks).
  - Free, capable: dialog "Ask this meeting" / "Ask answers a question about this meeting from its transcript, and shows the moment each answer came from. When nothing in the meeting settles it, it says so. It runs on your phone and is part of Pro. Everything else in this meeting stays free." Buttons **Not now**, **Upgrade to Pro** (opens the paywall).
  - Free, phone cannot run the writer: the same plus the native reason, "Ask cannot answer on this phone, so Pro would not add it here. What Pro does give this phone: More meetings, any length; Search by meaning; Voices it remembers; One thread across meetings; Every action in one list." Buttons Not now, Upgrade to Pro. A test reads `PaywallScreen.tsx` and fails if any listed title is not a paywall row, and if a writer-dependent row is listed.
  - Pro on such a phone: the reason, "Ask cannot answer on this phone. Search by meaning still finds what was said." Button OK only.
- Source-audio links are untouched and asserted on every cited item (5 of 5).
- Tests: `askAccess.test.ts` (9), clarity ×7. Mutants killed (10): weak phone promises Ask; Pro-weak is sold Pro; Free loses its Upgrade; weak copy drops the feature list; unknown blocks; header and overflow bypass the handler; entry missing on Minutes and on Summary; no Pro mark.

## 4. "Write it again" is secondary (`2016d00`)

- A new `QuietAction` (underlined text, 44 dp minimum height, hint "Writes the summary again from the transcript. The current one stays until the new one is ready.") replaces the full-width `SoftButton`, below the summary and the F15 / F24 notices, so the stale notice still sits directly above the action it points at. While a rewrite runs it reads "Working…" and is disabled. "Write the summary" (no summary yet) stays a `SoftButton`: it is the point of the card.
- **No confirm existed** for "Write it again" before this work (the brief says it "keeps its confirm"): the rewrite keeps the old summary until the new one replaces it, so none was added. The type-change sheet's existing confirm is unchanged. Tell me if you want a confirm.
- Tests: `SummaryTab.quiet.test.tsx` (7). Mutants killed: still a button, onPress dead, 30 dp target, not disabled while writing.

## 5. Visible editing (`4e49913`)

- `EditButton` (pencil, 44 × 44, raw dp not scaled): "Edit this action" / "Edit this decision" / "Edit this question" on every Minutes row and every Actions row (decisions and questions on the Actions tab previously had no edit at all); "Edit this line" on every transcript line (also in a dictation and with no audio). All open the same `TextPrompt` the long press opens: the transcript line's "Correct the words" and the visible control are one function (`onCorrectLine`).
- The transcript header gains **Rename speakers** (opens the Speakers screen; absent for a dictation). The speaker name at the head of a turn still means "change who said this turn"; renaming a person is on the Speakers screen.
- Row structure: the control is a sibling beside the row's words, not inside the long-press or checkbox element, because a screen reader merges everything inside an accessible element into one stop.
- Tests: clarity ×6, `TranscriptTab.test.tsx` ×8. Mutants killed (11): control missing/dead/small on each tab, wrong text handed over, Rename always shown, screen handler or navigation dead, Edit also ticks.

## 6. Quieter reading surfaces (`5c6c092`)

- Minutes, Actions, Transcript and Summary no longer draw a raised card per item. `FlatPanel` (theme `card` colour, hairline border) holds rows separated by `Hairline` / `Rows`; the Transcript is flat turns with hairlines (the playing turn keeps its `primarySoft` tint and the volume mark). The Summary hero card is a flat `primarySoft` panel with brand-coloured labels, ink text; the Highlights are rows in a panel. The mascot, the raised buttons and controls, the **SAMPLE** banner and the review-queue and voices banners are unchanged.
- Colour: only theme tokens; the two literals that were in these files (`#FFFFFF`, `rgba(255,255,255,0.18)`) are gone.
- Tests: `quietSurfaces.test.tsx` (14): `Raised` count does not grow with items on Minutes and Actions, is 0 per turn on the Transcript; a grep test that none of ten files writes a hex or `rgba(` literal; only `SummaryTab` still imports `Raised`, exactly twice (the two banners). Mutants killed: Raised per item on Minutes and Actions, hex literal, rgba literal. A mutant that put `Raised` back around a transcript turn did not compile (my mutation text); the transcript is covered by the count test and the import grep.

## 7. Accessibility (`4ff793d`)

- `TabBar.tsx` (own component, not the shared `Segmented`): `tablist`, each `tab` labelled "Minutes, tab 2 of 4", `selected` state, minimum 44 dp, no fixed height, wraps at large text instead of an ellipsis.
- Heading role (`Heading.tsx`): takeaway, `Decisions · N` / `Next steps · N` / `Questions · N` / `Written minutes`, `SectionHead` labels, "SUMMARY".
- Next-step rows, label `<text>. Owner <name>. Due <date>. Not done` (`Done` when ticked; `No owner yet.` for none; the due part omitted when none): Actions tab as a `checkbox` with `checked` state, Minutes tab as the row's label.
- Player: Play/Pause keeps its labels, now 44 dp; the position slider declares its `increment` / `decrement` actions (they were handled but never declared, so a screen reader would not list them) and carries a value in words ("01:05 of 10:00"); times use `inkSoft`.
- Reading order pinned: title, takeaway, Decisions, Next steps, Questions; the Ask entry after the takeaway. No information by colour alone: owner and due are text with icons, done is the word "Done" plus a check and the checkbox state, the playing turn has the volume mark.
- Tests: `a11yLabels.test.ts` (6), `PlayerBar.test.tsx` (3), clarity ×9. Mutants killed (18): tab label, selected state, height, tablist, heading role (×4 sites), owner/due/state in the label, checkbox state, label text-only on both tabs, player actions, size, value, Summary heading, Ask order.
- Not covered: **large text** (font scale 2.0), **dark mode** rendering and **small-viewport** behaviour have no automated check here beyond "tokens only" and "no fixed heights on text containers in the new components".

## 8. Sample cleanup (`5da090e`)

- `loadActions()` (`src/screens/actionsData.ts`) drops rows whose meeting id has the sample prefix (`isSampleId`) before resolving ticks and names. Both the Pro worklist (`ActionsScreen`, its "Across N meetings" header) and the Library's open-actions card read that list. `LibraryScreen` already filtered the sample on its own count (another session's change); the source filter makes that redundant, not wrong. The SQL (`db.allActions`) is unchanged, so Search's "meetings with actions" filter and the sample's own Actions tab are unaffected (the sample stays searchable, as Workstream C specified).
- Tests: `actionsData.test.ts` ×3 (worklist, tally, a real id that merely contains "sample" is kept), `ActionsScreen.test.tsx` ×1. Mutants killed: no filter; `includes('sample')`; match on title.

## Verification

- `npx tsc --noEmit`: clean at the end.
- `npx jest src/screens --silent --forceExit`: 59 suites, 611 tests, all pass (one unrelated timing flake in `MeetingScreen.test` "shows the running stage's own counts" appeared once under load and not in four re-runs).
- Gate: see the section "Gate" below (types, js, scans pass; mutations fails in a file I did not touch).

## Gate

`GATE_STAGES="types js scans mutations kotlin" scripts/gate.sh`, run twice (second run after the 2-minute wait):

- `types`, `js` (119 suites, 1,203 tests, all pass), `scans` (network egress OK, prompt fencing OK, diarization constants OK): pass both times.
- `mutations`: **failed both times, in `scripts/mutate-reconciler.py` over `Reconciler.kt`, a file I did not touch** and that carries another session's uncommitted change. Run 1: four Reconciler patches reported "PATCH DID NOT APPLY (0 matches) — re-point it" (touching-anchors, one-millisecond-overlap, the n't contraction rule, contraction canonicalisation) and "4 of 33 mutations were not caught". Run 2: the script died with `FileNotFoundError` on `android/app/build/test-results/testDebugUnitTest/TEST-…Reconcile…xml` (a concurrent Gradle run by another session removing the results directory). The `kotlin` stage was therefore not reached. Not investigated, per the brief.

## Device checks owed (none run)

- TalkBack: tab bar ("Minutes, tab 2 of 4, selected"), next-step rows as checkboxes (label read, the Edit button reached as its own stop beside it, the moment link reached as its own stop), headings navigation, the position slider's increment/decrement menu, the Ask entry.
- Large text (font scale up to 200%) on the tab bar (wrapping onto two lines), the Ask entry, the Summary count rows, the Minutes sections, the transcript header (Rename speakers + Copy wrapping), `QuietAction`.
- Dark mode of the flat panels, hairlines (`line` on `card`), the flat Summary hero (`primarySoft`), the playing-turn tint, the "Pro" mark and quiet "No owner yet" ink (`inkDim`) contrast.
- A 384 × 853 dp screen and a short screen: the Minutes tab with a long takeaway; the transcript header at large text.
- Touch targets measured by hand: `EditButton`, `QuietAction`, tabs, play button, Ask entry. (`IconButton` in `components/ui.tsx` is 40 dp scaled and was not changed: not my file.)
- That Free's Ask dialog and the weak-phone dialog read correctly on a real low-memory phone (the writer-blocked reason comes from `ModelManager.list()` and is only fixture-tested).
- Library card line on a real finished Free meeting (reads from SQL tested only against `node:sqlite`).

## Not done / worth knowing

- No tab count badge with a preview (there is no badge today).
- Library card preview wraps to two lines (see item 2); no `LibraryScreen.tsx` edit was made.
- Low-contrast `inkFaint` text elsewhere in the meeting screen (e.g. `EditedTag`, the subtitle under the title) was left as it was; only the changed surfaces were moved to `inkSoft` / `inkDim`.
- The Summary tab still opens with its banners and highlights above the summary card; only the Minutes tab's reading order was made takeaway-first.
- `MeetingScreen.tsx` carries none of the Share (E) or Add-to-project (F) hooks; those sessions' reports name the overflow-sheet hooks to add.
- A file-name trap, for whoever adds components here: `meetingTabs.ts` and a component named `MeetingTabs.tsx` resolve to the same import on a case-insensitive filesystem; the component is `TabBar.tsx`.
