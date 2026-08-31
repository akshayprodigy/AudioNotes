// Rule-based minutes — the deterministic Free-tier floor. No model, no network.
// C++ parity port of src/pipeline/minutes.ts (same discipline as MinutesExtractor.kt: match the
// JS exactly, oddities included — see the golden tests in cpp/tests/test_minutes.cpp).
#pragma once
#include <string>
#include <vector>

namespace audionotes {

struct DraftMinute {
  std::string kind;     // summary | decision | action | question
  std::string content;
  std::string source;   // "rule" here; "llm" from llm_minutes
};

struct MinuteUtt {      // minimal utterance fields the extractor needs
  std::string text;
  std::string speaker_id;  // "" = none
};
struct MinuteSpk {
  std::string id;
  std::string display_name;
};

std::vector<DraftMinute> extractMinutes(const std::vector<MinuteUtt>& utterances,
                                        const std::vector<MinuteSpk>& speakers = {});

// The overview line at the top of the rule minutes — the free tier's summary, and the first thing
// in an exported document. Exposed so the golden tests can exercise it directly; the inputs are
// the already-trimmed content strings, in the order they appear in the minutes.
std::string composeSummary(const std::vector<std::string>& decisions,
                           const std::vector<std::string>& actions,
                           const std::vector<std::string>& questions);

}  // namespace audionotes
