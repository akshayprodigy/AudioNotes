# Workstream F — Retention through follow-up (software part)

Branch `dev/october-plan`, 7 Oct 2026. Three commits, one per item (follow-up home `84986da`, streak, Add to project `6d120ac`; the streak commit sits between them). Nothing was run on a phone; every device claim is under "Device checks owed".

## What was built

### 1. Follow-up home (Pro)
The Library's open-actions card became one **Follow-up** card (`src/screens/FollowUpCard.tsx`). Its first line is still the old "N open actions across M meetings" (accessibility label `Open actions`, opens Actions). Under it are up to three quiet rows, each a title, a count and a one-line preview of the first item, each opening a filtered list (`src/screens/FollowUpScreen.tsx`, new route `FollowUp: { kind: 'due' | 'decisions' | 'review' }`).

* **Pro only.** The card is drawn only when `paid`; a Free user sees nothing new and no upsell from it (the "Actions (Pro)" header button is unchanged). `FollowUpScreen` also sends Free to the Paywall on mount, like `ActionsScreen`.
* A row with a zero count is not drawn, and the card is not drawn when every count is zero ("0 decisions" is a nag; the old card was already hidden at zero).
* **Counts exclude archived meetings** (in the SQL, `mt.archived_at IS NULL`) **and the sample meeting** (the `sample-` prefix rule, in the pure helpers, and in the Library's own tally as before). Rejected items are excluded in SQL.
* Pure helpers in `src/screens/followUpData.ts`; `today` is injected (`dayStart(nowMs)` builds the `date_norm` shape: the phone's calendar day as UTC midnight), never read inside a helper. Only `loadFollowUp(nowMs = Date.now(), actions?)` touches the clock/DB. The Library passes the rows it already loaded, so the follow-up lists and the open-actions count come from one read.

#### The exact status and date choices
* **Due or overdue actions:** an action that is **not ticked** and whose `items.date_norm` is **not null and `<= today`** (today's local day). `date_norm` is the evidence layer's normalised day. An action with only a phrase that did not normalise ("before Wednesday" — `DateNorm` deliberately leaves it null) is **not** counted overdue and appears in no bucket; an item the classifier never read has `date_norm` null and is likewise absent. `0` is treated as a real day, not "none". Order: most overdue first, then newest meeting.
* **Decisions still open:** `items.status` in **`open` and `qualified`**. **`contradicted` and `withdrawn` are treated as settled** (the decision is no longer live). **A decision with `status` null (never read by the Pro classifier; every Free decision and any a person typed) is NOT counted** — saying "open" would be a guess. Exported as `UNRESOLVED_DECISION_STATUSES`.
* **Notes to review:** meetings with at least one item where `review = 'needs_review'` **and** `item_type IS NOT NULL` — the same predicate `ReviewScreen` and the Summary tab use, so the count and the queue cannot disagree. The count is **meetings**, the preview is the first waiting item. Tapping the row goes **straight to `Review { meetingId }` when exactly one meeting is waiting**, otherwise to the `FollowUp` review list, whose rows each open that meeting's review queue.
* **Opening an item:** every due-action and decision row navigates `Meeting { meetingId, tab: 'transcript', atMs, play: true }` (Trust A's route; `atMs = 0` is a real moment). A hand-typed item has no moment (`anchorStartMs` null, derived in SQL as `db.items` does) and opens the Actions tab as `ActionsScreen` does.
* **Ticking in place:** the checkbox on a due row calls `db.setItemDone(meetingId, id, next)`, the same `item_done` write the Actions screen and the meeting's own tab use; optimistic; the row stays (struck through) so a mis-tap can be undone, and drops out on the next focus. Completion state is preserved because nothing new stores it.

New SQL (all in `src/db/queries.ts`; only these were touched): `allActions` now also selects `i.date_norm AS dateNorm`; new `db.allDecisions()` and `db.reviewItems()`. New types: `ActionRow.dateNorm?`, `DecisionRow`, `ReviewItemRow` in `src/pipeline/types.ts`. New route in `RootNavigator.tsx`.

### 2. Capture streak made quiet
The gradient flame banner (primary fill, progress bar, five dots) is gone. It is now one line, **below the Follow-up card** and above the meeting list: a small muted flame and `Recorded N days in a row`, in `inkFaint`, shown for a run of two or more days (Free too, since Free has no card). No "keep your streak" or loss wording, never an alert colour. `captureStreak()` and its data are untouched; the sample still does not count.

### 3. Add to project
`src/projects/` (`projects.ts` pure rules, `AddToProjectSheet.tsx`). A bottom sheet titled **Add to project** with the line "A project groups meetings so you can see decisions and open actions together." For **Pro**: "YOUR PROJECTS" (existing tags from `db.allTags()`, most used first, with meeting counts; one this meeting is already in shows a tick and is disabled), a "Project name" field, and a button that reads `Create “name”` for a new name or `Add to “name”` when it matches a project that exists (names go through the existing `normaliseTag`). Applying is `db.addTag(meetingId, name)`, the existing tag helper; no new storage. A failed write keeps the sheet and the typed text and says "Could not save that. Try again." For **Free**: "Projects are part of Pro", the explanation, a note that tags still work ("Add a tag" in the meeting's menu), an **Upgrade to Pro** button (closes the sheet and opens the Paywall) and Not now. While entitlement is being read nothing is drawn, so Pro never sees the upsell flash. Free tags are unchanged; the thread view stays Pro.

Reachable from the **Library long-press menu** ("Add to project", first row; not on the recording or sample meeting menus), which refreshes the library after a pick.

## The hook the Meeting screen needs (not applied; MeetingScreen was not edited)
In `src/screens/MeetingScreen.tsx`, three lines:

```tsx
import { useAddToProject } from '../projects/AddToProjectSheet';
// near the other hooks:
const project = useAddToProject(meetingId, {
  meetingTitle: meeting?.title,
  onUpgrade: () => navigation.navigate('Paywall'),
  onChanged: () => db.tagsFor(meetingId).then(setTags).catch(() => {}),
});
// in sheetActions, beside the 'Add a tag' entry:   project.action,
// anywhere in the returned tree (next to the TextPrompts):   {project.sheet}
```
`project.action` is a ready `SheetAction` (`plus` icon, label "Add to project", the same hint as the Library). `onChanged` refreshes the tag chips the screen already shows.

## Tests (all pass)
* `src/screens/__tests__/followUpData.test.ts` (17): due/overdue boundaries, tomorrow, ticked, null/unnormalised phrase, undefined, 0, sample, injected day, order; decision statuses; review grouping; preview.
* `src/db/__tests__/followUpQueries.test.ts` (6, real SQL in `node:sqlite`): date_norm on the worklist, decisions (archived, rejected, typed anchor), review queue (unread, archived).
* `LibraryFollowUp.test.tsx` (8): card rows/counts/previews, absent for Free, zero rows, not counted cases, sample, each row's navigation, single-meeting review shortcut. `LibraryStreak.test.tsx` (5): order (follow-up before streak, streak above the meeting list), Free still sees it, no urgency/loss strings, never an alert colour, data kept. `FollowUpScreen.test.tsx` (10): lists, moment navigation (incl. typed and 0 ms), in-place tick, ticked absent, Free to paywall, decisions, review. `LibraryProject.test.tsx` (4): menu entry, open + apply + refresh, Free state with working upgrade, sample has no entry. `LibrarySample.test.tsx`: the streak assertion now matches the new wording (the old regex would have gone vacuous).
* `src/projects/__tests__/projects.test.ts` (6), `AddToProjectSheet.test.tsx` (14): list, applied-disabled, apply, create (normalised, button and keyboard), exists says Add, empty, failure keeps the sheet, none yet, Free state and upgrade, no flash, hidden reads nothing, the hook.

## Mutants (each broken, a named test failed, restored; file hash checked after each)
Follow-up data: due `<=` to `<`; ticked counted; null date guessed as due; sample counted (due, decisions, review); order reversed; contradicted counted; withdrawn counted; qualified dropped; null status counted; review count not incremented. SQL: archived dropped (decisions, review); rejected dropped; unread review items included; `date_norm` not selected; typed decision given an anchor. Library: card shown to Free; review always a list; zero rows shown; card with all zero; wrong list kind; sample in the tally; streak before the card; urgent streak copy; alert colour; threshold 1; hidden for Free. Screen: wrong tick value; not optimistic; no `play`; 0 ms treated as none; no Pro gate; wrong review route; always "Due today" (first run SURVIVED; assertion tightened, then killed); count fixed at 1. Sheet: unnormalised name (button and keyboard — keyboard first SURVIVED, test added, killed); Free gets the list; applied row not disabled; no `onChanged`; failure closes; upgrade does not navigate; "Create" for existing; sample gets the entry; no refresh; no paywall; wrong meeting id; explainer removed; wrong tag written.
**Equivalent, survived:** `dayStart` using UTC getters is indistinguishable in a UTC-offset-zero or +5:30 sort of zone for the noon/23:59 probes — it is killed under `TZ=America/Los_Angeles` (the machine is IST); `disabled={!typedPlan || busy}` without `!typedPlan` (the press handler also guards, so behaviour is identical); the sheet's initial `paid` state (reset to null in the effect before first paint of anything visible).

## Verification
`npx tsc --noEmit` clean; `npx jest src/screens src/db src/projects` passes for everything I touched. Gate `types js scans`: pass (116 suites, 1166 tests). Gate `mutations` failed on its first run in `scripts/mutate-reconciler.py` (`TEST-...ReconcilerTest.xml` not found): `Reconciler.kt` and its Kotlin tests were being edited by another session at the time and I touched no Kotlin. A retry after two minutes was started; see the final message for its outcome.

## Reminders — not built (a paragraph for later)
A local, opt-in reminder should wait until core usage is established and must not be advertised before it delivers. It would need: a Settings toggle (default off, Pro only), with the system notification permission asked only when the person switches it on and the benefit is on screen ("remind me about actions that are due"), so a refusal costs nothing and is respected by never asking again from the Library; Android 13+ `POST_NOTIFICATIONS` runtime permission and a dedicated low-importance "Reminders" channel separate from the recording and "Notes ready" channels; scheduling with `AlarmManager.setAndAllowWhileIdle` (inexact is fine) or a daily `WorkManager` job at a time they choose, re-armed on boot and on app update, cancelled when the toggle goes off or Pro lapses, and skipped when there is nothing due; the content built on the phone from the same `date_norm` due rule (a digest such as "3 actions due today"), with the **text kept generic on the lock screen** (counts, not sentences, unless they opt into previews) and never sent anywhere, since nothing leaves the phone by design; and one-tap landing on the `FollowUp` due list. No server, no tracking, no content in analytics.

## Device checks owed (none run)
* The Follow-up card on the Library on a phone with real Pro data: counts match the Actions screen; tapping each row; the single-meeting review shortcut lands on the right queue.
* A due action's row opens the transcript at the moment and plays; ticking it there shows ticked in the meeting's Actions tab and in Actions.
* The quiet streak line in light and dark, at large text, and under a Free account.
* The Add to project sheet with the keyboard up on the A07 (the sheet uses `behavior="padding"` in a Modal; untested on Android 15 edge-to-edge), the Upgrade path from Free, and the new tag appearing as a Library filter chip and a Thread.
* Screen reader pass for the Follow-up card rows and the sheet.
