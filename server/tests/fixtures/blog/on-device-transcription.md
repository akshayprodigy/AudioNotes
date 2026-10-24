---
title: Why on-device transcription changes what a meeting app can promise
description: When the model runs on the phone, "we never see your audio" stops being a policy and becomes a fact of the architecture.
date: 2026-09-02
tags: privacy, on-device
cover: on-device
cover_alt: A phone with a sound wave inside a lock
shot: record-screen
---
Most meeting apps send your audio to a server. This one does not.

## What leaves the phone

Nothing about the meeting. Not the audio, not the transcript.

![The recording screen](/static/shots/record.webp)

## What stays

Everything, including the **speaker labels**.

## Why it matters

> A promise you can verify beats one you have to trust.

| Step | Where it runs |
|------|---------------|
| Transcribe | Phone |
| Minutes | Phone |

```
no upload
```

| Step | Engine | Runs on | Needs network | Stores audio | Stores text | Shared |
|---|---|---|---|---|---|---|
| Transcribe | Speech model | Phone | No | Phone only | Phone only | Never |
