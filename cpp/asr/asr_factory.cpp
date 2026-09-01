#include "asr/asr_engine.h"

#include "asr/qwen3_asr.h"
#include "asr/whisper_asr.h"

#include <cstdio>
#include <utility>

namespace audionotes {
namespace {

// An engine that failed to become available, so callers have ONE failure path instead of a null
// check plus an ok() check.
class UnavailableAsr : public AsrEngine {
 public:
  explicit UnavailableAsr(std::string why) : why_(std::move(why)) {}
  bool ok() const override { return false; }
  const char* name() const override { return "none"; }
  int64_t maxChunkMs() const override { return 30000; }
  ChunkMode chunkMode() const override { return ChunkMode::kPack; }
  bool supports(const std::string&) const override { return false; }
  std::string unavailableReason() const override { return why_; }
  AsrRun transcribe(const std::string&, const std::vector<Segment>&, int, int,
                    const AsrProgressFn&, const AsrCancelFn&) override {
    AsrRun r;
    r.engine = "none";
    r.detected_language = why_;
    return r;
  }

 private:
  std::string why_;
};

// Which engine wins for a language, when both are installed.
//
// This is a table and not a heuristic on purpose: a routing decision that cannot be read off the
// page is one nobody can audit when a meeting comes back wrong. Rows are added only when
// MEASURED — CJK is a plausible Qwen win and is deliberately absent until somebody scores it.
//
// hi: Qwen3-ASR read the 2026-08-19 recording at 1,211 words and 87.6% Devanagari against
// whisper-base's 891 and 8.8%, with Urdu-script junk down from 21.1% to 1.0%.
bool prefersQwen(const std::string& language) {
  return language == "hi";
}

}  // namespace

std::unique_ptr<AsrEngine> makeAsrEngine(const AsrConfig& cfg) {
  const bool force_whisper = cfg.engine == "whisper";
  const bool force_qwen = cfg.engine == "qwen3";
  if (!cfg.engine.empty() && !force_whisper && !force_qwen) {
    return std::unique_ptr<AsrEngine>(new UnavailableAsr("unknown engine: " + cfg.engine));
  }

  const bool want_qwen = force_qwen || (!force_whisper && prefersQwen(cfg.language));

  if (want_qwen && !cfg.qwen3_model_dir.empty()) {
    std::unique_ptr<Qwen3Asr> q(new Qwen3Asr(cfg.qwen3_model_dir, cfg.language));
    if (q->ok()) return std::unique_ptr<AsrEngine>(q.release());
    // Fall through rather than fail: a Hindi meeting transcribed by whisper because Qwen was not
    // downloaded is a worse transcript but a real one, and AsrRun.engine records which ran.
    std::fprintf(stderr, "qwen3 unavailable at %s, falling back\n", cfg.qwen3_model_dir.c_str());
  }
  if (force_qwen) {
    // An explicitly requested engine does NOT silently degrade. A benchmark that quietly measured
    // the other engine would be worse than one that failed.
    return std::unique_ptr<AsrEngine>(new UnavailableAsr("qwen3 requested but unavailable"));
  }

  if (cfg.whisper_model.empty()) {
    return std::unique_ptr<AsrEngine>(new UnavailableAsr("no whisper model configured"));
  }
  return std::unique_ptr<AsrEngine>(new WhisperAsr(cfg.whisper_model, cfg.language));
}

}  // namespace audionotes
