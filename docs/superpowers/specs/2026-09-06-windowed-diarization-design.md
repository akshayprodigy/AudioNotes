# Diarizing a ninety-minute meeting

**Written 6 September 2026.** Answers `docs/NEXT.md` §1 item 5.

**Outcome: windowing was built, measured, and SHELVED. The memory is handled by refusing the
meeting instead.** The record below is kept in full — the measurements are the reason, and the
honest next attempt starts from this code rather than a blank page.

| | DER | attribution |
|---|---|---|
| one pass over the whole meeting — **shipped** | **20.0** | **88.4** |
| windowed, round 1 (complete linkage, t=0.65) | 27.7 | 84.1 |
| windowed, round 2 (average linkage + cannot-link) | 26.2 | 81.5 |

An hour to ninety minutes is an ORDINARY meeting for this product — rooms full of people run over
in a way calls do not — so this is not an edge case whose speaker labels can be traded away. Six
DER points and seven points of attribution is too much to pay, and a speaker label that is
confidently wrong is worse than a slow one when it lands in a document people forward.

## The correction this starts from

Diarization was measured on 6 September as the one stage that cannot finish a long meeting: a
90-minute recording on a Pixel 7 Pro was still running after 47 minutes at **2.55 GB PSS**, having
evicted nine background apps, and was killed. The cause looked obvious and the code's own comment
agreed with it — `diarizer.cpp` read the *whole* recording, silence included, into a 346 MB float
vector, where ASR had always been restricted to the VAD speech spans.

So diarization was moved onto the spans. **That was the wrong fix for the stated problem, and the
measurement that says so is `eval/speech_fraction.py`:**

| fixture | length | padded speech covers | so skipping silence saves |
|---|---|---|---|
| ES2002a | 21.2 min | 73.4% | 26.6% |
| ES2002b | 38.0 min | 86.9% | 13.1% |
| IS1000a | 26.4 min | 73.0% | 27.0% |
| ES2003a | 19.0 min | 62.1% | 37.9% |

**Most of a real meeting is speech.** Skipping the silence saves 13–38%: a constant factor on a
cost that still grows linearly with the recording. A 90-minute meeting goes from 2.55 GB to roughly
1.9 GB, and a three-hour meeting fails exactly as before. The spans move the cliff; they do not
remove it.

They were still worth keeping, for a different reason than the one they were built for: with 500 ms
of real silence padded back at each boundary they *improved* accuracy — mean DER 20.4 → 20.0,
attribution 87.2 → 88.4 across the four AMI fixtures. That is what they are, and the comments in
`span_map.h` now say so.

## What was tried: windowing

**Diarize a fixed amount of speech at a time.** Ten minutes of padded speech is a 38 MB float
buffer whether the meeting ran twenty minutes or three hours; each window is read, diarized and
freed before the next is touched, so the peak follows the window and not the recording.

`windowSpans()` in `cpp/diar/span_map.h` does the cutting. Windows are filled greedily and a span
is never split merely to top one up — an under-full window costs nothing, while a cut costs
segmentation the acoustic context either side of it. A span longer than a whole window *is* cut,
because it has to be: an hour of continuous speech with no VAD gap (a lecture, a room too noisy for
the detector to drop out) would otherwise put the bound straight back. AMI never reaches that case
— its longest padded span is 229 s — which is exactly why it is tested.

**A meeting that fits one window takes the old path unchanged.** No embedding pass, no
reconciliation, byte-identical results. That is most meetings, and it means the new machinery
cannot regress the common case.

## The part that makes windows safe

Windows are the easy half. The hard half is that **sherpa clusters each window from scratch**, so
window 4's "speaker 0" has nothing to do with window 1's. Left alone, a 90-minute meeting between
four people comes back with thirty-odd speakers — not a degraded result but a wrong one, and wrong
attribution is the top diarization complaint in every review in this category.

So each window hands back one voice embedding per local speaker, taken from up to 30 s of that
speaker's longest turns, and those are clustered again with `clusterEmbeddings()` in
`cpp/diar/speaker_match.h`: the same metric (cosine dissimilarity), the same linkage (complete) and
the same cut rule that sherpa uses inside a window, so a distance means the same thing on both
sides of a window boundary. Complete linkage is not a detail — single linkage would chain two
speakers into one through a single ambiguous window.

A speaker with too little audio to embed comes back as a zero vector and is given **its own label**
rather than being merged. That direction is chosen deliberately: over-splitting shows an extra
speaker the user can merge by hand on the Speakers screen, while over-merging puts one person's
words in another's mouth, silently, in an exported document.

### The threshold is a separate constant, and it had to be measured

The obvious move was to reuse sherpa's within-window threshold of 1.0, which was swept for CAM++
over four AMI meetings and is a peak rather than a floor. **It is catastrophically wrong here:**
ES2002a came back at DER 65.7% and attribution 51.2% against 23.4% / 91.4% un-windowed, with four
speakers collapsed into one.

