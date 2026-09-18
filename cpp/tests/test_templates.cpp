// The section table and its effect on narrativePrompt — off a device and off a model.
#include "minutes/templates.h"

#include <cstdio>
#include <string>
#include <vector>

#include "minutes/llm_minutes.h"

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

static void standupIsItsThreeSectionsInOrder() {
  const auto s = sectionsFor("standup");
  CHECK(s.size() == 3);
  CHECK(s.size() > 0 && s[0] == "Done since last time");
  CHECK(s.size() > 1 && s[1] == "Planned next");
  CHECK(s.size() > 2 && s[2] == "Blockers");
}

static void generalHasNoSections() {
  CHECK(sectionsFor("general").empty());
}

static void anUnknownIdBehavesAsGeneral() {
  CHECK(sectionsFor("").empty());
  CHECK(sectionsFor("not-a-real-template").empty());
}

static void everySevenIdsAreInTableOrder() {
  CHECK(kTemplateIdsCount == 7);
  const std::vector<std::string> want = {
      "general", "standup", "one_on_one", "client", "interview", "lecture", "site_walk",
  };
  for (std::size_t i = 0; i < want.size(); ++i) {
    CHECK(std::string(kTemplateIds[i]) == want[i]);
  }
}

static void narrativePromptWithAClientTemplateNamesEverySection() {
  const std::string n = narrativePrompt("They asked for a quote.", "en", "client");
  for (const auto& section : sectionsFor("client")) {
    CHECK(n.find(section) != std::string::npos);
  }
  // Still fenced: a template must not become a second way for recorded speech to reach the
  // instruction position unfenced.
  CHECK(n.find("RECORD OF A MEETING") != std::string::npos);
}

// The rules under a templated prompt must not forbid what its coverage instruction just asked
// for. Found in review 17 Sep: the section instruction said "open each paragraph with the
// section's name and a colon" while the shared rule two lines down said "do not head or label any
// paragraph" — a 1.5B model reading both is entitled to drop the openers, which is the whole
// product. The general prompt keeps the original rule, byte for byte.
static void aTemplatedPromptDoesNotForbidItsOwnSectionOpeners() {
  const std::string general = narrativePrompt("We discussed the roadmap.", "en", "general");
  const std::string client = narrativePrompt("They asked for a quote.", "en", "client");
  const std::string forbid = "do not head or label any paragraph";
  CHECK(general.find(forbid) != std::string::npos);
  CHECK(client.find(forbid) == std::string::npos);
  CHECK(client.find("The only labels are the section names above") != std::string::npos);
}

// ---- foldSections: the shape the phone shows is a rule, not the model's mood ----------------
//
// Measured on the Mac (17 Sep, Qwen 1.5B, greedy): asked for "Done since last time: <sentences>"
// paragraphs, the model wrote the section name alone on a line with bullets under it on one
// prompt, and as a "### name" markdown header over a paragraph on another. Narrator.clean then
// runs stripLabels, which drops any short line ending in a colon — the section names vanished
// and the bullets stayed. So the fold runs between stripMarkdown and stripLabels and rebuilds
// every section as the one paragraph the prompt asked for.

static void foldTurnsAHeaderAndItsBulletsIntoOneParagraph() {
  const std::string in =
      "done since last time:\n- export screen completed.\n- pdf renderer working on pixel\n\n"
      "planned next:\n- paywall copy.\n\n"
      "blockers:\n- licence server returns 500 on refresh.";
  const std::string want =
      "Done since last time: Export screen completed. Pdf renderer working on pixel.\n\n"
      "Planned next: Paywall copy.\n\n"
      "Blockers: Licence server returns 500 on refresh.";
  CHECK(foldSections(in, "standup") == want);
}

static void foldRecognisesAHeaderWithoutAColonOverProse() {
  // What stripMarkdown leaves of "### planned next\nSpeaker 3 is reviewing ...".
  const std::string in =
      "done since last time\nyesterday, speaker 1 finished the export screen.\n\n"
      "planned next\nspeaker 3 is reviewing the pull request.";
  const std::string want =
      "Done since last time: Yesterday, speaker 1 finished the export screen.\n\n"
      "Planned next: Speaker 3 is reviewing the pull request.";
  CHECK(foldSections(in, "standup") == want);
}

