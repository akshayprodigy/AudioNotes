# Play Console submission notes

Everything Google will ask for, answered against what the app actually does. Written before
filing so the answers are checked against the code rather than composed under a rejection.

**Re-checked against `main` on 22 September 2026.** The name is settled (Verbale,
`applicationId com.innocorelabs.verbale`, permanent since the first signed build), the product is
one subscription with two base plans, crash reporting is Firebase Crashlytics behind a consent
switch, and the first-run download is 96 MB. Every earlier version of this file said otherwise on
at least one of those, and the Data safety section is the one Google checks against traffic — so
when the code moves, this file moves in the same commit.

---

## Data safety

This is the section that gets apps rejected, because the declaration is checked against observed
network traffic. Ours is unusually easy: almost everything is "not collected", and it is true.

### Data collected

| Type | Collected? | Shared? | Why | Optional? |
|---|---|---|---|---|
| Email address | **Yes** | No | Only through *Already subscribed? Sign in* — an account bought outside Play. Never asked for on a Play purchase (`/api/billing/play/link` takes a purchase token and a device id, no email) | Yes — the app works with no account, and a Play purchase never creates one with an email |
| User IDs | **Yes** | No | A random per-install identifier the app generates, to bind a licence to a device. Not the Android ID, not the advertising ID, not hardware-derived | Yes |
| Purchase history | **Yes** | No | Whether the subscription is paid and until when | Yes |
| In-app purchases | **Yes** | — | One subscription through Google Play Billing, monthly or annual | Yes |
| Crash logs | **Yes** | No | Firebase Crashlytics: the stack trace, the app version and the phone model when the app crashes. **Off until the user says yes** — collection is disabled in the manifest and enabled only once consent is stored; a Settings switch turns it back off, and off means stopped, not merely un-sent. No custom keys, no logs, no user id are ever handed to it (`src/telemetry/crash.ts`). Debug builds never report | Yes |
| Diagnostics | **Yes** | No | The same Crashlytics reports carry device state at the moment of the crash (memory, OS version). Same consent, same switch | Yes |
| Device or other IDs | **Yes** | No | Crashlytics assigns its own installation UUID. Google's own Data safety guidance for Crashlytics lists it under this heading, so it is declared here | Yes |
| Audio / voice recordings | **No** | No | Recorded and kept on the device; never transmitted | — |
| Files and documents | **No** | No | The database and any backup file stay on the device | — |
| Approximate/precise location | **No** | No | Never requested | — |
| Contacts, calendar, SMS, photos | **No** | No | Never requested | — |
| App activity / interactions | **No** | No | No analytics of any kind is installed. Crashlytics is not given breadcrumbs, screen names or events | — |

Google's declaration guidance for Crashlytics (Firebase's "Data collected by Firebase" page) is
the source for the three Crashlytics rows: crash logs, diagnostics, and the installation UUID under
"Device or other IDs". Declaring them as *optional* is accurate because the manifest keeps
collection off (`firebase_crashlytics_collection_enabled=false` **and** react-native-firebase's own
`rnfirebase_crashlytics_auto_collection_enabled=false`, both guarded by
`src/telemetry/__tests__/manifest.test.ts`) until consent is stored. The privacy screen in the app
names Crashlytics as the one source it cannot count.

### The follow-up questions

- **Encrypted in transit?** Yes. All server traffic is HTTPS; there is no cleartext path.
- **Can users request deletion?** Yes. `https://verbale.innocorelabs.com/delete-account` — sign in,
  delete. Cancels the subscription first and refuses to delete if it cannot. (There is no
  `/account` page; the earlier draft named one.)
- **Data collection optional?** Yes. Everything collected relates either to a Pro account or to a
  crash-reporting consent that defaults to off.
- **Committed to the Play Families policy?** Not applicable; not aimed at children.

### The claim to be careful about

