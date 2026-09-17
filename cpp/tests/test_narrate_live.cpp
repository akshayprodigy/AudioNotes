// A templated narrative against the real writer on the Mac (VERBALE_LLM_GGUF), the way the phone
// runs it: greedy, repeat penalty 1.15, the record fenced, the stand-up sections asked for. Skips
// itself, exit 0, without the file. Prints the prose so a change in it is seen.
//
// What it pins: that the prompt's section instruction and its rules agree well enough for a 1.5B
// model to open its paragraphs with the section names. Written in review on 17 Sep, when the two
// were found to contradict each other ("open each paragraph with the section's name" two lines
// above "do not head or label any paragraph"); the phone's NativePipelineTest asks the same of the
// same model, once a day, on a device — this asks it on every gate that has the file.
#include "llm/llama_engine.h"
#include "minutes/llm_minutes.h"
#include "minutes/templates.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <string>

using namespace audionotes;

static int failures = 0;
#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                          \
    }                                                                      \
  } while (0)

static std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
  return s;
}

int main() {
  const char* path = std::getenv("VERBALE_LLM_GGUF");
  if (!path || !*path) { std::puts("test_narrate_live: skipped (VERBALE_LLM_GGUF unset)"); return 0; }
  if (FILE* f = std::fopen(path, "rb")) std::fclose(f); else { std::printf("test_narrate_live: skipped (%s not found)\n", path); return 0; }

  LlamaEngine e;
  if (!e.load(path, 8192, 4, /*greedy=*/true, /*repeat_penalty=*/1.15f)) { std::fprintf(stderr, "could not load\n"); return 1; }

  // A three-person stand-up, as the digest stage would hand it to the narrative prompt. Every
  // section has something to say, so a model that follows the instruction opens all three.
  const std::string record =
      "Speaker 1: Yesterday I finished the export screen and got the PDF renderer working on the "
      "Pixel. Today I am on the paywall copy. My blocker is the licence server, it is still "
      "returning 500 on refresh.\n"
      "Speaker 2: Yesterday I closed the diarization memory bug. Today I am picking up the "
      "consent clip fix. No blockers.\n"
      "Speaker 3: I was out yesterday. Today I am reviewing Ravi's pull request and then the "
      "backup restore path. I am blocked on the test phone, it is with QA until Thursday.\n"
      "Speaker 1: Fine, take the emulator for the restore path until then.";
  const std::string prompt = narrativePrompt(record, "en", "standup");
  const std::string raw = e.generate(prompt, 640);
  // Narrator.clean's chain, with the fold where Narrator runs it: what the phone stores and shows.
  const std::string shown = stripLabels(foldSections(stripMarkdown(raw), "standup"));
  std::printf("\n=== standup narrative, raw\n%s\n=== as shown\n%s\n===\n", raw.c_str(), shown.c_str());

  const std::string out = lower(shown);
  int hit = 0;
  for (const auto& s : sectionsFor("standup")) {
    if (out.find(lower(s) + ": ") != std::string::npos) ++hit;
  }
  std::printf("section openers shown: %d of 3\n", hit);
  // The phone's NativePipelineTest asks for two of three on a record where one section is empty;
  // here every section has content, so all three is the bar — after cleaning, not before.
  CHECK(hit == 3);
  // Paragraphs, not a list: no line may start with a bullet once the fold has run.
  CHECK(shown.find("\n- ") == std::string::npos && shown.rfind("- ", 0) != 0);
  // The minutes form must stay out even with labels allowed: no title, no attendee list.
  CHECK(out.find("meeting summary") == std::string::npos);
  CHECK(out.find("attendees") == std::string::npos);

  // A second shape, a client call — four sections, discussion-shaped rather than list-shaped, so
  // the model's other reflex (prose under markdown headers) gets the same bar.
  const std::string client =
      "Speaker 1: Thanks for joining. You said last week you wanted the export in PDF and Word, "
      "and a way to share a meeting with someone outside the team.\n"
      "Speaker 2: Yes, and the Word one matters more, our legal team lives in Word. Pricing is "
      "fine as quoted if the Word export is in the first release.\n"
      "Speaker 1: Word export we can commit to for the first release. The sharing link is a "
      "bigger piece, we will scope it and come back with a date. The risk is the licence server, "
      "it is the one thing we do not host ourselves.\n"
      "Speaker 2: Understood. Send the revised proposal by Friday and we will sign the following "
      "week.";
  const std::string craw = e.generate(narrativePrompt(client, "en", "client"), 640);
  const std::string cshown = stripLabels(foldSections(stripMarkdown(craw), "client"));
  std::printf("\n=== client narrative, raw\n%s\n=== as shown\n%s\n===\n", craw.c_str(), cshown.c_str());
  const std::string cout_ = lower(cshown);
  int chit = 0;
  for (const auto& s : sectionsFor("client")) {
    if (cout_.find(lower(s) + ": ") != std::string::npos) ++chit;
  }
  std::printf("section openers shown: %d of 4\n", chit);
  CHECK(chit >= 3);
  CHECK(cshown.find("\n- ") == std::string::npos && cshown.rfind("- ", 0) != 0);

  if (failures) { std::fprintf(stderr, "test_narrate_live: %d failure(s)\n", failures); return 1; }
  std::puts("test_narrate_live: ok");
  return 0;
}
