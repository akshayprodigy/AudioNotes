#include "pipeline/pipeline.h"

#include "asr/whisper_asr.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <map>

#include "llm/llama_engine.h"
#include "minutes/llm_minutes.h"

namespace audionotes {
namespace {

int64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

int64_t pcmDurationMs(const std::string& pcm_path, int sample_rate) {
  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return 0;
  std::fseek(f, 0, SEEK_END);
  long bytes = std::ftell(f);
  std::fclose(f);
  if (bytes <= 0) return 0;
  return static_cast<int64_t>(bytes) / 2 * 1000 / sample_rate;
}

}  // namespace

std::vector<AlignedUtterance> alignSpeakers(const std::vector<Utterance>& utts,
                                            const std::vector<DiarSegment>& diar) {
  std::vector<AlignedUtterance> out;
  out.reserve(utts.size());
  for (const auto& u : utts) {
    std::map<int, int64_t> overlap;  // cluster -> summed ms (AudioDb.kt:275-279)
    for (const auto& d : diar) {
      const int64_t ov = std::min(u.end_ms, d.end_ms) - std::max(u.start_ms, d.start_ms);
      if (ov > 0) overlap[d.speaker] += ov;
    }
    int best = -1;
    int64_t best_ov = 0;
    for (const auto& [spk, ov] : overlap) {
      if (ov > best_ov) { best = spk; best_ov = ov; }
    }
    out.push_back({u.start_ms, u.end_ms, best, u.text});
  }
  return out;
}

std::vector<MinuteSpk> speakerNames(const std::vector<AlignedUtterance>& transcript) {
  std::map<int, bool> used;  // ordered -> ascending cluster index
  for (const auto& u : transcript)
    if (u.speaker >= 0) used[u.speaker] = true;
  std::vector<MinuteSpk> out;
  int n = 1;
  for (const auto& [cluster, _] : used) {
    out.push_back({"S" + std::to_string(cluster), "Speaker " + std::to_string(n)});
    ++n;
  }
  return out;
}

bool Pipeline::run(const std::string& pcm_path, PipelineResult* out,
                   const PipelineProgressFn& progress, const PipelineCancelFn& cancel) {
  auto report = [&progress](const char* stage, int done, int total) {
    if (progress) progress(stage, done, total);
  };
  // Checked before each stage. Sets out->cancelled and unwinds via `return true` — a cancel is a
  // legitimate outcome, not a failure, and the partial result is kept for the caller to discard.
  auto cancelled = [&cancel, out] {
    if (cancel && cancel()) {
      out->cancelled = true;
      return true;
    }
    return false;
  };
  if (cancelled()) return true;
  // An unreadable input is a setup error, not "no speech": without this, a bad path sails
  // through every stage (0 segments -> ASR skipped) and reports an empty success that callers
  // can't tell apart from a genuinely silent recording.
  if (FILE* f = std::fopen(pcm_path.c_str(), "rb")) {
    std::fclose(f);
  } else {
    error_ = "cannot open pcm: " + pcm_path;
    return false;
  }
  out->audio_ms = pcmDurationMs(pcm_path, cfg_.sample_rate);

  // ---- VAD (or fixed 30 s windows when no model is configured) ----
  {
    const int64_t t0 = nowMs();
    report("vad", 0, 1);
    if (!cfg_.vad_model.empty()) {
      try {
        SileroVad vad(cfg_.vad_model, cfg_.sample_rate);
        out->segments = vad.process(pcm_path);
      } catch (const std::exception& e) {
        error_ = std::string("vad: ") + e.what();
        return false;
      }
    } else {
      for (int64_t s = 0; s < out->audio_ms; s += 30000)
        out->segments.push_back({s, std::min<int64_t>(s + 30000, out->audio_ms)});
    }
    out->vad_ms = nowMs() - t0;
    report("vad", 1, 1);
  }

  if (cancelled()) return true;

  // ---- ASR ----
  std::vector<Utterance> utts;
  if (!out->segments.empty()) {
    const int64_t t0 = nowMs();
    WhisperAsr asr(cfg_.asr_model, cfg_.language);
    if (!asr.ok()) {
      error_ = "asr: failed to load model " + cfg_.asr_model;
      return false;
    }
    AsrRun asr_run = asr.transcribe(
        pcm_path, out->segments, cfg_.sample_rate, cfg_.asr_threads,
        [&report](int done, int total) { report("asr", done, total); },
        cancel ? AsrCancelFn(cancel) : nullptr);
    // Decoding that failed on every window is not a quiet room, and must not be reported as one.
    if (asr_run.allChunksFailed()) {
      error_ = "asr: every chunk failed to decode (" +
               std::to_string(asr_run.chunks_failed) + "/" +
               std::to_string(asr_run.chunks_total) + ")";
      return false;
    }
    utts = std::move(asr_run.utterances);
    out->asr_ms = nowMs() - t0;
    // A mid-ASR cancel leaves a partial transcript; stop rather than diarize and mint minutes
    // from half a meeting.
    if (cancelled()) return true;
  }

  // ---- Diarize (optional, best-effort — parity with ProcessingEngine's "skipped" path) ----
  std::vector<DiarSegment> diar;
  if (!utts.empty() && !cfg_.diar_seg_model.empty() && !cfg_.diar_emb_model.empty()) {
    const int64_t t0 = nowMs();
    report("diarize", 0, 1);
    try {
      Diarizer d(cfg_.diar_seg_model, cfg_.diar_emb_model, cfg_.sample_rate,
                 cfg_.num_speakers, cfg_.diar_threshold);
      if (d.ok()) diar = d.process(pcm_path);
    } catch (const std::exception&) {
      // Best-effort: a diarization failure never sinks a good transcript.
    }
    out->diar_ms = nowMs() - t0;
    report("diarize", 1, 1);
  }

  if (cancelled()) return true;

  out->transcript = alignSpeakers(utts, diar);

  // ---- Minutes: rule items always, LLM prose on top ----
  //
  // The LLM used to REPLACE the rule minutes wholesale. It should not: the rules are extractive and
  // every item quotes something that was said (measured invented=0 across four AMI fixtures), while
  // a 1.5B model writing abstractively carries no such guarantee. On the real NeoSym recording the
  // rules found 7 actions with quotes and the LLM returned 2, with "After uploading the file" in
  // both due-date fields — and the 7 were deleted to keep the 2.
  //
  // So the split is by what each is good at: rules own the list items, the LLM owns the prose it
  // alone can write. This mirrors what ProcessingEngine + Narrator do on device, which is the
  // point — the eval harness must score the configuration that ships, not a different one.
  if (!out->transcript.empty()) {
    const int64_t t0 = nowMs();
    report("minutes", 0, 1);
    const auto speakers = speakerNames(out->transcript);
    std::vector<MinuteUtt> mutts;
    mutts.reserve(out->transcript.size());
    for (const auto& u : out->transcript)
      mutts.push_back({u.text, u.speaker >= 0 ? "S" + std::to_string(u.speaker) : ""});

    out->minutes = extractMinutes(mutts, speakers);
    out->minutes_source = "rule";

    if (!cfg_.llm_model.empty()) {
      LlamaEngine llm;
      // greedy=true: minutes that change between two runs of the same recording are not minutes.
      // The eval harness has always judged greedy output, while this path sampled at temperature
      // 0.3 — so every score the harness reported described something the user never saw. Two runs
      // over the NeoSym fixture on 2026-08-26 produced completely different summaries.
      // repeat_penalty 1.15: greedy decoding over a repetitive transcript loops. Measured on the
      // NeoSym recording, the map step emitted one line forty times and the minutes built on those
      // notes were worthless.
      if (llm.load(cfg_.llm_model, cfg_.llm_n_ctx, cfg_.llm_threads, /*greedy=*/true,
                   /*repeat_penalty=*/1.15f)) {
        const auto n = narrate(mutts, speakers, [&llm](const std::string& p, int t) {
          return llm.generate(p, t);
        });
        // Prose goes in front of the extracted items — summary first is the whole point of the
        // screen it feeds. A failed generation leaves the rule floor exactly as it was.
        std::vector<DraftMinute> prose;
        if (!n.summary.empty()) prose.push_back({"summary", n.summary, "llm"});
        if (!n.narrative.empty()) prose.push_back({"narrative", n.narrative, "llm"});
        if (!n.headline.empty()) prose.push_back({"headline", n.headline, "llm"});
        if (!prose.empty()) {
          // Drop the rules' own "summary" row: it is a count ("7 action items, 0 decisions") and
          // the LLM's replaces it. Every other rule item stays.
          for (const auto& m : out->minutes) {
            if (m.kind != "summary") prose.push_back(m);
          }
          out->minutes = std::move(prose);
          out->minutes_source = "rule+llm";
        }
      }
    }
    out->minutes_ms = nowMs() - t0;
    report("minutes", 1, 1);
  }

  return true;
}

}  // namespace audionotes
