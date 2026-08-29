# Play Console submission notes

Everything Google will ask for, answered against what the app actually does. Written before
filing so the answers are checked against the code rather than composed under a rejection.

**The name is not settled.** "Verbale" is taken. Nothing here should be filed until it is, and
until `scripts/rename-app.py` has run — `applicationId` is permanent from the first upload.

---

## Data safety

This is the section that gets apps rejected, because the declaration is checked against observed
network traffic. Ours is unusually easy: almost everything is "not collected", and it is true.

### Data collected

| Type | Collected? | Shared? | Why | Optional? |
|---|---|---|---|---|
| Email address | **Yes** | No | Account and subscription | Yes — the app works with no account |
| User IDs | **Yes** | No | A random per-install identifier the app generates, to bind a licence to a device. Not the Android ID, not the advertising ID, not hardware-derived | Yes |
| Purchase history | **Yes** | No | Whether the subscription is paid and until when | Yes |
| Audio / voice recordings | **No** | No | Recorded and kept on the device; never transmitted | — |
| Files and documents | **No** | No | The database and any backup file stay on the device | — |
| Approximate/precise location | **No** | No | Never requested | — |
| Contacts, calendar, SMS, photos | **No** | No | Never requested | — |
| App activity / interactions | **No** | No | No analytics of any kind is installed | — |
| Crash logs, diagnostics | **No** | No | No crash reporting SDK. This is a deliberate trade — see below | — |

### The follow-up questions

- **Encrypted in transit?** Yes. All server traffic is HTTPS; there is no cleartext path.
- **Can users request deletion?** Yes. `https://<host>/account`, sign in, "Delete my account".
  Cancels the subscription and erases the account. Also reachable from Settings in the app.
- **Data collection optional?** Yes. Everything collected relates to an account, and the account is
  only needed for the paid tier.
- **Committed to the Play Families policy?** Not applicable; not aimed at children.

### The claim to be careful about

The store listing may say recordings never leave the device, because they do not. It must **not**
say the app never uses the network: it downloads models on first run, and a subscribed install
checks its licence about weekly. Both are declared above. The in-app copy was corrected for exactly
this reason (see the commit "stop claiming the app never touches the network").

---

## Foreground services

Both are declared with a type, and Play asks for a justification and a video for each.

### `microphone` — `RecordingService`

> The app records meetings. Recording continues while the user switches to another app to take
> notes, look at a document or answer a message, and while the screen is off — a meeting is not
> paused because the phone was put on the table. Android kills a backgrounded process that holds
> the microphone without a foreground service, which would end the recording mid-sentence with no
> way to recover the audio. The notification shows elapsed time and a stop control.

Why no alternative works: `WorkManager` cannot hold a microphone, and there is no exemption for
audio capture. This is the case the type exists for.

### `dataSync` — `ProcessingService`

> After recording stops, the audio is transcribed, the speakers are separated and the minutes are
> written — entirely on the device. A one-hour meeting takes several minutes of continuous
> computation. If the process is killed part-way the work is lost and the user has an audio file
> and no notes. The notification shows which stage is running and its progress.

Why no alternative works: `WorkManager` is the usual answer and was tried. It is not usable here
because the work is a single uninterruptible multi-minute computation over a large model held in
memory; a deferred or interrupted job restarts from the last committed stage and, on a long
meeting, may never finish inside the windows the scheduler allows. The work is user-initiated,
finite, and the user is waiting for it.

**Video to record for review:** start a recording, leave the app, return and stop it, then show the
processing notification through to "Notes ready". One take, no editing needed.

---

## Permissions

| Permission | Why |
|---|---|
| `RECORD_AUDIO` | The app records meetings |
| `INTERNET` | Downloading models on first run; the subscription check |
| `FOREGROUND_SERVICE`, `..._MICROPHONE`, `..._DATA_SYNC` | The two services above |
| `POST_NOTIFICATIONS` | Recording and processing progress |
| `WAKE_LOCK` | Finishing a transcription without the CPU sleeping mid-pass |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Asked for, never required. Aggressive OEM battery managers kill long processing; the app works without it and simply takes longer or restarts a stage |

No `QUERY_ALL_PACKAGES`, no location, no contacts, no storage permissions.

---

## Payments and the subscription

Sold on our own website, not through Play Billing.

Policy position: the app contains **no link, button or reference to the subscription being
purchasable anywhere**, and no pricing. Sign-in accepts an account bought on the web; that is
permitted. Where the paid tier is unavailable the app states the fact and sells nothing — the
lapsed-subscription copy is server-supplied precisely so it can be adjusted without a release if
policy moves (`LicenceModule.defaultLapsedCopy`).

Reason for not using Play Billing: the app ships to other Android stores and desktop builds are
planned, neither of which Play Billing can serve, and running one entitlement system is simpler
than one and a half.

**Worth a second opinion before filing.** This is the single riskiest item in the submission.

---

## Listing copy

**Short description (80 max)**

> Records meetings and writes the minutes. Entirely on your phone. Nothing uploaded.

**Full description**

> Every meeting app sends your conversation to a server. This one does not have one.
>
> Record a meeting and it is transcribed, separated by speaker and turned into notes on your own
> phone. No account, no upload, no cloud. The recording, the transcript and the minutes never
> leave the device — there is no server here that could hold them.
>
> **Free, forever**
> • Record any meeting, of any length
> • A full transcript, separated by speaker
> • Decisions, action items and open questions, pulled from what was actually said
> • Search everything, export anything
>
> **Pro, by subscription**
> • The summary and the minutes written in plain English, by a language model that also runs on
>   your phone
> • Up to 3 devices on one subscription
>
> **How it works**
> The speech models download once, on first run, and everything after that happens on the device.
> Recording continues when you switch apps or lock the screen. Long meetings keep processing in
> the background and tell you when the notes are ready.
>
> Your notes stay yours if you stop paying: everything already written stays readable and you can
> export it all at any time.
>
> Please respect the law and the room. Recording rules differ by country, and telling people they
> are being recorded is both the decent thing and often the legal one.

**Category:** Productivity · **Content rating:** Everyone · **Ads:** none · **IAP:** none in-app

---

## Still to do before filing

- [ ] Settle the name; run `scripts/rename-app.py`
- [ ] Release keystore, and enrol in Play App Signing
- [ ] Host the privacy policy at a public URL (`/privacy` is written and deployed; needs DNS)
- [ ] Screenshots: phone, 2–8, at least 1080px on the short side
- [ ] Feature graphic, 1024×500
- [ ] Record the two foreground-service videos
- [ ] Test on a low-RAM, non-Pixel device — the 1.5B model is the risk
- [ ] Decide pricing and create the Razorpay plan
