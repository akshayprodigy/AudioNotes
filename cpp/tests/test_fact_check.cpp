// F24: the writer fact check, off a device and off a model. Every case is a transcript snippet and
// a writer output; the assertion is which sentences survive and why the others went.
//
// Not assert(): this target is built Release, where NDEBUG compiles every assert away.
#include "minutes/fact_check.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

using namespace audionotes;

static int failures = 0;
#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                          \
    }                                                                      \
  } while (0)

static bool has(const std::vector<double>& c, double v) {
  for (double x : c)
    if (std::fabs(x - v) < 1e-6) return true;
  return false;
}
static bool hasClass(const FactCheck& r, const std::string& c) {
  return std::find(r.classes.begin(), r.classes.end(), c) != r.classes.end();
}
static bool contains(const std::string& s, const std::string& sub) {
  return s.find(sub) != std::string::npos;
}

// ---------------------------------------------------------------- spoken numbers (table-driven)

struct NumCase { const char* said; double v; };

static void spelledNumberTable() {
  const NumCase table[] = {
      {"zero", 0},          {"seven", 7},           {"ten", 10},
      {"eleven", 11},       {"nineteen", 19},       {"twenty", 20},
      {"forty", 40},        {"forty-five", 45},     {"forty five", 45},
      {"ninety nine", 99},  {"a hundred", 100},     {"one hundred", 100},
      {"four hundred ninety nine", 499},            {"four hundred and ninety nine", 499},
      {"two hundred and fifty", 250},               {"one thousand", 1000},
      {"five thousand", 5000},                      {"one thousand two hundred", 1200},
      {"three thousand four hundred", 3400},        {"forty five hundred", 4500},
      {"two thousand and five", 2005},              {"twenty five thousand", 25000},
      {"two million", 2000000},                     {"two lakh", 200000},
      {"three crore", 30000000},                    {"a hundred thousand", 100000},
  };
  for (const auto& t : table) {
    const auto m = spokenNumberCandidates(t.said);
    CHECK(m.size() == 1);
    CHECK(!m.empty() && has(m[0], t.v));
  }
}

static void colloquialPairsAreAmbiguousAndSupportBothMagnitudes() {
  // "four ninety nine" is 499 or 4.99 — speech does not say, so both are candidates.
  auto m = spokenNumberCandidates("four ninety nine");
  CHECK(m.size() == 1);
  CHECK(!m.empty() && has(m[0], 499) && has(m[0], 4.99));
  m = spokenNumberCandidates("thirty nine ninety nine");
  CHECK(!m.empty() && has(m[0], 3999) && has(m[0], 39.99));
  m = spokenNumberCandidates("nineteen ninety nine");
  CHECK(!m.empty() && has(m[0], 1999) && has(m[0], 19.99));
  m = spokenNumberCandidates("twenty twenty six");
  CHECK(!m.empty() && has(m[0], 2026));
  // ...and no other magnitude. 49.9 or 4990 is NOT something "four ninety nine" can mean.
  m = spokenNumberCandidates("four ninety nine");
  CHECK(!m.empty() && !has(m[0], 4990) && !has(m[0], 49.9) && !has(m[0], 3999));
  // A hundred-word makes it one number, not a pair.
  m = spokenNumberCandidates("four hundred ninety nine");
  CHECK(!m.empty() && !has(m[0], 4.99));
}

static void digitFormsNormalise() {
  CHECK(has(spokenNumberCandidates("3,999")[0], 3999));
  CHECK(has(spokenNumberCandidates("3999")[0], 3999));
  CHECK(has(spokenNumberCandidates("4.99")[0], 4.99));
  CHECK(has(spokenNumberCandidates("5k")[0], 5000));
  CHECK(has(spokenNumberCandidates("1.5 million")[0], 1500000));
  CHECK(has(spokenNumberCandidates("four point nine nine")[0], 4.99));
  // Two numbers in one text are two mentions.
  CHECK(spokenNumberCandidates("ship 40 units in 12 days").size() == 2);
}

// ---------------------------------------------------------------- the splitter

static void splitterKeepsDecimalsAndAbbreviationsWhole() {
  auto s = splitSentences("Version 3.5 shipped. Mr. Rao agreed. Is it done? Yes!");
  CHECK(s.size() == 4);
  CHECK(s.size() > 1 && s[0] == "Version 3.5 shipped.");
  CHECK(s.size() > 1 && s[1] == "Mr. Rao agreed.");
  CHECK(splitSentences("No terminator here").size() == 1);
  CHECK(splitSentences("").empty());
}

