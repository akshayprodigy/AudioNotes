#include "capi/audionotes_capi.h"

#include <new>
#include <string>

#include "nlohmann/json.hpp"
#include "pipeline/pipeline.h"
#include "pipeline/result_json.h"

struct an_result {
  std::string error;  // "" = success
  std::string json_doc;
};

extern "C" {

an_result* an_process(const an_options* opts, an_progress_fn progress, void* user) {
  an_result* r = new (std::nothrow) an_result;
  if (!r) return nullptr;
  try {
    audionotes::PipelineConfig cfg;
    cfg.asr_model = opts->asr_model ? opts->asr_model : "";
    cfg.vad_model = opts->vad_model ? opts->vad_model : "";
    cfg.diar_seg_model = opts->diar_seg_model ? opts->diar_seg_model : "";
    cfg.diar_emb_model = opts->diar_emb_model ? opts->diar_emb_model : "";
    cfg.llm_model = opts->llm_model ? opts->llm_model : "";
    cfg.num_speakers = opts->num_speakers;
    if (opts->sample_rate > 0) cfg.sample_rate = opts->sample_rate;
    cfg.asr_threads = opts->asr_threads;
    if (opts->llm_threads > 0) cfg.llm_threads = opts->llm_threads;

    audionotes::Pipeline pipeline(cfg);
    audionotes::PipelineResult res;
    audionotes::PipelineProgressFn cb;
    if (progress) {
      cb = [progress, user](const std::string& stage, int done, int total) {
        progress(stage.c_str(), done, total, user);
      };
    }
    const bool ok = pipeline.run(opts->pcm_path ? opts->pcm_path : "", &res, cb);
    if (!ok) r->error = pipeline.error().empty() ? "pipeline failed" : pipeline.error();
    r->json_doc = audionotes::resultToJson(res, r->error);
  } catch (const std::exception& e) {
    r->error = e.what();
    r->json_doc = nlohmann::json({{"error", r->error}}).dump(1);
  }
  return r;
}

const char* an_result_error(const an_result* r) {
  return r->error.empty() ? nullptr : r->error.c_str();
}
const char* an_result_json(const an_result* r) { return r->json_doc.c_str(); }
void an_result_free(an_result* r) { delete r; }

}  // extern "C"
