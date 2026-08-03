# Milestone 5 — On-device LLM minutes enhancement (Qwen / llama.cpp)

**Goal (BUILD_PLAN §9):** upgrade the minutes with an on-device LLM (Pro tier) — better summary,
cleaner owners/actions — while keeping the rule-based floor as the guaranteed fallback. Never a
dependency: if anything fails, the deterministic minutes stay.

## What was implemented

**llama.cpp engine** (`cpp/llm/llama_engine.{h,cpp}`)
- Loads a Qwen GGUF **once** and reuses it across `generate()` calls (ChatML prompt, low temp for
  factual output, KV cache cleared per call so map/reduce steps are independent).
- Behind a `HAVE_LLAMA` guard — the project compiles before llama.cpp is vendored. Both code paths
  were compile-checked here against a stub header.

**LlmModule** (`android/.../pipeline/LlmModule.kt`, `src/native/NativeLlm.ts`)
- Handle-based JNI (`nativeLlmLoad/Generate/Free`). `available()` (model downloaded), `capable()`
  (**≥ 3 GB RAM** gate via ActivityManager), `load()/generate()/unload()`. Generation runs off the
  UI thread.

**Map-reduce summarizer** (`src/pipeline/summarize.ts`)
- Splits the transcript into ~6k-char chunks. For long meetings: **map** (summarize each chunk) →
  **reduce** (merge into final JSON minutes). Short meetings: single reduce pass. This is required —
  mobile RAM/context can't one-shot a long meeting.
- Parses the model's JSON leniently (extracts the first `{…}` block); returns `null` if it can't,
  which makes the caller keep the rule-based minutes. Orchestration is in JS (testable); only token
  generation is native.

**Pipeline** (`PipelineController`)
- `process()` now: native VAD→ASR→diarize → **rule-based minutes (always)** → **LLM enhancement
  (best-effort)**. `enhanceMinutes()` only runs if the device is capable and the Qwen model is
  installed; on any error it silently leaves the floor in place. It never throws.

## Tests

`__tests__/summarize.test.ts` covers transcript rendering, chunking, JSON parsing (incl. `n/a` due
handling and garbage→null), and the single-pass + multi-chunk map-reduce paths with an injected fake
`generate`. Validated headlessly here; run in the project with `npm test`.

## What you must provide before it runs

1. **Vendor llama.cpp** (built automatically when present):
   ```bash
   git submodule add https://github.com/ggerganov/llama.cpp cpp/third_party/llama.cpp
   ```
   **Version note:** llama.cpp's API changes often. `llama_engine.cpp` targets a recent (2025)
   release (`llama_model_load_from_file`, `llama_init_from_model`, the `llama_sampler` chain,
   `llama_kv_self_clear`). If you pin an older commit, adjust those symbol names to match — this is
   the main integration work. The rest of the app is unaffected because enhancement is best-effort.
2. **Download the Qwen model** in Settings ("Qwen2.5 1.5B Instruct (Q4_K_M)", ~1.1 GB). Swap to a
   Qwen3 GGUF in `ModelCatalog.kt` when you settle on one (both Apache-2.0).

## Smoke test

1. On a ≥3 GB-RAM device, download the Qwen model.
2. Record a few minutes with decisions/actions/questions, Stop.
3. The Meeting screen first shows rule-based minutes, then (after a beat) they upgrade to the LLM
   version — a real summary sentence and cleaner action items. On a weak device or with no model,
   you simply keep the rule-based minutes.
4. Airplane mode (after download): still fully offline.

## Notes & limits

- The RAM gate is a coarse proxy; measure real latency/thermal on a mid-range device and tune the
  threshold (and consider 1.7B vs 4B) accordingly.
- The reduce step asks for strict JSON; small models occasionally wander — that's exactly why the
  parser fails safe to the rule-based floor.

## Next

- Milestone 6: search + export polish (share-sheet Markdown/SRT via a FileExport module,
  onboarding/consent copy) → **Free + Pro launch**.
- Then iOS port (M7) and the Deep server tier (M8).
