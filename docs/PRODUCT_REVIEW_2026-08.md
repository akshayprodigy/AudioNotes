# Verbale — Product Review & Suggestions

**Date:** 2026-08-30
**Lens:** user + product manager, against the shipped code on `main` (all feature branches merged)
**Companions:** `BUILD_PLAN.md`, `InnoCore_MeetingNoteTaker_PRD_v3.docx`, `docs/MILESTONE6.md`

---

## TL;DR

The engine is genuinely differentiated and further along than the README admits. As a
product, Verbale today is a *recorder that writes notes*, not yet *notes you trust and
return to*. Three things stand between it and a strong launch:

1. **Trust** — the user cannot verify or fix anything the AI produced (no playback, no
   editing, no rename).
2. **Accuracy on real target audio** — Hinglish code-switched meetings break whisper-base.
3. **Conversion** — Pro sells exactly one feature, there is no paywall moment, and the
   Play price is still undecided.

---

## 1. Where the product stands

Done and good — don't touch:

- Fully on-device, **resumable-by-stage** pipeline (VAD → whisper → diarization → rule
  minutes → Qwen narration), surviving process death, with headless processing and a
  "Notes ready" notification.
- Recording from the app, the **Quick Settings tile**, or a **native-drawn PiP window**
  with real Pause/Stop controls.
- Four-tab meeting screen: Summary / MOM / Script / **Actions worklist** whose ticks
  survive reprocessing.
- Speaker rename + merge, encrypted storage, passphrase backup/restore, MD/TXT/SRT
  export, honest state copy everywhere (four distinct "why there's no summary" messages).
- Billing with an offline-verifiable ECDSA licence; lapsed subscribers keep what was
  already written.

Market tailwind: Otter faces a class action over training on user transcripts; the
loudest incumbent complaints are accuracy on accents and creepy participant emails.
"No third-party AI ever touches your audio" has never been easier to sell.

---

## 2. User lens — friction in existing features (ranked)

### 2.1 The trust gap: nothing can be verified or fixed  ← highest priority

Our own eval says ~30% WER, yet:

- **No audio playback at all.** A consultant cannot check what was actually said before
  sending minutes to a client. *Fix:* tap a transcript turn to play from its timestamp.
  Requires revisiting the delete-audio-after-transcription default (e.g. keep 7 days).
- **No editing** of transcript, summary, narrative, or minutes. Read-only AI output is
  the opposite of "accurate minutes are billable."
- **No manual action items** — the model missed one, the user is stuck.
- **No meeting rename** — `db.setTitle` exists, no UI calls it; auto-titles are the first
  ~60 transcript chars ("Okay so um yeah let's start…"). Trivial to add, high daily value.

### 2.2 Accuracy on the founder's own meetings (Hinglish)

whisper-base writes Arabic script (auto-detect) or hallucinates fluent English (pinned
`en`) on Hindi/English code-switched audio. This is the dogfood success criterion and
the category's #1 complaint theme. Near-term mitigation: a **language override** in
Settings (`start(null)` is hardcoded today; the `language` column is never written).
The real fix is the Phase 2 model work — treat it as the existential bet.

### 2.3 Search under-delivers its own claim

`NativeStorage.ts` documents "utterances + minutes"; FTS indexes **only utterances**
(`AudioDb.kt`). Titles and minutes are unsearchable — but the decision the user is
hunting for lives in the minutes. No term highlighting, no filters, no grouping.

### 2.4 The free tier's export undermines the demo

Free users' exported Markdown "summary" is the rule row — literally
"12 action items, 3 decisions, 5 open questions." That's the document they show a
colleague. Give the free export a decent composed fallback (or lead with the actions
list instead of a count).

### 2.5 Paper cuts

| Item | Note |
|---|---|
| No copy-to-clipboard | Zero Clipboard references in the codebase; add to summary/minutes/transcript |
| No dark mode | Deliberately removed; Play reviews will name it |
| "6 of 5" onboarding progress | Progress uses `essentials.length` while iterating `chosen` |
| Consent copy | Still phrased for the deleted overlay bubble, not PiP |
| Model hosting | Personal GitHub release + raw HuggingFace — first-run success depends on third-party uptime; move to a CDN/R2 **before launch** |
| Stale README | Still claims the natives are stubs |
| Stale comments | Several files reference the deleted floating bubble |

