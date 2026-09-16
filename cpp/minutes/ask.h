// Ask this meeting: the prompt a question is asked with, and what the answer must satisfy.
//
// The model is handed at most eight numbered passages and may answer only from them, citing
// each claim as [n]. An answer with no valid citation is not shown as an answer — the validator
// turns it into "nothing", and the screen shows the closest passages instead. The model can
// point; it cannot assert.
#pragma once
#include <string>
#include <vector>

namespace audionotes {

struct AskPassage {
  std::string speaker;
  long start_ms;
  std::string text;
};

struct AskAnswer {
  std::string text;        // the answer, out-of-range citations removed
  std::vector<int> cites;  // unique, in order of first mention, all within 1..n
  bool nothing;            // no citation survived, or the model said the refusal phrase
};

// What the model is told to write when the passages do not answer, and what the validator treats
// as "no answer" when it reads it.
extern const char* const kAskNothing;

// The passages numbered [1]..[n] — "[n] Speaker (m:ss): words" — and the question, both through
// the fence so nothing quoted can read as an instruction; then the rules: at most three
// sentences, from the passages only, cite each claim, or write kAskNothing.
std::string askPrompt(const std::string& question, const std::vector<AskPassage>& passages);

// Citations outside 1..n_passages are removed from the text (with one preceding space, if any);
// an answer then left without a citation, or that contains kAskNothing, is `nothing`.
AskAnswer validateAnswer(const std::string& text, int n_passages);

}  // namespace audionotes
