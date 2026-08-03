# Milestone 4 — Diarization + speaker labelling/merge

**Goal (BUILD_PLAN §9):** know *who* spoke, and give the user a reliable way to correct it — the
diarization accuracy risk is mitigated by a manual fallback, not by trusting the model. Full cycle:
record → VAD → transcript → **speaker-attributed transcript** → minutes with real owners.

## What was implemented

**Diarization** (`cpp/diar/diarizer.{h,cpp}`, JNI `nativeDiarize`)
- Wraps the sherpa-onnx offline speaker-diarization C API (pyannote segmentation + speaker
  embedding + fast clustering). Reads the whole PCM file, returns `[start_ms, end_ms, speaker]`
  segments. `numSpeakers = 0` → automatic (threshold) clustering.
- Behind a `HAVE_SHERPA` guard: the project compiles before sherpa-onnx is vendored; `process()`
  throws a clear "not compiled in" error until then. Both the disabled and enabled code paths were
  compile-checked here.

**Alignment** (`AudioDb.assignSpeakers`)
- Creates one speaker row per cluster ("Speaker 1", "Speaker 2", …) and assigns each utterance the
  cluster with the greatest **temporal overlap**. Runs in one transaction.

**Pipeline** (`AudioPipelineModule.process`)
- After ASR, if the diarization models are installed and a transcript exists, it diarizes, assigns
  speakers, advances status to `diarized`, and emits `diarize` progress. Then the JS minutes step
  resolves first-person action owners to the actual speaker labels.

**Speakers screen** (`src/screens/SpeakersScreen.tsx`)
- Tap a speaker to make it the **merge target** (highlighted). **Rename** inline. **Merge** any
  other cluster into the target (updates every utterance, drops the merged row). **Regenerate
  minutes** re-derives owners from the corrected labels.
- The Meeting transcript now shows speaker **names** instead of raw ids.

**ModelCatalog** — added `diar-seg` (pyannote segmentation) and `diar-emb` (speaker embedding),
both single `.onnx` downloads. VERIFY the pyannote-derived checkpoint's license individually before
shipping (sherpa-onnx being Apache-2.0 does not cover every model weight it can load).

## What you must provide before it runs

1. **Vendor sherpa-onnx** (built automatically when present):
   ```bash
   git submodule add https://github.com/k2-fsa/sherpa-onnx cpp/third_party/sherpa-onnx
   ```
   Integration note: sherpa-onnx must build against the **same** ONNX Runtime we already link via
   the `onnxruntime-android` prefab. If the CMake add_subdirectory tries to fetch its own ORT,
   point sherpa's ORT variables at the prefab dir (see comments in `cpp/CMakeLists.txt`). This is
   the one integration knob to resolve on-device.
2. **Download the two diarization models** in Settings (`diar-seg`, `diar-emb`) — needs network once.

## Smoke test

1. Record a real 2–4 person conversation (≥30 s), Stop.
2. Meeting shows the transcript with per-line speaker names; owners in action items are populated.
3. Open **Speakers**: rename "Speaker 1" → a real name; if one person got split into two clusters,
   merge them; tap **Regenerate minutes** and confirm owners update.
4. Airplane mode (after models downloaded): the whole cycle still runs offline.

## Notes & limits

- Diarization loads the whole meeting's audio into RAM (≈115 MB for 30 min). Fine for the MVP;
  a future pass can stream it if long meetings pressure memory on low-end devices.
- Accuracy on real 4-person in-person audio is the known risk — measure it on device now that the
  manual merge/rename fallback exists. Enrollment mode is a later enhancement.

## Next

- Milestone 5: on-device Qwen3 (llama.cpp) to *enhance* minutes (summary prose, cleaner owners/actions),
  chunked map-reduce for long meetings, with the rule-based floor as the guaranteed fallback.
- Milestone 6: search + export polish → Free + Pro launch.
