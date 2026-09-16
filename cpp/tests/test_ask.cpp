// Ask this meeting: the prompt is fenced and numbered; an answer must cite or it is nothing.
#include "minutes/ask.h"

#include <cstdio>
#include <string>
#include <vector>

using namespace audionotes;

// Not assert(): this target is built Release, where NDEBUG compiles every assert away.
static int failures = 0;
#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                          \
    }                                                                      \
  } while (0)

static std::vector<AskPassage> passages() {
  return {{"Priya", 5000, "Can you send the proposal Friday?"},
          {"Rahul", 6500, "Only a draft; the final version needs another week."},
          {"Priya", 9000, "Fine, a draft then."}};
}

static void promptIsNumberedStampedAndFenced() {
  const std::string p = askPrompt("did we agree on a date for the proposal?", passages());
  CHECK(p.find("[1] Priya (0:05): Can you send the proposal Friday?") != std::string::npos);
  CHECK(p.find("[2] Rahul (0:06): Only a draft") != std::string::npos);
  CHECK(p.find("[3] Priya (0:09): Fine, a draft then.") != std::string::npos);
  // Both the passages and the question went through the fence: two preambles.
  size_t first = p.find("RECORD OF A MEETING");
  CHECK(first != std::string::npos);
  CHECK(first != std::string::npos && p.find("RECORD OF A MEETING", first + 1) != std::string::npos);
  CHECK(p.find("did we agree on a date") != std::string::npos);
  CHECK(p.find(kAskNothing) != std::string::npos);  // the model is told the refusal phrase
  CHECK(p.find("at most three sentences") != std::string::npos);
}

static void stampsPastAnHourReadLikeTheScreen() {
  const std::string p = askPrompt("q", {{"A", 3725000, "late"}});
  CHECK(p.find("[1] A (1:02:05): late") != std::string::npos);
}

static void validatorKeepsInRangeCitesInFirstMentionOrder() {
  const AskAnswer a = validateAnswer("A draft goes Friday [2][1]; the final needs a week [2].", 3);
  CHECK(!a.nothing);
  CHECK(a.cites.size() == 2 && a.cites[0] == 2 && a.cites[1] == 1);
  CHECK(a.text == "A draft goes Friday [2][1]; the final needs a week [2].");
}

static void validatorStripsOutOfRangeCites() {
  const AskAnswer a = validateAnswer("Friday [9], said Rahul [1].", 3);
  CHECK(a.text == "Friday, said Rahul [1].");
  CHECK(a.cites.size() == 1 && a.cites[0] == 1);
  CHECK(!a.nothing);
  const AskAnswer z = validateAnswer("Zero is not a passage [0] but two is [2]", 3);
  CHECK(z.text == "Zero is not a passage but two is [2]");
}

static void noCitationIsNothing() {
  CHECK(validateAnswer("They agreed on Friday.", 3).nothing);
  CHECK(validateAnswer("Friday [7].", 3).nothing);
  CHECK(validateAnswer("", 3).nothing);
  CHECK(validateAnswer("[1]", 0).nothing);  // no passages at all: nothing can be cited
}

static void theRefusalPhraseIsNothingEvenWithACite() {
  CHECK(validateAnswer(std::string(kAskNothing) + " [1]", 3).nothing);
}

static void bracketsThatAreNotCitesAreLeftAlone() {
  const AskAnswer a = validateAnswer("The [draft] goes Friday [1] (see [2b]).", 3);
  CHECK(a.text == "The [draft] goes Friday [1] (see [2b]).");
  CHECK(a.cites.size() == 1 && a.cites[0] == 1);
}

int main() {
  promptIsNumberedStampedAndFenced();
  stampsPastAnHourReadLikeTheScreen();
  validatorKeepsInRangeCitesInFirstMentionOrder();
  validatorStripsOutOfRangeCites();
  noCitationIsNothing();
  theRefusalPhraseIsNothingEvenWithACite();
  bracketsThatAreNotCitesAreLeftAlone();
  if (failures) {
    std::fprintf(stderr, "test_ask: %d failure(s)\n", failures);
    return 1;
  }
  std::puts("test_ask: ok");
  return 0;
}
