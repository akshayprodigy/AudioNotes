# 22 September 2026 — the A07 session: Layer 1 driven over adb

*Galaxy A07 (SM-A075F, arm64, Android 16, 3.6 GB), release builds, driven entirely over adb with
speech from the Mac (`say`, and the whisper.cpp `jfk.wav` for a real human voice). Every claim
below is from the phone or its log, not from a report. Trial used for the Pro half; the phone is
Free again at the end, with all seven models on it and eleven bench meetings.*

## 1. What passed, by phase (the §7 steps, run here so they no longer wait on a person)

**Phase 5 — vocabulary and dictation.** All eight steps. Dictation persists across a kill; the
switch is dimmed while recording; the header, chip, "one voice" and library card all say
Dictation; marks fire when whisper hears them ("new paragraph" and "question mark" every time,
"full stop" once in two, "comma" never — whisper-base on a synthetic voice through a phone mic; your
own voice is the real test); a one-word correction offers a rule and the rule applies; a rewrite
offers none; Settings › Vocabulary lists, adds, changes, removes; Free never sees a rule.

**Phase 2 — templates.** Steps 1–4 and 6: the type sheet's seven rows; a stand-up transcript
suggested *Stand-up* on its own and the MOM carried *Done since last time / Planned next /
Blockers*; choosing *Client call* on the trial rewrote it in the client shape; on Free the chip
relabels without reprocessing. Step 5 (the tag remembering the type) failed as written and is
fixed — see §2.

