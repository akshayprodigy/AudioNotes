# Live transcript — transcribe during the capture

**Written 7 September 2026.** `docs/NEXT.md` §4 item 1. Supersedes the two-line sketch there.

**The one-sentence version:** whisper runs during the meeting instead of after it, and it does so
as a *cache* that the existing pipeline consults — so the transcript it produces is provably the
same transcript, and a phone that cannot keep up simply falls back to today's behaviour.

---

## 1. Why

Processing a meeting currently takes about as long as the meeting did. Measured on the Pixel 7
Pro, on real captured audio rather than clean corpus audio:

| Stage | Rate | 90-minute meeting, after "stop" |
|---|---|---|
| VAD | 0.01x | ~1 min |
| ASR | 0.53x | ~48 min |
| Diarization | 0.64x | ~58 min |
| Minutes + narration | — | a few min |
| **Total wait** | **~1.2x** | **~107 min** |

The founder's framing is the right one: an hour to ninety minutes is an ordinary in-person
meeting, and asking for another hour and three quarters afterwards is the product's worst moment.
ASR is the half of that wait which can be moved, because it can start before the meeting ends.

**Expected after this ships: ~60 minutes instead of ~107.** Roughly half.

**This does not make notes instant, and the spec should not be read as claiming it does.**
Diarization cannot start until the recording is complete (§8), so after this lands diarization is
essentially the *entire* remaining wait — about 58 of those 60 minutes. That is the next problem,
not this one.

## 2. The decision that shapes everything else

The live pass **makes no decisions**. It is a cache of chunk decodes and nothing more.

The alternative — letting it write utterance rows and having `ResumePlan` skip `Stage.ASR` — was
considered and rejected. It breaks on partial completion: a live pass that finished 80% of a
meeting leaves `hasUtterances` true, `Stage.ASR` is skipped, and the last eighteen minutes are
silently lost. Fixing that means teaching `ResumePlan` about partially-complete stages, and it
forces the live pass to make the language-refusal call on partial evidence — a decision this
codebase deliberately makes once, on the whole recording
(`docs/superpowers/specs/2026-09-04-english-only-and-refusing-to-fabricate-design.md`).

A third option — periodically re-running the existing whole-file `nativeTranscribe` — needs no new
native API and is the cheapest to build, but the work is quadratic in meeting length. It would
burn several times the CPU of a single pass to arrive later.

## 3. Why the output cannot differ

`cpp/asr/whisper_asr.cpp:247` sets `wparams.no_context = true`. Every chunk is decoded with no
state carried from the chunk before it. **Decoding a chunk is therefore a pure function of its
audio, the weights, the language and the thread count.** A cached result is not merely likely to
match what the post-hoc pass would have computed; it is the same value of the same function.

This is the whole reason to prefer this design over one that is merely tested into correctness.
The guarantee is structural. The tests in §9 exist to catch a mistake in the *plumbing*, not to
establish the property.

**The distinction that matters:** cache *hits* depend on the live VAD producing the same spans as
the whole-file VAD, because the spans determine the chunk boundaries that form the key. If they
diverge, keys miss and everything is decoded normally. **So VAD parity buys speed, and can never
cost correctness.** Those are the two failure directions and only one of them exists.

## 4. Architecture

One new component, `LiveTranscriber`, owned by `RecordingService`, on its own thread.

It never touches the capture thread. `RecordingService.startCapture`'s loop keeps its only job —
`record.read()` into `out.write()` — and `LiveTranscriber` tails `audio.pcm` from byte 0. Tailing
the file rather than tapping the microphone thread is what makes starvation impossible in
principle rather than by discipline, and it handles `paused` for free: paused samples are
discarded and never written, so a reader following the file sees exactly the audio that exists.

`PARTIAL_WAKE_LOCK` is already held for the whole capture (`RecordingService.acquireWakeLock`,
6-hour cap), so no new wake lock is needed and the pass gets CPU with the screen off.

