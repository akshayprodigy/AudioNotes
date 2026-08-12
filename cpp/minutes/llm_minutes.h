// LLM minutes enhancement — chunked map-reduce over the transcript. Parity port of
// src/pipeline/summarize.ts. Strictly best-effort: on generation/parse failure callers keep the
// rule-based minutes (the guaranteed floor). Takes an injected generate fn so it is testable
// without llama.
#pragma once
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "minutes/minutes_extractor.h"  // DraftMinute, MinuteUtt, MinuteSpk

namespace audionotes {

// (prompt, max_tokens) -> generated text. Wraps LlamaEngine::generate in production.
using GenerateFn = std::function<std::string(const std::string&, int)>;

std::vector<std::string> transcriptLines(const std::vector<MinuteUtt>& utterances,
                                         const std::vector<MinuteSpk>& speakers);
std::vector<std::string> chunkTranscript(const std::vector<std::string>& lines,
                                         size_t max_chars = 6000);
std::string mapPrompt(const std::string& chunk);
std::string reducePrompt(const std::string& notes);

// Returns std::nullopt when nothing parses / everything is placeholder — caller keeps the floor.
std::optional<std::vector<DraftMinute>> parseMinutesJson(const std::string& raw);

std::optional<std::vector<DraftMinute>> enhanceMinutes(const std::vector<MinuteUtt>& utterances,
                                                       const std::vector<MinuteSpk>& speakers,
                                                       const GenerateFn& generate);

}  // namespace audionotes
