// Rule-based minutes — the deterministic Free-tier floor. No model, no network.
// C++ parity port of src/pipeline/minutes.ts (same discipline as MinutesExtractor.kt: match the
// JS exactly, oddities included — see the golden tests in cpp/tests/test_minutes.cpp).
#pragma once
#include <cstddef>
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

// Exposed for evidence.cpp, which adds provenance to the same rules rather than restating them.
// Not part of the public extractor contract; nothing else should call these.
//
// Everything here is byte-oriented and expects text that normalizeApostrophes has already been
// through: the patterns behind isAction/isDecision/... are std::regex over bytes and were written
// with a plain ASCII apostrophe, so a turn still carrying U+2019 matches nothing.
namespace rules {
// Byte length of the whitespace character starting at s[i], or 0 if there is not one there.
//
// "Whitespace" is JavaScript's /\s/, not C's isspace: it includes U+00A0, U+1680, U+2000-U+200A,
// U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. A byte-wise isspace() sees none of them, so a
// turn carrying a non-breaking space — the shape you get from text pasted out of a document —
// keeps it through splitSentences, and the resulting item text differs from the TypeScript's by
// one invisible character. cpp/tests/golden/evidence_spans.json has a row that catches exactly
// that.
std::size_t jsWhitespaceLen(const std::string& s, std::size_t i);

// JS: s.replace(/\s+/g, ' ').trim(). The needle-flattening in evidence.cpp must be the same
// function the sentence splitter used, or the two disagree about what a sentence looks like.
std::string collapseWhitespace(const std::string& s);

std::vector<std::string> splitSentences(const std::string& text);
std::string normalizeApostrophes(const std::string& s);
std::string norm(const std::string& s);
std::string detectOwner(const std::string& sentence, const std::string& speaker_name);
bool isAction(const std::string& sentence);
bool isQuestion(const std::string& sentence);
bool isDecision(const std::string& sentence);
bool matchDue(const std::string& sentence, std::string* out);
}  // namespace rules

}  // namespace audionotes