### 4.1 Two native handle APIs

Both copy the shape `nativeLlmLoad` / `nativeLlmGenerate` / `nativeLlmFree` already uses
(`cpp/jni/audionotes_jni.cpp:212-248`), which is the established pattern in this codebase for a
native object that outlives one call.

```
nativeVadOpen(modelPath, sampleRate) -> handle
nativeVadFeed(handle, pcmPath, fromByte, byteCount) -> LongArray   // spans CLOSED by this feed
nativeVadPendingSpanStartMs(handle) -> Long  // earliest span not yet released, or -1
nativeVadClose(handle)

nativeAsrOpen(modelPath, language) -> handle
nativeAsrDecodeRange(handle, pcmPath, startMs, endMs, threads) -> String
nativeAsrClose(handle)
```

`nativeVadPendingSpanStartMs` exists because chunk finality needs it, and §5 explains why. It
reports the earliest span the VAD knows about but has not handed over — either one it is still
inside, or one it has closed but is holding back to see whether the next span merges into it under
`speech_pad_ms`. Both are spans that can still join the previous chunk, and neither is visible in
the emitted list. Without this the live pass caches chunks the post-hoc pass never asks for.

`nativeVadFeed` reads a byte range from the file rather than accepting a buffer: the file is the
source of truth, the capture thread is the only writer, and passing ranges keeps the JNI surface
free of large array copies.

`SileroVad` already streams frame by frame internally — its own header says it "never loads the
whole file into RAM" — so the work here is exposing that loop with the `h`/`c` state retained
across calls, not writing a new VAD. Frames are 512 samples; as long as feeding starts at sample 0
and never skips, frame alignment and therefore the spans are identical to the whole-file run.

`nativeAsrDecodeRange` is the fix for the reload blocker: `nativeTranscribe` currently builds a
fresh engine per call (`cpp/jni/audionotes_jni.cpp:139`) and `WhisperAsr::Impl` loads the context
in its constructor (`cpp/asr/whisper_asr.cpp:62`), so the model is re-read from disk every time.

### 4.2 The cache

A new table in the SQLCipher database, following the `llm_notes` precedent already in `AudioDb`:

```sql
CREATE TABLE IF NOT EXISTS asr_cache(
  meeting_id TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  model      TEXT NOT NULL,
  segments   TEXT NOT NULL,   -- JSON: [{"t0":ms,"t1":ms,"text":"..."}], chunk-RELATIVE
  PRIMARY KEY(meeting_id, start_ms, end_ms, model)
);
```

`segments` holds a list, not a string, because `whisper_full` returns several timestamped
segments per chunk (`cpp/asr/whisper_asr.cpp:252-262`) and the transcript needs those timestamps.
They are stored chunk-relative, which is what makes the cached value a pure function of the
chunk's audio and nothing else. The text is stored **after** `normalizeSegmentText`, so a cache
hit yields the identical string the decode path would have pushed.

**In the database, not in loose files**, because chunk text is transcript content and everything
this app knows about a meeting is encrypted at rest. A cache of plaintext transcript fragments in
`filesDir` would be a hole in that claim, and the privacy screen (item 8) is a promise this
project keeps literally.

`model` is in the key so that changing or upgrading the weights invalidates every entry rather
than silently mixing two models' output in one transcript.

**Deleted when ASR completes**, and with the meeting. It is scaffolding, not a record: once
utterances exist, the cache's only remaining value is making a Redo faster, and Redo is both rare
and explicitly a request to recompute. Keeping it would leave a second copy of transcript text to
keep in sync, to honour in retention sweeps, to reason about in the privacy summary and to export
or not export. Deleting it is the smaller promise. Precedent: `AudioDb` line 748 does exactly
this for `llm_notes`.

## 5. Chunk finality — the core algorithm

The live pass must emit a chunk only once that chunk can no longer change, or it would cache a
value under a key the post-hoc pass never asks for.