---

## 3. PM lens — new features users want or need (ranked)

1. **Global Actions view.** The per-meeting worklist (owners, due dates, persistent
   ticks) is the best retention hook in the category — lift it to a home-level
   "everything I owe / everyone owes me" view across meetings. This is the PRD's
   "commitment tracking," but it needs no server. Turns a recorder into a daily-open app.
2. **Accept audio from other apps** (share target + file picker). WhatsApp voice notes,
   lectures, interviews, recordings made elsewhere. Cheap: pipeline needs only a
   decode-to-16 kHz-mono front step. Big acquisition surface.
3. **Ask-your-meetings Q&A** (on-device: FTS retrieve → Qwen answer). "What did we
   decide about pricing last week?" The Pro flagship that makes a *subscription* feel
   justified, at zero marginal cost.
4. **Live transcription during recording** — "notes before you leave the room."
   Currently blocked on whisper-model-reload + streaming VAD; at 0.68× realtime
   processing, halving perceived wait is the biggest perceived-quality lever.
5. **Persistent speakers.** The user renames "Speaker 1" to Priya in every meeting;
   remember names (and later voices/enrollment) across meetings.
6. **A privacy *proof* screen.** "Network calls this month: 1 licence check. Audio
   uploaded: 0 bytes." Regulated buyers screenshot that; it converts the promise into UI.
7. **Calendar-aware nudges + weekly on-device digest** — habit formation on top of the
   existing streak card.
8. **iOS** — keep where the plan has it: after the Android product converts.

---

## 4. Monetization — fix the funnel before launch

Current state: Pro unlocks **one** thing (the LLM prose); purchase lives buried in a
Settings section; there is no paywall screen; `docs/play-console.md` still says
"Price: *(to decide)*".

Recommendations:

- **Decide the price**, with an annual plan and Indian regional pricing.
- **Let free users taste narration** — 7-day trial or 3 free summaries. Prose minutes
  are the kind of feature you buy *after* seeing it on your own meeting.
- **Contextual paywall at the moment of value** — the first READY meeting should show
  the locked Summary card as a sell (with the trial CTA), not just an explanation.
- **Fatten Pro**: gate whisper-small (better accuracy; currently free/optional, and the
  PRD always intended it as Pro), and market Q&A + digest as "coming to Pro."

---

## 5. Suggested sequence

**Now (pre-launch, sharpen what exists)**
- Audio playback + tap-transcript-to-seek (with an audio-retention default change)
- Meeting rename; copy-to-clipboard
- Index minutes + titles in FTS; highlight matches
- Better free-tier export summary fallback
- Model CDN; price + trial + contextual paywall
- Small fixes: "6 of 5", consent copy, README, stale bubble comments

**Next (trust + habit)**
- Transcript/minutes editing; manual action items
- Global Actions view
- Share-in audio (share target + file picker)
- Language override in Settings; dark mode

**Later (moat)**
- Hinglish-quality ASR (Phase 2 model work)
- Ask-your-meetings Q&A (Pro)
- Live transcription; persistent speakers
- iOS port; Deep tier only when Pro demand shows up

---

## 6. Market signal (sources)

- [Otter AI Reddit review — accuracy complaints, training-data lawsuit](https://www.aitooldiscovery.com/guides/otter-ai-reddit)
- [Granola vs Otter vs Fireflies vs Fathom 2026 — tools specializing by niche](https://www.useluminix.com/reports/industry-analysis/ai-meeting-notes-comparison-granola-vs-otter-vs-fireflies-vs-fathom-2026)
- [Otter vs Fireflies in 2026](https://justtalkingtech.medium.com/otter-vs-fireflies-in-2026-the-veterans-reviewed-1ae7a9409eaa)
- [Best offline transcription apps 2026 — English-first / Pixel-only gaps in the private segment](https://viskalocal.com/blog/best-offline-transcription-apps-2026.html)
