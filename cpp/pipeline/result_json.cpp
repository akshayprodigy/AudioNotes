#include "pipeline/result_json.h"

#include "nlohmann/json.hpp"

namespace audionotes {

std::string resultToJson(const PipelineResult& res, const std::string& error) {
  using nlohmann::json;
  json doc;
  doc["audio_ms"] = res.audio_ms;
  doc["timings"] = {{"vad_ms", res.vad_ms}, {"asr_ms", res.asr_ms},
                    {"diar_ms", res.diar_ms}, {"minutes_ms", res.minutes_ms}};
  doc["segments"] = json::array();
  for (const auto& s : res.segments)
    doc["segments"].push_back({{"start_ms", s.start_ms}, {"end_ms", s.end_ms}});
  doc["transcript"] = json::array();
  for (const auto& u : res.transcript)
    doc["transcript"].push_back({{"start_ms", u.start_ms}, {"end_ms", u.end_ms},
                                 {"speaker", u.speaker}, {"text", u.text}});
  doc["minutes_source"] = res.minutes_source;
  doc["cancelled"] = res.cancelled;
  doc["minutes"] = json::array();
  for (const auto& m : res.minutes)
    doc["minutes"].push_back({{"kind", m.kind}, {"content", m.content}, {"source", m.source}});
  if (!error.empty()) doc["error"] = error;
  return doc.dump(1);
}

}  // namespace audionotes