// ---------------------------------------------------------------- the three A07 cases, verbatim

static void a07PriceIsDropped() {
  // ASR heard "four ninety nine a month" as "499 am".
  const std::string transcript =
      "Okay so for the starter plan the price is 499 am and we can talk about the annual one next "
      "time. Ravi will draft the pricing page.";
  const std::string written =
      "The group discussed pricing for the starter plan. The starter plan costs $499/month or "
      "$3999/year. Ravi will draft the pricing page.";
  const auto r = checkWriterFacts(written, transcript);
  CHECK(r.dropped == 1);
  CHECK(!contains(r.text, "3999"));
  CHECK(contains(r.text, "The group discussed pricing for the starter plan."));
  CHECK(contains(r.text, "Ravi will draft the pricing page."));
  CHECK(hasClass(r, "currency"));
}

static void a07SentOutThatWasOnlyPromised() {
  const std::string transcript =
      "Ravi: I'll send the report to the client by the end of the week. Priya: Great, thanks.";
  const std::string written =
      "The group reviewed the client report. The report was sent out to the client. Priya "
      "thanked Ravi.";
  const auto r = checkWriterFacts(written, transcript);
  CHECK(r.dropped == 1);
  CHECK(!contains(r.text, "sent out"));
  CHECK(contains(r.text, "The group reviewed the client report."));
  CHECK(contains(r.text, "Priya thanked Ravi."));
  CHECK(hasClass(r, "tense"));
}

static void a07InventedEarlierSchedule() {
  const std::string transcript = "Let's hold the design review on Thursday afternoon.";
  const std::string written =
      "The design review had been scheduled for Tuesday but has now been postponed to Thursday. "
      "The review will be in the afternoon.";
  const auto r = checkWriterFacts(written, transcript);
  CHECK(r.dropped == 1);
  CHECK(!contains(r.text, "Tuesday"));
  CHECK(contains(r.text, "The review will be in the afternoon."));
  // Both lies are named: the weekday nobody said and the postponement nobody reported.
  CHECK(hasClass(r, "date"));
  CHECK(hasClass(r, "status"));
}

// ---------------------------------------------------------------- numbers

static void spelledAndDigitFormsAreEquivalent() {
  const std::string said = "We had forty people and the budget is twelve thousand.";
  CHECK(checkWriterFacts("40 people came. The budget is 12,000.", said).dropped == 0);
  CHECK(checkWriterFacts("Forty people came.", "We had 40 people.").dropped == 0);
  // The wrong number goes, and it is a number-class drop.
  const auto r = checkWriterFacts("45 people came.", said);
  CHECK(r.dropped == 1 && r.text.empty() && hasClass(r, "number"));
}

static void fourNinetyNineSupportsEitherMagnitudeButNothingElse() {
  const std::string said = "The starter plan is four ninety nine a month in dollars.";
  CHECK(checkWriterFacts("The starter plan costs $499 a month.", said).dropped == 0);
  CHECK(checkWriterFacts("The starter plan costs $4.99 a month.", said).dropped == 0);
  CHECK(checkWriterFacts("The starter plan costs $4990 a month.", said).dropped == 1);
  CHECK(checkWriterFacts("The starter plan costs $3999 a month.", said).dropped == 1);
}

static void smallCountingWordsAreNotClaims() {
  // "three options" is how a summary counts things it listed; the transcript need not say "three".
  const std::string r = checkWriterFacts("Three options were discussed.", "We looked at a few ideas.").text;
  CHECK(r == "Three options were discussed.");
  // ...but the same small number with a unit IS a claim.
  CHECK(checkWriterFacts("The delay is three weeks.", "We looked at a few ideas.").dropped == 1);
  CHECK(checkWriterFacts("The delay is three weeks.", "It will take 3 weeks.").dropped == 0);
}

static void speakerNumbersAreLabelsNotClaims() {
  CHECK(checkWriterFacts("Speaker 13 asked about the price.", "Someone asked about the price.").dropped == 0);
}

static void percentIsANumberClaim() {
  CHECK(checkWriterFacts("Churn is 10%.", "Churn is ten percent right now.").dropped == 0);
  CHECK(checkWriterFacts("Churn is 15%.", "Churn is ten percent right now.").dropped == 1);
}