**Phase 3 — thread memory.** Steps 1–7: "ops · 3" in the filter row; a tick strikes the action;
*Still open* holds only the unticked action; *Decisions so far* oldest first; *Meetings* newest
first; the Summary line "ops: 1 open · 1 decision" excludes the meeting's own rows and opens the
thread; on Free the thread icon and the header's Actions both open the paywall, the line is gone,
and tagging still works. One gap outside the phase: the middle decision ("Shipping moved to
Thursday because QA is not done") was never extracted — the rule set has no cue for a schedule
change without "decided/agreed", so the `changes:` link could not appear. Listed in §4.

**Phase 4 — remembered voices.** Steps 1, 2, 4, 6, 7, with a real voice: the switch and its
consent text; "Sounds like Jack — confirm?" on the Summary and the Speakers row, Yes names the row;
Forget empties `people`; on Free the row reads "(Pro)" with no switch and Forget stays. **The
number behind it** (a probe line added today): the same real voice, twice through the Mac's speaker
and the phone's mic, matches itself at **0.991** against a 0.65 threshold; a synthesised voice does
not match itself (0.21–0.27) and is no test of this feature; strangers sit at 0.16–0.28. Step 3's
one-time card needs a phone where the switch was never touched (next fresh install); step 5 needs
a second real voice — yours and a colleague's.

**Phase 5b — device fit.** Only the positive path is reachable on a 4 GB phone: onboarding shows
no refusal, the Pro note reads "downloads 1344 MB more". The disk sentence and the 2 GB sentence
were shown on the tablet on 21 Sep; the processor sentence needs an A53/A73 phone.

**Phase 6b-S1 §7.** Fresh install → *Download (96 MB)* → four files from the mirror (ledger: 4
calls, 0 bytes sent, 96.3 MB received, all `verbale.innocorelabs.com`) → no runtime row in
Settings; crash consent came up off.

**Ask, the three spot-checks.** The fixed build answers with a citation chip that plays the
moment ("We will ship on Monday if the listen server is fixed by Friday… [4]"); Ask during
narration shows "The writer is busy with a meeting — try again in a minute."; Ask on Free opens the
paywall, which says "That was the 3 trial summaries. Everything they wrote is still in your
library."

**The device suite**, earlier in the day: 15 classes, 99 tests, 0 failures, 0 skips, with every
model present and the ONNX runtime from the APK.

## 2. Defects found and fixed today (all committed, none pushed)

| Commit | What the phone showed | The cause | The fix |
|---|---|---|---|
| `0d9910e` | Every intrinsic-width label lost its last word — "Try Pro free for 7", "up to 15 min on", "Co(py)", "When will we" — on this phone and, since 16 Sep, the Pixel | **Android 15** sizes a TextView by visual glyph bounds (`useBoundsForWidth`); React Native measures by advance width and never adopted the bounds (facebook/react-native#53286, PRs unmerged). Nunito's trailing "y", "p", "?" overhang, so it looked intermittent | One theme item in `values-v35`: `useBoundsForWidth=false` on the theme's `textViewStyle`, which every `ReactTextView` reads. Verified on the same stored string that clipped. The per-label `flex: 1` workarounds are no longer needed |
| `8383104` | A 12-second note came back titled "This meeting is being recorded by Verbal…" with its one sentence gone — the 14 Sep failure, back | The announcement verifier waited for a 12 s prefix and stamped `announced_lag_ms` on its own thread; the finish path handed the meeting to processing the moment the capture thread was joined. Under ~13 s the verifier either never ran or lost the race, nothing was excluded, the clip was transcribed and whisper dropped what followed | The latch is released on stop (the verifier checks the prefix it has — the clip is at the start) and the finish path joins the verifier for up to 2.5 s before the row is marked captured. Proof: a 10 s note logs *announcement check → capture finished → kept out of ASR*, and its transcript is the sentence |
| `0fa51d2` | A dictation's Script showed "UN Unlabelled" and offered "change who said it"; the Summary card told a too-short note to "run it again and one will be", and running it again refused in silence | The tab labelled any speakerless turn; the narrator's 400-character floor was a log line, not a row | `oneVoice` on TranscriptTab and the sheet; the tab applies the same floor and says what happened, with no button |
| `776c10e` | Phase 2 step 5: choose Client call, tag "weekly", record a weekly meeting → *General* | The tag→type memory is written only when a type is chosen, with the tags present then | Adding a tag to a meeting whose type was chosen teaches the tag; a suggested type teaches nothing |
| `fd2f783` | The keyboard covered Cancel/Add on the two-field prompt and Done only hid the keyboard; the Summary card's gradient stopped short, flat colour below | A Modal is its own window (adjustResize does nothing for it); a `100%` Rect in an absoluteFill Svg is not redrawn when the card grows after mount | KeyboardAvoidingView around the prompt, Done on the last field submits; the gradient measures its box and draws in numbers |
| `b21dddb` | "Notes ready" sat in the status bar looking like a live recording | The processing notifications reused the recording microphone icon | A page icon for processing and notes-ready |
| `fbbc7e3` | — | — | The probe prints the cosine behind every voice suggestion |

Also today, before the phone: the paywall's eight rows (`e08fff1`), `docs/play-console.md`
re-checked against the code (`b877087`), the scorecard re-scored (`49a2f78`), the founder's list
(`2bbeb30`).

## 3. Measured on this phone

- A 43-second meeting: VAD 0.8 s, ASR 22 s (0.51×), diarization 11 s (0.26×), **narration 169 s
  (3.9×)** — model load 8 s, three item classifications, one chunk. The learned ETA said "about
  3 min" the second time. The writer is the whole wait on a mid-range phone.
- Ask: 15–29 s to an answer with the writer resident.
- First-run download: 96.3 MB in well under a minute on Wi-Fi from the Mumbai mirror.
- Voice match, real voice, two recordings: 0.991. Strangers 0.16–0.28. Threshold 0.65.

## 4. Open, in priority order

1. **Extractor: a schedule change is a decision.** "Shipping moved to Thursday because QA is not
   done" produced no item; without it Phase 3's `changes:` link never fires on the commonest kind
   of changed decision. Cues: moved/pushed/postponed/brought forward to `<day>`. TS + C++ + golden.
2. **The trial-spent card.** After the third summary the Summary card still says "Try it free for
   7 days"; the paywall behind it explains, but the button should not promise a trial that is over.
3. **Prompt dies on BACK with the keyboard up** (Samsung, recorded 14 Sep, bit twice today): the
   first BACK should close the keyboard, not the prompt.
4. **Overflow sheet under the status bar**: nine rows overflow this screen height and the title is
   hidden. The sheet needs a top inset or a scroll.
5. **Client-call sections run together**: `foldSections` splits on line breaks only, so four
   inline labels came back as one paragraph where the stand-up's three were separate.
6. **The header row of the Summary card overflows** on 384 dp ("Copy" → "Co") when the chip, the
   meta, Edit and Copy share it. Distinct from the theme fix: this one is a layout with too many
   siblings.
7. **The paywall stays scrolled after "Try Pro"**: the confirmation is at the top, out of view.
8. Not done today, still Layer 1: the six-hour foreground-service limit (`onTimeout`), the
   extractor's question fragments, the 90-minute capture (needs the Mac's speakers for 90 min).

## 5. For the founder

- The phone is Free, onboarded, models present, release build installed. Your own voice is the
  test that matters for Phase 4 (step 3's card on a fresh install; step 5 with a colleague) and for
  the dictation marks ("comma", "full stop" — say them as you would).
- Nothing today changes the list in `docs/FOUNDER_TODO_2026-09-22.md`.
