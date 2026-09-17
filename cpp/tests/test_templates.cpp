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
  twoArgNarrativePromptEqualsThreeArgWithGeneral();
  if (failures) {
    std::fprintf(stderr, "test_templates: %d failure(s)\n", failures);
    return 1;
  }
  std::puts("test_templates: ok");
  return 0;
}