// ---------------------------------------------------------------- currency

static void currencyMustBeTheOneSpoken() {
  const std::string said = "The fee is five thousand rupees.";
  CHECK(checkWriterFacts("The fee is ₹5,000.", said).dropped == 0);
  CHECK(checkWriterFacts("The fee is 5,000 rupees.", said).dropped == 0);
  CHECK(checkWriterFacts("The fee is Rs 5000.", said).dropped == 0);
  // Right number, wrong currency: a wrong fact, not a rounding.
  const auto r = checkWriterFacts("The fee is $5,000.", said);
  CHECK(r.dropped == 1 && hasClass(r, "currency"));
  // "$" and "dollars" are the same currency.
  CHECK(checkWriterFacts("It costs $20.", "It costs twenty dollars.").dropped == 0);
  CHECK(checkWriterFacts("It costs 20 dollars.", "It costs $20.").dropped == 0);
}

static void aCurrencyNobodySaidIsNotInventedForABareNumber() {
  // The transcript has the number and no currency at all: the writer guessed one.
  const auto r = checkWriterFacts("The plan costs $499.", "The plan is 499 for starters.");
  CHECK(r.dropped == 1 && hasClass(r, "currency"));
  // Said without a currency, written without one: nothing to guess, nothing to check.
  CHECK(checkWriterFacts("The plan is 499.", "The plan is 499 for starters.").dropped == 0);
}

// ---------------------------------------------------------------- dates

static void weekdaysAndMonths() {
  CHECK(checkWriterFacts("The release is on Friday.", "Let's release on Friday.").dropped == 0);
  CHECK(checkWriterFacts("The release is on Monday.", "Let's release on Friday.").dropped == 1);
  const std::string said = "The deadline is the tenth of March.";
  CHECK(checkWriterFacts("The deadline is 10 March.", said).dropped == 0);
  CHECK(checkWriterFacts("The deadline is March 10.", said).dropped == 0);
  CHECK(checkWriterFacts("The deadline is the 10th of March.", said).dropped == 0);
  // A day named alone, in words or digits, supports the same day in the other form.
  CHECK(checkWriterFacts("It is due on the 15th.", "Get it to me by the fifteenth.").dropped == 0);
  CHECK(checkWriterFacts("It is due on the 16th.", "Get it to me by the fifteenth.").dropped == 1);
  CHECK(checkWriterFacts("The deadline is 10/03.", said).dropped == 0);
  const auto wrongDay = checkWriterFacts("The deadline is 11 March.", said);
  CHECK(wrongDay.dropped == 1 && hasClass(wrongDay, "date"));
  CHECK(checkWriterFacts("The deadline is 10 April.", said).dropped == 1);
  // The bare month is a claim too.
  CHECK(checkWriterFacts("We expect it in March.", said).dropped == 0);
  CHECK(checkWriterFacts("We expect it in June.", said).dropped == 1);
}

static void mayTheVerbIsNotAMonth() {
  CHECK(checkWriterFacts("The group may revisit this.", "We might revisit this.").dropped == 0);
  CHECK(checkWriterFacts("The review is on May 5.", "The review is on the fifth of May.").dropped == 0);
  CHECK(checkWriterFacts("The review is on May 6.", "The review is on the fifth of May.").dropped == 1);
}

static void relativeDates() {
  CHECK(checkWriterFacts("It will be revisited next week.", "We'll revisit it next week.").dropped == 0);
  const auto r = checkWriterFacts("It will be revisited next month.", "We'll revisit it next week.");
  CHECK(r.dropped == 1 && hasClass(r, "date"));
  CHECK(checkWriterFacts("It is due by the end of the week.", "Get it to me by end of week.").dropped == 0);
  CHECK(checkWriterFacts("It is due tomorrow.", "Get it to me by end of week.").dropped == 1);
}

static void timesOfDay() {
  CHECK(checkWriterFacts("They meet at 3 pm.", "Let's meet at three o'clock.").dropped == 0);
  CHECK(checkWriterFacts("They meet at 4 pm.", "Let's meet at three o'clock.").dropped == 1);
  CHECK(checkWriterFacts("They meet at 3:30.", "Let's meet at three thirty.").dropped == 0);
}

// ---------------------------------------------------------------- status verbs and tense