The store listing may say recordings never leave the device, because they do not. It must **not**
say the app never uses the network: it downloads models on first run, a subscribed install
refreshes its licence roughly every nine days (14-day token, 5-day renew window — about 3 kB a
month), and crash reports go out if, and only if, the user said yes. All three are declared above.
The in-app copy was corrected for exactly this reason (see the commit "stop claiming the app never
touches the network"); the privacy screen in Settings shows every byte the app can count.

---

## Foreground services

Both are declared with a type, and Play asks for a justification and a video for each.

### `microphone` — `RecordingService`

> The app records meetings. Recording continues while the user switches to another app to take
> notes, look at a document or answer a message, and while the screen is off — a meeting is not
> paused because the phone was put on the table. Android kills a backgrounded process that holds
> the microphone without a foreground service, which would end the recording mid-sentence with no
> way to recover the audio. The notification shows elapsed time, a Mark button and a stop control;
> the same controls appear in a picture-in-picture window when the user leaves the app.

Why no alternative works: `WorkManager` cannot hold a microphone, and there is no exemption for
audio capture. This is the case the type exists for.

### `dataSync` — `ProcessingService`

> After recording stops, the audio is transcribed, the speakers are separated and the minutes are
> written — entirely on the device. A one-hour meeting takes several minutes of continuous
> computation. If the process is killed part-way the work is lost and the user has an audio file
> and no notes. The notification shows which stage is running, its progress and an estimate learned
> from this phone's own speed; it pauses itself when the phone is too hot or the battery is low and
> resumes on its own.

Why no alternative works: `WorkManager` is the usual answer and was tried. It is not usable here
because the work is a single uninterruptible multi-minute computation over a large model held in
memory; a deferred or interrupted job restarts from the last committed stage and, on a long
meeting, may never finish inside the windows the scheduler allows. The work is user-initiated,
finite, and the user is waiting for it.

**Video to record for review:** start a recording, leave the app, return and stop it, then show the
processing notification through to "Notes ready". One take, no editing needed.

---

## Permissions

The manifest declares exactly these — checked 22 September 2026:

| Permission | Why |
|---|---|
| `RECORD_AUDIO` | The app records meetings |
| `INTERNET` | Downloading models on first run; the subscription check; crash reports after consent. Kept for launch by the 21 September decision (Phase 6a); a build without it is the first post-launch release |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_DATA_SYNC` | The two services above |
| `POST_NOTIFICATIONS` | Recording and processing progress |
| `WAKE_LOCK` | Finishing a transcription without the CPU sleeping mid-pass |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Asked for, never required. Aggressive OEM battery managers kill long processing; the app works without it and simply takes longer or restarts a stage |

No `QUERY_ALL_PACKAGES`, no location, no contacts, no storage permissions. The Quick Settings
recording tile and picture-in-picture need none.

---

## Payments and the subscription

**Google Play Billing, and only Play Billing.** The app offers the subscription in-app through
Play's own billing flow, at the price Play reports. There is no other checkout: the Razorpay web
checkout that an earlier draft of this document described was removed when billing moved to Play,
and the server's only purchase route is the Play link.

*"Already subscribed? Sign in"* on the paywall accepts an account with a subscription bought on
another platform, which is permitted. Today no such platform exists — desktop builds are a later
phase — so the form serves seeded test accounts and nothing else. It shows no price, no link and no
way to buy anything.

The only outbound link is to `play.google.com/store/account/subscriptions`, and only for somebody
who already subscribed — managing an existing Play subscription, not acquiring one.

**Data safety implication:** declare **"Yes"** for in-app purchases.

### Product to create in Play Console

| | |
|---|---|
| Type | Subscription |
| Product ID | `verbale_pro` — must match `playSubscriptionId` in `android/gradle.properties` exactly |
| Base plan `monthly` | ₹299 / month in India, $4.99 / month elsewhere |
| Base plan `annual` | ₹2,499 / year in India, $39.99 / year elsewhere |
| Other markets | Let Play convert from USD unless a market needs a hand-set figure |

Prices are final (founder, 13 September 2026). The app hard-codes none of them: the paywall reads
whatever Play reports for the two base plans, chooses annual by default, and draws the strikethrough
from twelve times the monthly price — so a price changed in the Console changes in the app with no
release. **The paywall shows no price until the product exists**, which is why no device has ever
seen one.

A mismatch between the id in the Console and the id in the build surfaces on the customer's phone
as "this item is not available", with nothing in the build to suggest why — so `BillingModule` says
exactly that in its error text.

### How entitlement actually works — and the one server setting that makes it work

Buying does not grant anything by itself. The purchase produces a token; the licence server asks
Google whether that token is real and mints a signed licence if it is. The enforcement points
(`Narrator.run`, `ModelManagerModule.download`, the Ask and thread gates) check a signature they
cannot forge, so patching the app yields a token the server rejects.

**The server can only ask Google if it has been given a way to.** `PLAY_SERVICE_ACCOUNT_JSON` and
`PLAY_PACKAGE_NAME` in `/opt/verbale/.env` on the VPS; without them `/api/billing/play/link`
answers **503 "Play Billing is not configured on this server."** — which is what the live server
answered on 22 September 2026. On that answer the app acknowledges the purchase locally (so Google
does not refund it) and stores no licence: **the buyer pays and gets nothing** until they reopen the
app after the server is configured. This is therefore the first thing to do after the product
exists, before any tester buys anything:

1. Google Cloud: a service account with the **Android Publisher API** enabled.
2. Play Console › Users and permissions: invite that service account with **Manage orders and
   subscriptions** — account deletion cancels the subscription at Google first and refuses to
   delete if it cannot, so view-only is not enough.
3. Put the JSON (or its path) in `/opt/verbale/.env`, restart the container, and check that the
   probe below no longer says 503.

```bash
curl -s -X POST https://verbale.innocorelabs.com/api/billing/play/link \
  -H 'content-type: application/json' -d '{"purchaseToken":"probe","deviceId":"probe"}'
# configured: a 4xx about the token. Not configured: {"error":"Play Billing is not configured on this server."}
```

Purchases are acknowledged **server-side**, after entitlement is recorded. Google auto-refunds
anything unacknowledged within three days; acknowledging in the app first and then failing to
record would leave somebody paying for nothing with Google satisfied they had been served. The app
acknowledges locally only when the server call failed, which closes the case of a purchase made on
a bad connection by someone who never reopens the app.

One subscription covers up to **3 devices** (`DEVICE_LIMIT` in `server/app/store.py`; the terms
page reads the same constant).

### The free trial needs nothing from the Console

Seven days or three written summaries, whichever ends first, kept in the app's own settings on a
clock that cannot go backwards. It is not a Play introductory offer, so nothing about it is
configured in the Console and it works before the product exists.

---

## Listing copy

Character limits are Play's, and it truncates silently rather than warning you. Counts verified.

**English only is not fine print.** Somebody who records Hindi, is refused, and was not told is a
one-star review. It is in the first paragraph of the full description and in the short description.

### App title — 30 characters, the single heaviest ASO field

> **Verbale: Offline Meeting Notes**  *(30/30)*

"Offline" is the one claim no competitor can make and the reason to install; "meeting notes" is the
phrase people actually search. The brand alone would rank for nothing — nobody is looking for
"Verbale" yet.

Alternates, if you would rather lead differently:

| Title | Chars | Trade |
|---|---|---|
| `Verbale: Offline Meeting Notes` | 30 | **Recommended.** Differentiator + highest-volume term |
| `Verbale: Meeting Notes & MOM` | 28 | "MOM" is standard business vocabulary in India and high intent; loses "offline" |
| `Verbale: Private Meeting Notes` | 30 | "Private" is vaguer than "offline" and everyone claims it |

### Short description — 80 characters, also indexed

> **Records English meetings, writes the minutes on your phone. Offline, no upload.**  *(79/80)*

Avoid going to exactly 80; Play's counting and yours will not always agree.

### Full description

> Verbale records a meeting in English and writes the minutes on your phone. Nothing is uploaded,
> because there is no server to upload to.
>
> Every meeting app sends your conversation somewhere. Verbale does not. The recording, the
> transcript, who said what and the minutes are made on the device and stay there.
>
> **English only, for now.** Verbale transcribes English — including English-medium meetings with
> accents from anywhere. A meeting in another language is refused rather than mangled, and you are
> told why. More languages will follow one at a time, each measured before it is offered.
>
> **Free, forever**
> • Record meetings of up to 15 minutes, as many as you like
> • A full transcript, separated by speaker — tap any line to hear it
> • Decisions, action items and open questions, pulled from what was actually said; each one opens
>   the moment it was said
> • Mark a moment while recording and it becomes a highlight
> • Dictation mode, with spoken punctuation
> • Export as text, Markdown, subtitles or PDF
>
> **Pro, by subscription — monthly or yearly**
> • Meetings of any length
> • The summary and the minutes written in plain English by a language model that also runs on
>   your phone — shaped to the kind of meeting: stand-up, client call, interview, lecture
> • Ask a meeting a question; the answer points at the moment it was said, or says plainly that
>   nothing in the meeting settles it
> • Search everything you have recorded — by keyword and by meaning
> • Threads: meetings that share a tag show what is still open and every decision in order
> • Remembered voices — name someone once and be asked "Sounds like Priya?" next time. Off until
>   you switch it on; kept on this phone; forgotten in one tap
> • Your words, spelled your way: correct a name once and it is written that way from then on
> • A dictated note written up as the note you meant, not a transcript of it
> • The larger transcriber, for strong accents and bad rooms
> • Up to 3 devices on one subscription
>
> **How it works**
> The speech models download once, on first run — about 96 MB. Pro adds about 1.1 GB for the
> writer. Everything after that happens on the device. Recording continues when you switch apps or
> lock the screen. Long meetings keep processing in the background and tell you when the notes are
> ready. Some Pro features need a phone with 4 GB of memory; Verbale checks and tells you before
> anything is downloaded or bought.
>
> Your notes stay yours if you stop paying: everything already written stays readable and you can
> export it all at any time.
>
> Please respect the law and the room. Recording rules differ by country, and telling people they
> are being recorded is both the decent thing and often the legal one. Verbale can say so out loud
> at the start of every recording, and it is on by default.

Every bullet above names something that is built and has run on a phone; nothing is a roadmap
item. Keywords worth appearing naturally, since Play indexes the long description: meeting
recorder, minutes of meeting, MOM, transcription, transcribe, speaker diarization, action items,
offline, private, voice recorder, audio to text.

**Category:** Productivity · **Content rating:** Everyone · **Ads:** none · **IAP:** one subscription, monthly or annual

---

## Website SEO

Implemented in `server/app/pages.py`; these are the values it serves.

**Title tag** *(51 chars — under the ~60 Google renders)*

> Meeting notes that never leave your phone · Verbale

Keywords first, brand last. The usual advice is the reverse, but that assumes a brand somebody is
already searching for — nobody is searching "Verbale" yet, so the phrase has to do the work.

**Meta description** *(152 chars — inside the 150–160 that survives truncation)*

> Verbale records meetings and writes the minutes entirely on your phone. Transcripts, speakers and
> action items — no cloud, no upload, no account needed.

`/privacy` and `/terms` carry their own descriptions. Duplicate descriptions across a site get
ignored and then every page loses, so there is a test asserting they differ.

**Link previews.** og: and twitter: tags with a 1200×630 card at `/static/og.png`, generated from
the mascot geometry by `scripts/make-og-image.py`. `og:image` is absolute — most crawlers drop a
relative one, and the card silently loses its picture. This matters more than it sounds: the URL
gets pasted into WhatsApp and Slack, and a bare link converts far worse than a card.

**robots.txt** allows `/`, `/privacy` and `/terms` and disallows the account pages and the API.
They have nothing to index, and keeping "sign in to Verbale" out of search results also keeps it
off the phishing surface.

---

## Versioning

Change **one line** for a release: `appVersionName` at the top of `android/app/build.gradle`.

`versionCode` is derived from it — `1.0.0` → `10000`, `1.2.3` → `10203` — rather than maintained
beside it, because the classic release mistake is bumping the name and forgetting the code, and
Play's rejection tells you the code is duplicate without telling you why it never changed.

Two things about Play's rules make this worth automating rather than remembering:

- A `versionCode` Play has accepted can never be reused, even if you unpublish that release.
- An accidentally high code burns **every value beneath it, permanently**. Uploading `999` once
  means the next 998 releases have nowhere to go.

The build refuses a minor or patch above 99, because the arithmetic would carry into the next
field and could produce a code that *decreases* — which Play rejects with the same unhelpful
duplicate-version message. Both guards are verified to fire.

The current release is `1.0.0` / `10000`. Do not start higher "to leave room": there is no
benefit, and the room is what you would be destroying.

## Still to do before filing

Done and no longer listed: the upload keystore (`AUDIONOTES_STORE_FILE`, every release build since
5 September), the privacy policy and terms at their public URLs, the rename, the on-device runs
(A07 and Pixel through 14 September, the Galaxy Tab A and the A07 since), pricing.

- [ ] Create the app in Play Console and **enrol in Play App Signing at creation** — it cannot be
      added cleanly to an existing unmanaged app
- [ ] Create the `verbale_pro` subscription with base plans `monthly` and `annual` at the prices above
- [ ] Google Cloud service account with the Android Publisher API, invited to Play Console with
      **Manage orders and subscriptions**, its JSON in `/opt/verbale/.env` — then run the probe
      above and see the 503 gone. **Nothing can be bought until this is done**
- [ ] Upload the `.aab` to an internal testing track; add a licensed tester; put one phone through
      the paywall and note what it showed
- [x] Screenshots: phone, 2–8, at least 1080px on the short side — **eight are in
      `docs/store/screenshots/`, ready to upload**, numbered in listing order (see
      `docs/store/README.md`)
- [x] Feature graphic, 1024×500 — `docs/store/feature-graphic.png`
- [x] Record the two foreground-service videos — `docs/store/videos/`, one per type
- [ ] Data safety form, from the table above
- [ ] Content rating questionnaire
- [ ] Staged rollout at 5–10 % with crash reporting available, so a bad build is recoverable
