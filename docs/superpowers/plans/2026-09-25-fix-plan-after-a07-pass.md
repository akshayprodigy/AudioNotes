# Fix plan — Phase B plus everything the A07 pass found

*25 September 2026. Sources: the Tier 1 list (`2026-09-24-tier-1-fixes.md`, Phase B = B1–B6), the
Phase B sheet (`specs/2026-09-25-phase-b-nothing-lost-nothing-false-execution.md`), and the device
report (`reports/2026-09-25-a07-play-build-feature-pass.md`, defects 1–13 + "lower"). Each item
below names where it is fixed. Same process as Phase A: Opus writes an execution sheet, Sonnet
builds, Opus reviews against the code, then a device pass — this time the automated A07 pass is
re-run, not only the founder's by-hand list.*

## The order, and why

| # | Work | Who | Size | Why here |
|---|---|---|---|---|
| 1 | **Hotfix H1** — a lapsed subscription stops being Pro | Opus, directly | 1 file + test | Revenue leak and a false "Pro"; three lines; blocks the lapse check |
| 2 | **Ops H2** — put `bge-small-en-v1.5-q8_0.gguf` on the model mirror | Opus, on the server (founder's yes) | minutes | Every Pro user takes a 404 before the fallback |
| 3 | **Phase B** — the existing sheet, amended with B7 | Sonnet, 2 sessions | as sheeted | Nothing lost, nothing false; B2 and B4 are confirmed on the phone |
| 4 | **Phase C** — the device-pass defects | Opus sheet → Sonnet, 2 sessions | medium | After B: shares `RecordScreen.tsx` and `RecordingService.kt` with it |
| 5 | **Phase D** — quality research (the writer, ASR edges) | Opus measures first | open-ended | Needs measurement before any code; must not block the release |
| 6 | Re-run the automated A07 pass, bump to 1.0.4, AAB | Opus | ~2 h | Proves B + C on the phone before the upload |

Phase D does not gate the 1.0.4 upload; H1, B and C do.

## 1. Hotfix H1 — lapsed means lapsed (defect 2)

`src/billing/subscription.ts:135` — `if (!res.token) return null;` keeps the old token when the
server answers 200 with `token: null`. Fix: on a 200 with no token, `await Licence.clear()` (exists
in `NativeLicence`), so `Licence.status()` reads lapsed at once and the Summary shows *Check again*
and *Manage in Google Play*. A network failure or 5xx still keeps the token (offline grace is the
point of the token). Test in `playPurchase.test.ts`: refresh → `{token: null}` → `Licence.clear`
called; refresh → network error → not called. Mutant: delete the clear.

## 2. Ops H2 — the mirror

Re-run `mirror-models.sh` for the missing embedder; check `curl -I` on the URL returns 200 and the
SHA matches the catalog. No app change.

## 3. Phase B — as sheeted, plus B7

Already written (B1–B6, Steps 1–10). Two device findings are the same defects the sheet fixes:
defect 4 (the Free limit is not processed, notice says "being transcribed") = **B2**; defect 5
(unheard announcement reported nowhere) = **B4**.

**Amendment — B7, the clip leaking into the transcript (defect 3).** Same thread the B4 step edits
(`RecordingService.kt` 350–388): the lag is stored only when the clip is HEARD, so a clip that was
found but too quiet is transcribed ("recorded by Verbali…", and the meeting is titled with it).
Rule: **exclusion keys on `found`; the `announced_at` stamp keys on `heard`.** New
`AudioDb.setAnnouncedLag(id, lag)` written whenever the verifier found the clip; `markAnnounced`
unchanged. Goes into Session B1 as a new step after Step 4.

## 4. Phase C — the rest of the device pass

**Session C1 — the record screen, the limit, the owners**

- **C1.1 Record screen layout under the Free-limit card (defect 1).** The card must never push the
  Stop button off screen. Decided shape: during the warning the card REPLACES the mascot (same
  slot, no extra height) and the stage scrolls if it still does not fit; the "Keep recording —
  7 days free" button stays inside the card. Test at the A07's 384×853 dp.
- **C1.2 The limit stops at 15:00, not 15:15.** Check the cap on the ~1 s warning cadence, not the
  ~32 s disk cadence (`RecordingService.kt` 446–463); the entitlement read stays on the slow one.
- **C1.3 Speaker names are live everywhere (defect 6).** Render an action's owner from
  `owner_json` → the meeting's current speaker name, not the " — Speaker 1" suffix baked into the
  text: Actions tab, MOM, the Actions worklist, Threads, search rows (which also stop showing
  "— Unassigned"). The stored text is left alone (exports keep working).
- **C1.4 A transcript correction reaches the items built from that line** (defect 12, last part):
  after a line edit, re-run the rule pass for that meeting (`db.ensureItems` path), keeping ticks
  and hand-typed items (Reconciler already does).

**Session C2 — Pro surfaces and extraction**

- **C2.1 Settings model rows finish (defect 8):** a completed download flips the row to installed
  without leaving the screen; the "· 100%" label stops clipping.
- **C2.2 Ask cites the moment (defect 10):** a citation resolves to the transcript line it came
  from (play-from time), never "Minutes · 0:00"; an answer sentence with no cite is dropped.
- **C2.3 Meaning search has a floor (defect 11):** ≈ matches below a measured similarity are not
  shown or counted. **Opus measures the threshold on the bench meetings before the sheet** (the
  memory rule: model numbers are measured, never guessed).
- **C2.4 Extractor, from what whisper actually wrote (defect 12):** "Let's start/begin…" is not an
  action; "<Name> will <verb>" is an action for any verb when a date or object follows; "before
  <day>" is a due date. TS + C++ + goldens, and each cue recorded through the phone first (the
  22 Sep rule).
- **C2.5 Copy and small UI:** a dictation is titled "… dictation", not "… meeting"; the Free summary
  card stops saying "processed before summaries were written"; the meeting overflow sheet shows
  that it scrolls (Archive/Delete are below the fold).

## 5. Phase D — quality research (measure first, then decide)

- **D1 The writer states wrong facts (defect 9):** "$499/month" for four ninety-nine; a promised
  report written as sent; an invented earlier schedule. Candidate: a post-check that every number,
  currency and date in the summary appears in the transcript, and future-tense items stay future —
  drop or flag the sentence otherwise. Measure on the eval set before choosing.
- **D2 "comma" heard as "Kama"** in dictation; **D3 the first line lost on mic recordings** (not
  explained yet — needs a phone recording with the clip, compared against the imported file).

## 6. The founder's, not code

- **Play Console prices:** ₹300 / ₹2,500 are live; the decided prices are ₹299 / ₹2,499.
- **Play Console subscription benefits:** remove "MP3" (there is no MP3 export) and do not list
  export as Pro (it is free).
- **Phase A §7 steps 2–4, 7** (offline payment, slow card, restore after clearing data, reinstall
  ×3) need a phone with no real meetings on it — the A07 now holds the IPD meeting. Either a second
  phone, or back that meeting up (Settings → Back up) and accept the wipe.
- Push when ready (31+ commits unpushed).

## Done means

H1 + H2 + Phase B + Phase C built, reviewed, the automated A07 pass re-run with no open defect from
this list, 1.0.4 uploaded to internal testing. Phase D reported with measurements and a decision.