static void aSpokenCompletionSupportsTheClaim() {
  CHECK(checkWriterFacts("The contract was signed.", "We signed the contract yesterday.").dropped == 0);
  CHECK(checkWriterFacts("The export is done.", "The export is done now.").dropped == 0);
  // A different verb is not the same claim.
  const auto r = checkWriterFacts("The contract was approved.", "We signed the contract yesterday.");
  CHECK(r.dropped == 1 && hasClass(r, "status"));
}

static void tenseFlipIsCaught() {
  const std::string future = "I'll send the proposal on Friday.";
  const auto r = checkWriterFacts("The proposal was sent.", future);
  CHECK(r.dropped == 1 && hasClass(r, "tense") && !hasClass(r, "status"));
  CHECK(hasClass(checkWriterFacts("The proposal has been sent.", "The proposal will be sent Friday."), "tense"));
  CHECK(hasClass(checkWriterFacts("The budget was approved.", "The budget needs to be approved first."), "tense"));
  CHECK(hasClass(checkWriterFacts("The proposal was sent.", "Send the proposal by Friday, please."), "tense"));
  CHECK(hasClass(checkWriterFacts("The proposal was sent.", "We are going to send the proposal."), "tense"));
  // The writer keeping the promise a promise is correct and passes.
  CHECK(checkWriterFacts("The proposal will be sent on Friday.", future).dropped == 0);
  CHECK(checkWriterFacts("Ravi will send the proposal.", future).dropped == 0);
}

static void aNegatedOrAskedAboutCompletionDoesNotSupportIt() {
  CHECK(checkWriterFacts("The invoice was paid.", "The invoice has not been paid yet.").dropped == 1);
  CHECK(checkWriterFacts("The report was sent.", "Did you send the report?").dropped == 1);
  // The writer saying it was NOT done is not a claim of completion.
  CHECK(checkWriterFacts("The invoice has not been paid.", "The invoice has not been paid yet.").dropped == 0);
}

static void completionNeedsTheSameSubjectNearby() {
  // "sent" appears, but about something else, a long way off.
  const std::string said =
      "We sent the invite already. Then we spent a long time on the roadmap and the hiring plan "
      "and the quarterly planning and the office move and the training budget and so on. The "
      "report is still being written.";
  CHECK(checkWriterFacts("The report was sent.", said).dropped == 1);
  CHECK(checkWriterFacts("The invite was sent.", said).dropped == 0);
}

static void aNameIsNotTheSubjectTheVerbIsHeldTo() {
  // "Priya" comes from a speaker label; the transcript says "I". The export is what ties the
  // claim to the transcript, and it does.
  CHECK(checkWriterFacts("Priya finished the export screen.", "Yesterday I finished the export screen.").dropped == 0);
  // A sentence about a name alone has no subject to hold, so the verb is held to the transcript.
  CHECK(checkWriterFacts("Priya signed off.", "We signed the contract yesterday.").dropped == 0);
  CHECK(checkWriterFacts("Priya signed off.", "We talked about the weather.").dropped == 1);
}

static void movedOnIsNotAPostponement() {
  CHECK(checkWriterFacts("The discussion moved on to pricing.", "Okay, pricing next.").dropped == 0);
  CHECK(checkWriterFacts("The discussion moved to pricing.", "Okay, pricing next.").dropped == 0);
  CHECK(checkWriterFacts("The team then moved onto touch screens.", "Okay, touch screens next.").dropped == 0);
  const auto r = checkWriterFacts("The review was moved to Thursday.", "Thursday works for the review.");
  CHECK(r.dropped == 1 && hasClass(r, "status"));
  CHECK(checkWriterFacts("The review was moved to Thursday.", "Let's move the review to Thursday.")
            .dropped == 1);  // proposed, not done: a tense flip
  CHECK(checkWriterFacts("The review was moved to Thursday.", "We moved the review to Thursday.").dropped == 0);
  CHECK(checkWriterFacts("The review was pushed back to Thursday.", "We moved the review to Thursday.").dropped == 0);
}

// ---------------------------------------------------------------- shape of the result

static void aCleanSummaryPassesByteForByte() {
  const std::string written =
      "The group talked through the launch plan.\n\nThey agreed Priya owns the copy. Ravi will "
      "send the deck on Friday.";
  const std::string said =
      "Priya owns the copy. Ravi: I'll send the deck on Friday. We talked through the launch plan.";
  const auto r = checkWriterFacts(written, said);
  CHECK(r.dropped == 0);
  CHECK(r.text == written);
  CHECK(r.classes.empty());
}

