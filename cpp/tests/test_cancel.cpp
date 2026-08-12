// Cancellation across the orchestrator and the C ABI.
//
// Android's ProcessingEngine cancels a long run from another thread (a @Volatile flag checked
// between stages); the core has to offer the same, and a cancelled run must be distinguishable
// from both success and failure. Every case below uses deliberately BOGUS model paths: if
// cancellation is honoured we bail before any model is touched, so reaching a model load at all
// shows up as an error and fails the test.
#include "capi/audionotes_capi.h"
#include "pipeline/pipeline.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

static int failures = 0;
#define CHECK(cond, ...)                                        \
  do {                                                          \
    if (!(cond)) {                                              \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                        \
      std::fprintf(stderr, "\n");                               \
      ++failures;                                               \
    }                                                           \
  } while (0)

namespace {

// 1 s of 16 kHz mono PCM16 silence — enough for the pipeline to consider it real audio.
std::string writeTempPcm() {
  const std::string path = "/tmp/audionotes_cancel_test.pcm";
  std::ofstream f(path, std::ios::binary);
  const std::vector<int16_t> silence(16000, 0);
  f.write(reinterpret_cast<const char*>(silence.data()),
          static_cast<std::streamsize>(silence.size() * sizeof(int16_t)));
  return path;
}

int cancelAlways(void*) { return 1; }

}  // namespace

int main() {
  const std::string pcm = writeTempPcm();

  // Already-cancelled before the first stage: no work, no error, flagged cancelled.
  {
    audionotes::PipelineConfig cfg;
    cfg.asr_model = "/nonexistent-model.bin";
    audionotes::Pipeline p(cfg);
    audionotes::PipelineResult res;
    const bool ok = p.run(pcm, &res, nullptr, [] { return true; });
    CHECK(ok, "a cancelled run is not a failure; run() returned false");
    CHECK(res.cancelled, "result.cancelled must be set");
    CHECK(p.error().empty(), "cancelled run must not set an error, got '%s'", p.error().c_str());
    CHECK(res.transcript.empty(), "cancelled-before-start must produce no transcript");
  }

  // Cancel observed on a later poll: still stops before ASR loads the bogus model.
  {
    audionotes::PipelineConfig cfg;
    cfg.asr_model = "/nonexistent-model.bin";
    audionotes::Pipeline p(cfg);
    audionotes::PipelineResult res;
    int polls = 0;
    const bool ok = p.run(pcm, &res, nullptr, [&polls] { return ++polls >= 2; });
    CHECK(ok, "late cancel must not be reported as failure");
    CHECK(res.cancelled, "late cancel must set result.cancelled");
    CHECK(p.error().empty(), "late cancel must not set an error, got '%s'", p.error().c_str());
    CHECK(polls >= 2, "cancel predicate should be polled between stages (polls=%d)", polls);
  }

  // A run with no cancel predicate still behaves as before (bogus model -> real error).
  {
    audionotes::PipelineConfig cfg;
    cfg.asr_model = "/nonexistent-model.bin";
    audionotes::Pipeline p(cfg);
    audionotes::PipelineResult res;
    const bool ok = p.run(pcm, &res, nullptr, nullptr);
    CHECK(!ok, "no-cancel run with a bogus model must still fail");
    CHECK(!res.cancelled, "a failed run is not a cancelled run");
  }

  // C ABI: cancellation crosses the boundary and is readable without parsing JSON.
  {
    an_options opts;
    std::memset(&opts, 0, sizeof opts);
    opts.pcm_path = pcm.c_str();
    opts.asr_model = "/nonexistent-model.bin";
    an_result* r = an_process(&opts, nullptr, cancelAlways, nullptr);
    CHECK(r != nullptr, "an_process returned NULL");
    if (r) {
      CHECK(an_result_error(r) == nullptr, "cancelled run must report no error, got '%s'",
            an_result_error(r) ? an_result_error(r) : "");
      CHECK(an_result_cancelled(r) == 1, "an_result_cancelled must be 1");
      const char* js = an_result_json(r);
      CHECK(js && std::strstr(js, "\"cancelled\""), "result JSON must carry a cancelled flag");
      an_result_free(r);
    }
  }

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_cancel OK\n");
  return 0;
}