`makeChunks` (`cpp/asr/asr_chunker.h`) packs spans greedily left to right, closing a window when
adding the next span would exceed the 30 s budget (`kChunkMs`) or when the gap to it exceeds
`kMaxMergeGapMs` (12 s). Both closing conditions depend only on spans already seen plus the *next*
span. A chunk is final once no future span could be packed into it, which is decidable from three
things: the released spans, the earliest span the VAD is still holding (if any), and how much audio has
been captured.

The budget cannot establish finality — it depends on where the next span *ends*, which is unknown
— so the gap is the only rule that certifies. That is fine: it is sufficient, and being
conservative here costs a little latency, never correctness.

```
tail  = 0                          // bytes of audio.pcm consumed
vad   = nativeVadOpen(vadModel, 16000)
asr   = nativeAsrOpen(whisperModel, language)
spans = []

while capture is live || tail < fileSize:
    if shouldBackOff():          sleep(5s); continue
    grown = fileSize - tail
    if grown < FEED_MS * 32:     sleep(1s); continue      // 32 bytes per ms

    spans += nativeVadFeed(vad, path, tail, grown)
    tail  += grown
    capturedMs = tail / 32

    for chunk in makeChunks(spans, 30000):
        if not final(chunk, spans, capturedMs):  continue
        if cache.has(meetingId, chunk, model):   continue
        cache.put(meetingId, chunk, model,
                  nativeAsrDecodeRange(asr, path, chunk.start_ms, chunk.end_ms, threads))

nativeAsrClose(asr); nativeVadClose(vad)

final(C, spans, capturedMs):
    // A closed span already exists past this chunk, so makeChunks closed C knowing about it.
    if any closed span S in spans with S.start_ms > C.end_ms:  return true

    // A span the VAD knows about but has not released: still mid-speech, or closed and held
    // back pending a merge. Its start is known, and that is exactly what the gap rule needs.
    // Someone still talking 12 s after the chunk ended would otherwise look like silence.
    pending = nativeVadPendingSpanStartMs(vad)
    if pending >= 0 and pending > C.end_ms:
        return (pending - C.end_ms) > kMaxMergeGapMs

    // Nothing open and nothing since: any future span must start after the capture frontier.
    return (capturedMs - C.end_ms) >= kMaxMergeGapMs
```

`FEED_MS = 10000` — large enough to amortise the JNI call, smaller than the 12 s lookahead so
finality is never the thing waiting. **Not tuned; a starting value.**

## 6. Threads, heat and memory

**Threads.** The post-hoc pass uses `inferenceThreadCount()` (big.LITTLE aware; 2 is optimal for
whisper-base on this hardware). The live pass starts at `max(1, inferenceThreadCount() - 1)` to
leave the capture thread guaranteed headroom. This is a *precaution, not a measurement* — the
device test in §9 must confirm capture is glitch-free, and if it is, the cap can be reconsidered.

**Backoff.** Checked between chunks, never mid-decode: pause below a battery threshold, or when
`PowerManager.getCurrentThermalStatus()` reports throttling; resume when it recovers. Because the
pass is only a cache, backing off costs speed and nothing else.

**Memory gate.** whisper resident during capture costs roughly 200 MB on top of the recording. If
free memory is tight, the live pass does not start at all. This is the same whole-or-skip question
`DiarBudget` already asks, and the same answer, for the same reason: degrading a capture to buy
speed is the wrong trade when the capture is the irreplaceable thing.

## 7. Every failure path degrades to today

| What goes wrong | What happens |
|---|---|
| Phone too slow to keep up | Fewer chunks cached; post-hoc decodes the remainder |
| Thermal or battery backoff | Same |
| Memory gate refuses to start | Live pass never runs; behaviour is exactly today's |
| Process killed mid-meeting | Cached chunks survive in the DB; capture resumes as it already does |
| Live VAD diverges from file VAD | Keys miss, everything decoded normally — a wrong result is not reachable |
| Meeting is in an unsupported language | Post-hoc refuses exactly as today; cache discarded unused |

