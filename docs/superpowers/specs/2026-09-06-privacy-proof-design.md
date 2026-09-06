# The privacy proof screen — counting what leaves, instead of promising nothing does

**Written 6 September 2026.** Answers `docs/NEXT.md` §1 item 8. Research §3.11.

## Why this, and why now

The app already tells people "nothing is uploaded" in six places: the record screen's gate, the
consent card, the import sheet, the backup row, the Settings assurance banner and the crash
reporting row. Every one of those is a promise, and none of them is checkable by the person
reading it.

That is the same shape as the defect fixed earlier today. The consent kit wrote `announced_at`
whenever the media player reported success, and on four recordings out of six the room had been
told nothing. The lesson is not about audio: **a claim the app cannot check is a claim the app
will eventually get wrong.** This screen is the check for the biggest claim the product makes.

It is also the GDPR and enterprise-buyer asset, and the thing people screenshot.

## What the app actually does on the network

Four paths, each with exactly one call site. That is what makes this provable rather than
aspirational, and it is why the invariant is worth defending in CI.

| Path | Single call site | When it runs |
|---|---|---|
| Licence server | `src/billing/subscription.ts` → `post()` | Sign-in, sign-out, and a token refresh only inside 5 days of expiry. **A free user who never signs in makes zero.** |
| Model downloads | `ModelManagerModule.fetchTo()` | Once, at onboarding. ~1.3 GB from `huggingface.co`, `github.com` and `modelscope.cn`. |
| Crash reports | `src/telemetry/crash.ts` | Only when a DSN is compiled in **and** consent was given. There is no DSN today, so this is structurally impossible in the shipping build. |
| Google Play Billing | `NativeBilling` | Play's own connection, opened by Play, when the subscription screen is opened. |

Audio, transcripts and minutes reach none of them. There is no code path from the recordings to a
socket, which is the actual reason "0 bytes of audio" is true — not a counter that reads zero.

## The design

**One ledger, four writers, one reader.**

### The ledger

A `network_events` table in the existing encrypted database: when, what kind, which host, bytes
sent, bytes received, and a human-readable detail — `"token refresh"`, `"ggml-base-q5_1.bin"`.

Nothing is pruned. A model download writes about nine rows once; everything afterwards is roughly
one row a month. A ledger that forgets is not evidence.

### The writers

Each of the four call sites records its own event. They are already the only places that touch the
network, so no new seam is introduced — the recording sits where the connection already happens.

**Play Billing is the exception, and the screen says so.** We do not own that socket and cannot
count it. A privacy screen with an unmentioned exception is worth less than no screen at all, so
the exception is stated in plain words on the screen itself, not in a footnote nobody reads.

### The reader

A screen reached from Settings: a summary for the current calendar month, tappable to reveal the
full ledger. The summary is what gets screenshotted; the log is what a sceptical buyer asks for.

The one-time model download is a first-class line with its domains named, not something tucked
below a fold. It is the largest number on the screen and it is also the argument: **1.3 GB came
down so that nothing has to go up.** Hiding it would be the overclaim this feature exists to
prevent, and a reviewer with a packet capture would find it in a minute.

## Three places this could quietly become dishonest

**"Sent" must mean body bytes.** A GET still pushes several hundred bytes of request headers.
Reporting that as "0 uploaded" is wrong in one direction; counting headers as "data you sent" is
misleading in the other. The label is precise and the screen says headers are excluded.

**A failed ledger write must not read as an undercount.** If recording throws, the call still
happened. Silently dropping the row produces a screen that reads low, which is exactly the failure
being fixed. Drops increment a counter, and the screen reports "1 event could not be recorded"
rather than quietly under-reporting.

**No verdict.** The screen reports what happened and never grades it. No "you are private", no
green tick. It is the same boundary the consent card holds: state the fact, never the conclusion.

## What keeps it true after today

`scripts/check-network-egress.py`, modelled on the existing `check-engine-encapsulation.py`. It
fails the build when `fetch(`, `openConnection`, `HttpURLConnection`, `OkHttp` or a raw socket
appears outside the four registered files.

This is the load-bearing part. Without it the screen is accurate on release day and rots the first
time somebody adds an innocent analytics ping — and it would rot *silently*, because the screen
would go on reporting the paths it knows about. The engine-encapsulation check exists because
Qwen3-ASR shipped compiled-in and unreachable with every test passing; this is the same class of
invariant, and the same blunt instrument is the right one.

## Testing

| what | where |
|---|---|
| month grouping, per-kind totals, byte formatting | TypeScript unit test, pure function over a fixture ledger |
| the `network_events` migration is declared | Kotlin unit test over the migration list |
| a licence call records host, sent and received | TypeScript unit test with a stubbed fetch |
| a dropped ledger write is surfaced, not swallowed | TypeScript unit test |
| a new `fetch(` outside the registered files fails the build | the check script's own test, which plants a violation and asserts a non-zero exit |
| the screen reads zero for a meeting recorded offline, and one after a sign-in | on device, by hand |

The device check is the one that matters, because it is the only one that exercises the real call
sites rather than the ledger's arithmetic.

## What this deliberately does not do

**It does not block or firewall anything.** It reports. An app that claimed to prevent network
access would be making a much bigger promise than it can keep.

**It does not count Play's connection**, and says so rather than implying the number is complete.

**It does not send anything itself.** Stating this because it would be a genuinely absurd way to
lose: the privacy screen is local-only, reads the local ledger, and has no network path of its own
— which the CI check above enforces along with everything else.
