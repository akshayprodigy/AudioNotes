// F24: a deterministic fact check on what the writer (the on-device LLM) wrote.
//
// The writer is a 1.5B model. Measured on a real phone (A07, 25 Sep) it states "$499/month or
// $3999/year" for "four ninety nine a month", writes a report as "sent out" when it was only
// promised, and invents an earlier schedule. Prompt wording shifts the odds of that and cannot make
// it never happen, so this makes the guarantee the way stripLabels and trimToSentence do: a pure
// function over the finished text, run before anything is stored.
//
// WHAT IT DOES. It reads the writer's text one sentence at a time, extracts the claims a reader
// would act on — numbers, currency amounts, dates, and status verbs that assert something is
// finished or has moved — and checks each against the transcript the writer was fed. A sentence
// with a claim the transcript does not support is dropped, and counted. Nothing is rewritten: a
// sentence is kept whole or removed whole, so no half-sentence is ever stored.
//
// WHAT IT DOES NOT DO, deliberately. It does not judge meaning. An invented non-numeric fact ("the
// client was unhappy") passes, because there is no deterministic way to check it. It is a floor
// under the three error classes measured so far, not a substitute for measuring the writer (see
// docs/superpowers/reports/2026-10-07-f24-writer-check.md).
//
// No model, no thresholds, no I/O: same inputs, same output, on the phone and on the Mac.
#pragma once
#include <string>
#include <vector>

namespace audionotes {

struct FactCheck {
  // The written text with every unsupported sentence removed. Byte-identical to the input when
  // nothing was dropped. Empty when every sentence went — the caller then stores nothing.
  std::string text;
  // How many sentences were removed.
  int dropped = 0;
  // Which claim classes removed them, distinct, in a fixed order: number, currency, date, status,
  // tense. A sentence with two failing claims contributes both classes and counts once in `dropped`.
  std::vector<std::string> classes;
};

// `transcript` is the plain text of the meeting — what the writer was shown, without speaker
// labels. For a long meeting the writer saw digests of it; the whole transcript is the right
// thing to hold them against, because it is the superset the digests were made from.
FactCheck checkWriterFacts(const std::string& written, const std::string& transcript);

// Exposed so the rules can be tested one at a time and so the eval harness can reuse them.
//
// Every number the text contains, each as the values it could mean. "forty" is {40}; "four ninety
// nine" is ambiguous in speech and is {499, 4.99}; "3,999" is {3999}. Spelled and digit forms of one
// number yield the same value, which is the whole point.
std::vector<std::vector<double>> spokenNumberCandidates(const std::string& text);

// The sentence splitter: a terminator followed by whitespace or the end, never inside "3.5" and
// not after a common abbreviation. Each piece keeps its own terminator, with no outer whitespace.
std::vector<std::string> splitSentences(const std::string& text);

}  // namespace audionotes