The last row is the one genuine cost: a refused meeting wasted the live CPU. Accepted. Refusals
are rare, and the alternative is letting the live pass decide, which §2 rejects.

## 8. Explicitly out of scope

- **Anything on screen.** No live text on the record screen or the PiP pane. The founder chose an
  invisible accelerator, and that choice is what permits the 12 s lookahead that makes byte-exact
  chunk parity affordable. It also means no provisional text is ever shown to a user, so the live
  output is held to the same accuracy bar as the final output rather than a lower one.
- **Diarization during capture.** sherpa's offline diarization API takes the whole buffer and does
  segmentation, embedding and clustering as one unit; it cannot be fed incrementally. Cutting it
  into pieces is exactly what
  `docs/superpowers/specs/2026-09-06-windowed-diarization-design.md` measured and shelved at a cost
  of 6-7 DER points. The honest sequel is per-segment embeddings extracted during capture and
  clustered globally at the end — a separate spec.
- **Imported files.** They have no capture to run alongside.
- **Making the live spans canonical.** Considered: have the live pass commit its segments so
  `ResumePlan` skips `Stage.VAD` and cache hits are guaranteed. Rejected — a partial live pass
  would leave `hasSegments` true and the tail of the meeting unsegmented, the same trap as §2. VAD
  runs twice instead, costing ~1 minute on a 90-minute meeting, or about 1% of the saving. Worth
  it to leave the post-hoc pipeline literally untouched.

## 9. How this is verified

1. **Chunk finality equals the offline chunker.** Over the four AMI fixtures, feeding spans
   incrementally must emit exactly the chunk list `makeChunks` produces over the full span list —
   same boundaries, same order, no extras, none missing. This is the most important test in the
   plan; a bug here shows up as a silent cache miss, which looks like "the feature just is not very
   fast" rather than like a defect. **It must include the mid-span case explicitly** — a speaker
   still talking more than `kMaxMergeGapMs` after the previous chunk ended — because that is the
   case the first draft of this spec got wrong, and it is invisible without a fixture that has it.
2. **Streaming VAD equals whole-file VAD.** Same audio, same spans, on the same fixtures.
3. **Cache hit equals cache miss.** An `eval/run.py` pass with the cache pre-warmed against one
   cold, asserting the transcripts are **identical strings** — not that WER is close.
4. **Device: capture is not disturbed.** A real capture on the Pixel with the live pass running,
   checking the PCM byte count against elapsed time for dropped audio, and confirming the
   announcement check still passes (it reads the first 12 s from the capture loop and is the most
   timing-sensitive thing in the service).
5. **Device: the saving is real.** Measure post-stop wall clock on a long capture, against the
   ~107-minute baseline.
6. **A grep guard** in the spirit of `scripts/check-diar-constants.py`, failing the build if the
   live path ever writes utterance rows directly — the invariant of §2, and one that would be
   silent if broken.

## 10. What is weak about this

- **The A07 has never been measured for ASR realtime factor.** If whisper runs slower than 1.0x
  realtime there, the live pass on a cheap phone never catches up and the feature delivers little
  — correctly, but pointlessly. This does not endanger the design (§7), but it does bound the
  benefit, and the number is unknown. Measuring it is cheap and should happen early in the build.
- **The thermal and battery thresholds will be invented, not measured.** Like the announcement
  verifier's thresholds, they will come from one phone and should be logged every run so the next
  phone can contradict them.
- **The 200 MB figure for whisper resident during capture is an estimate**, not a measurement, and
  the memory gate's threshold depends on it.
- **Two VAD runs per meeting** is real waste, defended in §8 on partial-completion grounds. If
  streaming parity proves exact in testing, revisiting this is a legitimate follow-up.