static void foldLeavesAnInlineOpenerAndItsParagraphAlone() {
  const std::string in =
      "Done since last time: The meeting decided on the vendor code format.\n\n"
      "Planned next: Ravi is checking with finance.";
  CHECK(foldSections(in, "standup") == in);
}

static void foldKeepsProseBeforeTheFirstHeaderAndIsIdentityForGeneral() {
  const std::string in = "The team met briefly.\n\nblockers:\n- the phone is with QA.";
  CHECK(foldSections(in, "standup") == "The team met briefly.\n\nBlockers: The phone is with QA.");
  CHECK(foldSections(in, "general") == in);
  CHECK(foldSections(in, "") == in);
}

static void foldedOutputSurvivesStripLabels() {
  // The whole reason the fold exists: stripLabels drops "blockers:" alone on a line, and keeps
  // "Blockers: The phone is with QA." because it ends the sentence it opens.
  const std::string in = "blockers:\n- the phone is with QA.";
  CHECK(stripLabels(in).find("lockers") == std::string::npos);
  CHECK(stripLabels(foldSections(in, "standup")) == "Blockers: The phone is with QA.");
}

// Phase 5: "dictation" is a narrative shape, not one of the seven meeting types — sectionsFor
// knows nothing of it, narrativePrompt routes it to dictationPrompt, and the record is fenced.
static void dictationIsItsOwnPromptAndStillFenced() {
  CHECK(sectionsFor("dictation").empty());
  const std::string d = narrativePrompt("um so tell Priya we will not ship Monday", "en", "dictation");
  CHECK(d == dictationPrompt("um so tell Priya we will not ship Monday", "en"));
  CHECK(d.find("RECORD OF A MEETING") != std::string::npos);
  CHECK(d.find("first person") != std::string::npos);
  CHECK(d.find("Write three or four short paragraphs") == std::string::npos);
  CHECK(d.find("for someone who was not there") == std::string::npos);
}

static void dictationKeepsItsOpeningLabelAsASentence() {
  const std::string in = "The note for Priya:\nWe will not ship on Monday.";
  CHECK(foldSections(in, "dictation") == "The note for Priya.\nWe will not ship on Monday.");
  // ...and stripLabels then keeps it, where it would have dropped the label.
  CHECK(stripLabels(foldSections(in, "dictation")).find("Priya") != std::string::npos);
  CHECK(stripLabels(in).find("Priya") == std::string::npos);
  // A note that opens with a sentence is untouched; a long line is not a label; other templates
  // never see this rule.
  CHECK(foldSections("We will not ship on Monday.\nMore.", "dictation") == "We will not ship on Monday.\nMore.");
  const std::string longLine(61, 'x');
  CHECK(foldSections(longLine + ":\nbody", "dictation") == longLine + ":\nbody");
  CHECK(foldSections(in, "general") == in);
  // Bullets become one paragraph of sentences; a blank line between groups is kept.
  CHECK(foldSections("The note for Priya:\n- We won't ship on Monday.\n- vendor codes are six digits now\n\nDone.", "dictation") ==
        "The note for Priya.\nWe won't ship on Monday. Vendor codes are six digits now.\n\nDone.");
}

static void twoArgNarrativePromptEqualsThreeArgWithGeneral() {
  const std::string record = "We discussed the roadmap.";
  CHECK(narrativePrompt(record, "en") == narrativePrompt(record, "en", "general"));
}

int main() {
  standupIsItsThreeSectionsInOrder();
  generalHasNoSections();
  anUnknownIdBehavesAsGeneral();
  everySevenIdsAreInTableOrder();
  narrativePromptWithAClientTemplateNamesEverySection();
  aTemplatedPromptDoesNotForbidItsOwnSectionOpeners();
  foldTurnsAHeaderAndItsBulletsIntoOneParagraph();
  foldRecognisesAHeaderWithoutAColonOverProse();
  foldLeavesAnInlineOpenerAndItsParagraphAlone();
  foldKeepsProseBeforeTheFirstHeaderAndIsIdentityForGeneral();
  foldedOutputSurvivesStripLabels();
  dictationIsItsOwnPromptAndStillFenced();
  dictationKeepsItsOpeningLabelAsASentence();
  twoArgNarrativePromptEqualsThreeArgWithGeneral();
  if (failures) {
    std::fprintf(stderr, "test_templates: %d failure(s)\n", failures);
    return 1;
  }
  std::puts("test_templates: ok");
  return 0;
}
