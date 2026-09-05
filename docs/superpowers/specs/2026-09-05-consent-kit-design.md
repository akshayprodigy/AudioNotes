# The consent kit — telling the room, and being able to show that you did

**Written 5 September 2026.** Answers `docs/NEXT.md` §1 item 7. Research §3.7.

## Why this, and why now

The launch is global. That makes all-party-consent US states and GDPR the operating environment
rather than an edge case, which is why NEXT.md moved this up the list.

Otter is in a consolidated wiretap class action over exactly this. Limitless shipped a consent
chime. Apple's call recording announces itself. The category's biggest open legal wound is a
feature this product can close for about two days of work — and closing it is not defensive, it is
the clearest possible demonstration of the thing Verbale already claims to be.

**What exists today** is a one-time acknowledgement the *recorder* taps before their first
recording: "make sure everyone in the room is okay with being recorded." That is a promise made to
the app by one person. It is not a disclosure to the room, and it leaves no trace anyone else can
check.

**Scope.** Three things: a spoken announcement, a card to show the room, and where the defaults
sit. Not a compliance engine, and not legal advice — see the last section, which is load-bearing.

## The announcement

A short bundled clip plays through the speaker immediately after capture starts, so the microphone
records it. It lands as the first seconds of the audio and the first line of the transcript.

**That is the whole idea.** The recording carries its own proof that the room was told. An exported
transcript opens with the disclosure, and it travels with the file to anyone the meeting is
forwarded to. A consent flag in a local database proves nothing to anybody outside the phone.

This works because of a decision already made for a different reason: `RecordingService` captures
with `MediaRecorder.AudioSource.UNPROCESSED` (falling back to `VOICE_RECOGNITION`), chosen for ASR
quality. Neither source applies the acoustic echo cancellation that `VOICE_COMMUNICATION` would,
so the speaker output is not filtered back out of the capture. **If that source ever changes, this
feature silently stops producing evidence** — a comment in `RecordingService` must say so.

### A bundled file, not text-to-speech

Android TTS localises for free and ships no asset, and it was the obvious first answer. It is the
wrong one here.

Google's TTS synthesises over the **network** for its better voices. Item 8 of the same list is a
screen that reads "Network calls this month: 1 licence check. Audio uploaded: 0 bytes." A consent
feature that quietly makes a second network call would put a hole in the exact claim the next
feature is built to make. TTS also depends on an engine that may be absent or may fail silently,
which for a feature whose entire job is assurance is the worst available failure mode.

A bundled clip is offline by construction, deterministic, verifiable byte for byte, and has no
engine dependency. It costs a few hundred KB in `res/raw` and it cannot say the date or the meeting
title — which the sentence does not need. v1 is English-only, so one file covers the product.

**The sentence, fixed:** *"This meeting is being recorded by Verbale. The recording stays on this
phone."*

Both halves earn their place. The first is the disclosure. The second is the fact that distinguishes
this from every cloud recorder in the room's experience, and it is worth thirteen words to say it
out loud to people who have only ever met the other kind.

**The asset has to be produced.** A single mono clip, 16 kHz to match the capture rate, normalised
and unhurried, checked into `res/raw`. This is the one part of the feature that cannot be written —
it needs somebody to record it, and a synthesised voice would be an odd thing to open a
trust-first product with. It is the item's only external dependency and it blocks the device test,
not the code.

### It must never claim something that did not happen

Playback can fail: silent mode, Do Not Disturb, audio focus lost to a call, a broken speaker.

The meeting is stamped as announced **only on confirmed playback completion**. On failure the app
says so plainly and tells the recorder to announce it themselves. An app that reported "the room
was told" because it *tried* to tell them would be worse than one with no announcement at all,
because the person would stop checking.

## The card

A full-screen page, reachable from the record screen: large type, high contrast, readable across a
table. For the rooms where talking over people is not practical, or where somebody wants to see it
rather than hear it.

Static content. No state, no logging — it is a poster, not a form. Deliberately not a signature
capture: collecting names would make this a data-collection feature inside an app whose Play Data
Safety entry says no data is collected.

## Defaults and region

**The announcement defaults on, everywhere, and is overridable in Settings.**

The alternative — default on only in all-party-consent states and GDPR territories — is what
NEXT.md literally says, and it was rejected. It means shipping and maintaining a map of
jurisdictions, and the failure mode of a stale or wrong entry is defaulting somebody to silence in
a place that required otherwise. An app whose pitch is trust should not make disclosure the
exception.

Region is still detected, offline: `TelephonyManager`'s network country ISO where available,
falling back to `Locale.getDefault().country`. Never a network call, never a location permission.

**It changes the card's wording, not the announcement's.** The spoken clip is one fixed sentence
because it is one bundled file — varying it by region would mean shipping and maintaining an audio
asset per regime, which is the jurisdiction map rejected above wearing a different hat. The
sentence chosen is safe everywhere precisely because it states a fact and claims nothing.

The card is text, so it can vary at no cost: EU/UK wording names the recording and its purpose in
the terms GDPR notices use; everywhere else gets plain disclosure. A region we do not recognise
gets the plain wording, which is safe in every jurisdiction because it says less, not more.

## What this deliberately does not do

**It does not tell anyone they are compliant.** No "this recording is legal in your state", no
green tick, no jurisdiction verdict. The app reports what it *did* — "the room was told at
14:02" — and never what that means legally. A wrong jurisdiction call delivered confidently is
worse than no call at all, and this is a two-person company shipping to dozens of legal regimes.

**It does not collect anything.** No names, no signatures, no attendee list. That would trade the
Data Safety declaration for a feature nobody asked for.

**It does not block recording.** A person who needs to start now, and will announce it themselves,
must be able to. The announcement is a default, not a gate.

## Testing

| what | where |
|---|---|
| the region → **card** wording mapping, including the unknown-region fallback | TypeScript unit test, pure function |
| a failed playback does not stamp the meeting as announced | Kotlin unit test over the completion callback |
| the clip is present, non-empty and the expected format | Kotlin unit test reading `res/raw` |
| the announcement is audible in the recorded audio | on device, by hand: record 20s with it on, confirm the transcript's first line is the disclosure |
| the card renders and is legible at arm's length | on device, by hand |

The last two matter most and neither is automatable. The device check is the one that proves the
feature does the only thing it exists to do.
