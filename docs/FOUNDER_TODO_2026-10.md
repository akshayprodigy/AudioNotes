# Founder to-do — October 2026 plan

*7 October 2026. Written after the Phase 0 baseline (`docs/superpowers/reports/2026-10-07-phase-0-baseline.md`). Everything here needs you, a person, or something Claude cannot see (Play Console, the live server, a phone in someone's hand). The product plan is `docs/PRODUCT_IMPROVEMENT_PLAN_2026-10.md`; each item below names the plan phase it blocks.*

**Nothing here has been done or checked by Claude.** Where an item says "verify", an older document claims something and the current state is unknown. This file supersedes `FOUNDER_TODO_2026-09-22.md` for anything it repeats; that file's Play Console steps are copied here only where still open.

How to use it: tick a box when done, and write the date and one line of result next to it. Items marked **▶ do first** unblock engineering.

---

## A. Decisions — before Phase 1 starts ▶ do first

**A1. Merge the allowance branch?** `free-allowance` holds the policy code (2 of 10 tasks) and the plan, 4 commits ahead of `main`, unmerged. The October work builds on it. Recommendation: merge it after Claude's review of the 4 commits, then build on `main`.
- [ ] Yes, merge after review / [ ] No, rebuild on `main` instead — *blocks Phase 1a*

**A2. The 14 allowance-policy gaps** (baseline report §2). Each has a proposed default in plan §3a. Reply "accept all", or list the ones you want changed.
- [ ] GAP-1 what counts as a "usable transcript" (proposed: at least one utterance of 3 words or more)
- [ ] GAP-2 an empty or no-speech recording is refunded; whether a short dictation with real words costs a slot (proposed: yes, per plan §3 — your call, it is the most visible one)
- [ ] GAP-3 short sessions are settled right after the fast speech-detection stage, not after full transcription
- [ ] GAP-4 a Free session you upgrade mid-way keeps its slot
- [ ] GAP-5 "Pro at the start" means a valid, unexpired licence on the phone at that moment
- [ ] GAP-6 stop at 60:00 of captured audio (about a second's overrun is acceptable); an import over 60:00 + 1 s is refused
- [ ] GAP-7 a paused recording is ended and kept after 60 minutes paused (number is a starting guess)
- [ ] GAP-8 clock changes: a counted session more than one month ahead of the phone's clock is read as this month (bounds any lock-out to one month)
- [ ] GAP-9 backup merge: the state that uses more allowance wins
- [ ] GAP-10 order at start: permission → storage → licence → take a slot → open the microphone
- [ ] GAP-11 one session at a time; an import while recording is refused
- [ ] GAP-12 wording: "5 meetings each month · up to 1 hour each" plus one line saying imports and dictations count too
- [ ] GAP-13 an import's length is its decoded length
- [ ] GAP-14 an unverified purchase stays Free until verified (the "payment received" card remains)

*Blocks Phase 1a. Without a yes, engineering builds the proposed default and flags it.*

**A3. Interview and benchmark ground rules**
- [ ] How long we keep research notes and audio, and who may hear them (the consent wording has blanks for this)
- [ ] Incentive for interview participants
- [ ] A contact name/email for the consent form
- [ ] Whether screen mirroring to a laptop is acceptable in sessions (only scripted content appears on screen)
- [ ] Who the second labeller is (the benchmark needs two people who can hear the audio)

*Blocks the interview round and the benchmark.*

**A4. Roles** — plan §5 says to name owners before implementation: product owner, design owner, engineering, device QA, release.
- [ ] Names written into the plan

---

## B. People and recordings — start now, they take longest

- [ ] **Recruit 5–8 interview participants** using the criteria in baseline report §4.1 (in-person English meetings weekly, Android, mix of phones/accents, one large-text or screen-reader user). *Round 1 on the current build; round 2 after the sample meeting ships (Phase 2).*
- [ ] **Recruit meeting owners for the benchmark** — 12 real meetings first, 24 total (baseline report §3). Every speaker in each recorded meeting must consent. Audio stays on an encrypted disk and is never committed to git.
- [ ] **A quiet room and a second voice** for the interview scripted scenario (the facilitator).
- [ ] **A decision on running the interviews yourself or via someone else.** Claude cannot run them.

---

## C. Phones and devices

- [ ] **A phone with no real meetings on it** for billing restore/reinstall tests — or back up the founder's real meeting on the Galaxy A07 (Settings → Back up) and accept a wipe. *Blocks the billing device scenarios (Phase 1b).*
- [ ] **A low-memory phone (about 4 GB) and a newer phone** for the plan §6 device runs. The Pixel is dead; the Galaxy A07 and Tab A are the known devices. Say which are available.
- [ ] **One overnight slot** for the 90-minute capture (never run; `docs/ARCHITECTURE.md:633`).
- [ ] **Two real voices** in one room for the speaker-merge and remembered-voices steps (synthetic voices diarize as one speaker).
- [ ] **Play licence-tester setup on the phone used for billing tests** (the account on the A07 is `senmithee366@gmail.com`; Play only offers the test card after the tester list is saved and Play Store is force-stopped, about 8 minutes later).

---

## D. Play Console — the list for when we do it

*Do these at the Phase 3 release step unless marked ▶. Claude cannot see the Console; verify each one on screen.*

**Check what is there (▶ do before the first test purchase)**
- [ ] **Verify** the subscription product id. `docs/play-console.md` says `verbale_pro_1m` with base plans `verbale-pro-1m` and `verbale-pro-12m` (created 23 Sep); older documents and the app say `verbale_pro` with `monthly` and `annual`. The app is built with one id, so confirm the Console and the build agree. *If they differ, a buyer pays and gets nothing.*
- [ ] **Verify** the server's Play link is configured. On 22 Sep the live server answered `503 Play Billing is not configured` (`PLAY_SERVICE_ACCOUNT_JSON` unset). The A07 test purchase on 25 Sep was verified by the server, so it may be fixed; confirm with the probe in `docs/play-console.md`.
- [ ] **Verify** the 7-day free-trial offer is on both base plans.

**Fix the Console text and prices (A07 defect 13)**
- [ ] Prices: the A07 saw ₹300 / ₹2,500 on the Pro screen. Set ₹299 / month and ₹2,499 / year in India, $4.99 / $39.99 elsewhere.
- [ ] Subscription benefits: remove "Export meetings (MP3, SRT, PDF)" — there is no MP3 export, and export is free. List what Pro actually adds: AI prose summaries and narrated minutes, Ask this meeting with citations, semantic search, remembered voices, vocabulary across meetings, project threads and decision history, the action worklist, and the larger transcription model where supported. Do **not** list follow-up reminders or the digest until they ship.

**Listing and store copy — after the 60-minute allowance is built**
- [ ] Replace "Record meetings of up to 15 minutes, as many as you like" (`docs/play-console.md:270`) with the new Free offer: 5 meetings a month, up to 1 hour each.
- [ ] Update the website's Free-tier copy and the FAQ "Why is Free limited to fifteen minutes?" (`server/app/landing.py:236,291-292`). *Engineering does the code; you deploy.*
- [ ] Replace "Plain English, the moment it ends." (`docs/store/tools/aso.py:20`) — unless processing time is measured and the claim holds. Regenerate the screenshots that show it.
- [ ] Re-shoot the recording and summary screenshots (`docs/store/screenshots/01-recording.png`, `02-summary.png`) once the new limit line, "N of 5 free meetings left" and Minutes/Transcript labels exist.
- [ ] Keep "English only" in the first line of the listing (settled decision).
- [ ] Say plainly in the listing that Pro's writer features need a capable phone (the plan requires this before purchase).

**Forms and release**
- [ ] Data safety form and content rating questionnaire (still unticked in `docs/play-console.md`).
- [ ] Upload the new `.aab` (version above 1.0.3) to internal testing; one licensed tester takes the paywall end to end; note the result.
- [ ] **Staged rollout at 5–10 %** with Crashlytics on; widen only after the P0 scenarios pass on devices.
- [ ] Decide the rollback rule: if a rollback is needed, Free ledger and saved content must keep working (plan §6).

---

## E. Server and hosting

- [ ] **Re-run `mirror-models.sh` on the server** so `bge-small-en-v1.5-q8_0.gguf` is on the mirror (404 today per the A07; every Pro user pays a failed request before the fallback). Your word — it is a deploy. Then check `curl -I` returns 200.
- [ ] **Deploy the landing-page copy change** after engineering edits it (D: store copy above).
- [ ] **Confirm the live server version** includes `30c6fcf` (stops the 3-day grace for cancelled subscriptions). The A07 saw a cancelled row with a grace-length token, which suggests an older build was running.

---

## F. Repository

- [ ] **Push** — `main` is 49 commits ahead of the last-known `origin/main` (not fetched). Your word.
- [ ] **Review and commit** `docs/PRODUCT_IMPROVEMENT_PLAN_2026-10.md` and this file (both are untracked or new on `phase-0-baseline`).
- [ ] **Decide whether to merge `phase-0-baseline`** (docs only: the baseline report) into `main`.

---

## G. Founder-owned content

- [ ] **Consent clip** — the shipped clip must be a human recording. `FOUNDER_TODO_2026-09-22.md` says you supplied it on 22 Sep, but `NEXT.md` item 7 still calls it a synthesised placeholder — confirm which clip is in the build you will upload, and that whisper hears "Verbale" correctly.
- [ ] **Confirm the price-in-copy wording** for the exhausted state and the paywall (plan §3 gives draft copy).

---

*When something here is done, tell Claude and it will update the plan phase that was waiting on it.*