static void everySentenceUnsupportedLeavesNothing() {
  const auto r = checkWriterFacts("It costs $999. It ships on Tuesday.", "We talked about the website.");
  CHECK(r.dropped == 2);
  CHECK(r.text.empty());
}

static void theCounterAndTheClassesAreExact() {
  const std::string said = "The price is twenty dollars. We'll send the quote soon.";
  const std::string written =
      "The price is $20. The price is $25. The quote was sent. It ships on Tuesday. The team met.";
  const auto r = checkWriterFacts(written, said);
  CHECK(r.dropped == 3);
  CHECK(r.text == "The price is $20. The team met.");
  // Fixed order, distinct.
  const std::vector<std::string> want = {"currency", "date", "tense"};
  CHECK(r.classes == want);
}

static void paragraphsSurviveADrop() {
  const std::string written =
      "First paragraph is fine.\n\nThis one costs $999. It is also fine.\n\nThird is fine.";
  const auto r = checkWriterFacts(written, "We said some things.");
  CHECK(r.dropped == 1);
  CHECK(r.text == "First paragraph is fine.\n\nIt is also fine.\n\nThird is fine.");
  // A paragraph that loses its only sentence goes entirely, with no blank-line stack left behind.
  const auto r2 = checkWriterFacts("One.\n\nIt costs $999.\n\nThree.", "We said some things.");
  CHECK(r2.text == "One.\n\nThree.");
}

static void aSectionLabelDoesNotCountAsAClaimAndSurvivesItsFirstSentence() {
  // "Done since last time" names a section; the word "done" in it asserts nothing.
  const std::string said = "Yesterday I worked on the export screen.";
  CHECK(checkWriterFacts("Done since last time: Priya worked on the export screen.", said).dropped == 0);
  // The label stays on the sentence that is left when its first sentence is the one that goes.
  const auto r = checkWriterFacts(
      "Planned next: The export costs $999. Priya will work on the export screen.", said);
  CHECK(r.dropped == 1);
  CHECK(r.text == "Planned next: Priya will work on the export screen.");
}

static void nothingToCheckIsNothingDropped() {
  CHECK(checkWriterFacts("", "anything").dropped == 0);
  CHECK(checkWriterFacts("The team discussed the plan.", "").dropped == 0);
  CHECK(checkWriterFacts("The team discussed the plan.", "").text == "The team discussed the plan.");
  // A transcript with nothing in it cannot support a number, though.
  CHECK(checkWriterFacts("The plan costs 40 dollars.", "").dropped == 1);
}

int main() {
  spelledNumberTable();
  colloquialPairsAreAmbiguousAndSupportBothMagnitudes();
  digitFormsNormalise();
  splitterKeepsDecimalsAndAbbreviationsWhole();
  a07PriceIsDropped();
  a07SentOutThatWasOnlyPromised();
  a07InventedEarlierSchedule();
  spelledAndDigitFormsAreEquivalent();
  fourNinetyNineSupportsEitherMagnitudeButNothingElse();
  smallCountingWordsAreNotClaims();
  speakerNumbersAreLabelsNotClaims();
  percentIsANumberClaim();
  currencyMustBeTheOneSpoken();
  aCurrencyNobodySaidIsNotInventedForABareNumber();
  weekdaysAndMonths();
  mayTheVerbIsNotAMonth();
  relativeDates();
  timesOfDay();
  aSpokenCompletionSupportsTheClaim();
  tenseFlipIsCaught();
  aNegatedOrAskedAboutCompletionDoesNotSupportIt();
  completionNeedsTheSameSubjectNearby();
  aNameIsNotTheSubjectTheVerbIsHeldTo();
  movedOnIsNotAPostponement();
  aCleanSummaryPassesByteForByte();
  everySentenceUnsupportedLeavesNothing();
  theCounterAndTheClassesAreExact();
  paragraphsSurviveADrop();
  aSectionLabelDoesNotCountAsAClaimAndSurvivesItsFirstSentence();
  nothingToCheckIsNothingDropped();
  if (failures) {
    std::fprintf(stderr, "test_fact_check: %d failure(s)\n", failures);
    return 1;
  }
  std::puts("test_fact_check: ok");
  return 0;
}
