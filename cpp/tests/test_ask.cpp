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

// Measured on the Pixel, 17 Sep: the 1.5B writer copied the numbered passages back out before
// answering — "[4] Speaker 1 (0:08): Good morning everyone…" — then answered underneath. The
// passages are the person's transcript; they are not an answer, and they are removed.
static void echoedPassagesAreStripped() {
  const AskAnswer a = validateAnswer(
      "[1] Priya (0:05): Can you send the proposal Friday?\n"
      "[2] Rahul (0:06): Only a draft; the final version needs another week.\n\n"
      "Based on these passages, a draft goes Friday and the final needs another week [2].", 3);
  CHECK(!a.nothing);
  CHECK(a.text == "Based on these passages, a draft goes Friday and the final needs another week [2].");
  CHECK(a.cites.size() == 1 && a.cites[0] == 2);
}

static void anAnswerThatIsOnlyEchoIsNothing() {
  CHECK(validateAnswer("[1] Priya (0:05): Can you send the proposal Friday? [1]", 3).nothing);
}

static void thePromptCarriesAWorkedExample() {
  const std::string p = askPrompt("q", passages());
  CHECK(p.find("Example") != std::string::npos);
  CHECK(p.find("[2].") != std::string::npos);  // the example's answer cites the way we want
}

static void grammarBoundsTheCitesToThePassages() {
  const std::string g = askGrammar(3);
  CHECK(g.find("root ::= nothing | answer") != std::string::npos);
  CHECK(g.find("[1-3]") != std::string::npos);
  CHECK(g.find(kAskNothing) != std::string::npos);
  CHECK(askGrammar(1).find("\"1\"") != std::string::npos);
  CHECK(askGrammar(12).find("[1-9]") != std::string::npos);  // never a two-digit range the grammar cannot spell
  CHECK(g.find("cite{1,3}") != std::string::npos);            // one to three citations, or the refusal: never an unbounded run
}

static void bracketsThatAreNotCitesAreLeftAlone() {
  const AskAnswer a = validateAnswer("The [draft] goes Friday [1] (see [2b]).", 3);
  CHECK(a.text == "The [draft] goes Friday [1] (see [2b]).");
  CHECK(a.cites.size() == 1 && a.cites[0] == 1);
}


// F17: the grammar is `body cite+`, so a cited answer can still hold a sentence nothing supports.
// After generation every sentence without a valid [n] is dropped; nothing left means "nothing".
static void anUncitedSentenceInsideACitedAnswerIsDropped() {
  const AskAnswer a = validateAnswer(
      "Priya agreed to a draft [1]. The budget is already fixed. Rahul wants another week [2].", 3);
  CHECK(!a.nothing);
  CHECK(a.text == "Priya agreed to a draft [1]. Rahul wants another week [2].");
  CHECK(a.cites.size() == 2 && a.cites[0] == 1 && a.cites[1] == 2);
  CHECK(a.text.find("budget") == std::string::npos);
}

static void aWholeAnswerOfUncitedSentencesIsNothing() {
  CHECK(validateAnswer("Priya agreed to a draft. The budget is fixed.", 3).nothing);
  // Cited only to a passage that does not exist: the cite is stripped, so the sentence is uncited.
  CHECK(validateAnswer("Priya agreed to a draft [9]. The budget is fixed [7].", 3).nothing);
  CHECK(validateAnswer("Priya agreed to a draft [9]. The budget is fixed [7].", 3).text.empty());
}

static void theCiteListComesFromWhatSurvivedInFirstMentionOrder() {
  const AskAnswer a = validateAnswer("Fine [3]. Wrong and uncited. Also this [1]. Again [3].", 3);
  CHECK(!a.nothing);
  CHECK(a.cites.size() == 2 && a.cites[0] == 3 && a.cites[1] == 1);
  CHECK(a.text == "Fine [3]. Also this [1]. Again [3].");
}

// The grammar writes every cite at the very end, after the full stop; that cite supports the
// sentence it follows and must not strand it.
static void aCiteAfterTheFullStopBelongsToTheSentenceBeforeIt() {
  const AskAnswer a = validateAnswer("The draft goes Friday. [1] The final needs a week. [2][3]", 3);
  CHECK(!a.nothing);
  CHECK(a.cites.size() == 3 && a.cites[0] == 1 && a.cites[1] == 2 && a.cites[2] == 3);
  CHECK(a.text.find("final needs a week") != std::string::npos);
  const AskAnswer b = validateAnswer("Nothing but a claim. Another claim. [2]", 3);
  CHECK(!b.nothing);
  CHECK(b.text == "Another claim. [2]");
}

static void abbreviationsAndDecimalsDoNotSplitASentence() {
  const AskAnswer a = validateAnswer("Mr. Rao will send version 2.1 on Friday [1].", 3);
  CHECK(!a.nothing);
  CHECK(a.text == "Mr. Rao will send version 2.1 on Friday [1].");
}

static void aLineBreakEndsASentenceToo() {
  const AskAnswer a = validateAnswer("The draft goes Friday [1]\nand nothing supports this line", 3);
  CHECK(a.text == "The draft goes Friday [1]");
}

int main() {
  promptIsNumberedStampedAndFenced();
  stampsPastAnHourReadLikeTheScreen();
  validatorKeepsInRangeCitesInFirstMentionOrder();
  validatorStripsOutOfRangeCites();
  noCitationIsNothing();
  theRefusalPhraseIsNothingEvenWithACite();
  bracketsThatAreNotCitesAreLeftAlone();
  echoedPassagesAreStripped();
  anAnswerThatIsOnlyEchoIsNothing();
  thePromptCarriesAWorkedExample();
  grammarBoundsTheCitesToThePassages();
  anUncitedSentenceInsideACitedAnswerIsDropped();
  aWholeAnswerOfUncitedSentencesIsNothing();
  theCiteListComesFromWhatSurvivedInFirstMentionOrder();
  aCiteAfterTheFullStopBelongsToTheSentenceBeforeIt();
  abbreviationsAndDecimalsDoNotSplitASentence();
  aLineBreakEndsASentenceToo();
  if (failures) {
    std::fprintf(stderr, "test_ask: %d failure(s)\n", failures);
    return 1;
  }
  std::puts("test_ask: ok");
  return 0;
}