The reason is that the vectors are not the same kind of thing. sherpa clusters *per-segment*
embeddings, which spread far enough apart that different speakers land at negative cosine
similarity; these are *per-speaker averages*, and averaging pulls every vector toward the middle of
its own cluster. Dumping the pairwise distances for ES2002a showed them packed into 0.25–0.95 — all
below 1.0, so complete linkage merged the lot.

`kSpeakerMergeThreshold` is therefore its own constant with its own sweep, and `--diar-speaker-threshold`
exists so that sweep is a flag rather than a rebuild. On ES2002a, against an un-windowed control of
DER 23.4% / attribution 91.4%:

| threshold | DER | attribution | |
|---|---|---|---|
| 0.35 | 23.9% | 89.8% | under-merges |
| 0.45 | 23.9% | 89.8% | |
| 0.55 | 22.6% | 92.4% | plateau |
| **0.65** | **22.6%** | **92.4%** | **shipped** |
| 0.75 | 22.6% | 92.4% | plateau |
| 0.85 | 25.0% | 88.8% | degrading |
| 1.00 | 65.7% | 51.2% | collapse — sherpa's own value |

Two things there matter more than the winner. **The plateau beats diarizing the whole meeting at
once**, so windowing is not a memory concession paid for in accuracy — plausibly because a window's
clustering is not diluted by voices from forty minutes away. And the shipped value sits in the
middle of the plateau, a full step below where degradation starts, because the two failure
directions are not symmetric.

## The guard, for when even one window will not fit

Windowing bounds the peak; it does not make it small. Ten minutes of speech is still around 300 MB
once sherpa has made its own copies, and on a 4 GB phone with a browser open that is not always
there.

`DiarBudget` (Kotlin) reads what is actually free — `availMem` minus the `threshold` at which
Android starts evicting background processes — claims half of it, and picks the largest window that
fits, down to a floor of two minutes. Below that it returns 0 and **diarization is skipped with a
sentence stored on the meeting**, shown on the Meeting screen and cleared by any later run that
succeeds.

That trade is not close, but note which way it runs. Skipping should almost never happen: a phone
with memory gets speaker labels however long the meeting ran. When it does happen, the transcript,
the minutes and the narration all survive and the user adds speakers by hand. Being killed by the
OOM killer loses the meeting, because minutes and narration both run after this stage.

The peak-per-byte constant (8×) comes from one measurement on one phone — 346 MB of input against
2.55 GB of peak — and over-estimates, because the app, the models and whisper are all inside that
2.55 GB. For a guard that is the safe direction.

## What this deliberately does not do

**It does not window at all, by default.** `kDiarWindowMs` is 0 and `DiarBudget.WHOLE_MEETING` is
-1; `scripts/check-diar-constants.py` fails if either drifts, because that failure is silent — the
app keeps working and quietly starts labelling speakers less accurately than anything anybody
measured. `--diar-window-min` turns it on deliberately, which is how the table above is reproduced.

**It does not window when a fixed speaker count was asked for.** A cluster count is a statement
about the whole recording and no window can honour it; asking each window for four clusters when
two people speak in it invents two. Nothing in the app sets this — it exists for the CLI — so the
simple answer is the right one.

**It does not re-cluster per segment across windows.** That would reproduce the un-windowed result
most closely, at the cost of a second embedding pass over every segment, roughly doubling the
stage's time on a phone where it already runs at 0.64× realtime. Per-speaker averages plus a
measured threshold get within a point of it for a fraction of the cost; if that point ever matters,
this is the next thing to try.

**It does not change the whole-file path.** A caller that has not run VAD cannot say where the
speech is and so cannot cut anywhere that is not arbitrary. That path still reads everything into
one buffer, and its comment says what that costs.

**The window length itself was not swept.** Ten minutes comes from the memory arithmetic — 38 MB of
input, around 300 MB of peak — and not from a DER curve, so it is a defensible default rather than a
measured optimum. The trade it sits on is real in both directions: a shorter window bounds the peak
harder but gives each window's clustering fewer of a speaker's turns to work from. If diarization
quality ever needs another point, sweeping this is the cheapest place to look.

## Testing

| what | where |
|---|---|
| windows never exceed the budget, never lose or duplicate speech, never emit an empty window | `cpp/tests/test_span_map.cpp` |
| a span longer than a window is cut; one that merely does not fit is moved whole | `cpp/tests/test_span_map.cpp` |
| the same voice in two windows is one speaker; opposed voices are two | `cpp/tests/test_speaker_match.cpp` |
| complete linkage does not chain A to C through B | `cpp/tests/test_speaker_match.cpp` |
| an un-embeddable speaker keeps its own label rather than being swallowed | `cpp/tests/test_speaker_match.cpp` |
| the budget is monotonic, bounded both ends, and never returns an unusable window | `DiarBudgetTest.kt` |
| the shipped path still scores DER 20.0 / attribution 88.4 on four AMI meetings | `eval/run.py` |
| windowing stays off in both languages | `scripts/check-diar-constants.py`, wired into ctest |
| a 90-minute meeting on a real phone completes and keeps its speakers | on device, by hand |

The last row is the one that matters and it is not automatable. An hour and a half is an ordinary
meeting here, so "it finishes, with speaker labels, on hardware somebody owns" is the acceptance
criterion — not a DER number.
