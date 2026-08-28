// Golden parity for parseMinutesJson (fixtures from summarize.ts via the jest golden test) plus
// direct unit tests for chunking and the map/reduce plumbing (fake generate fn).
#include "minutes/llm_minutes.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "nlohmann/json.hpp"

using nlohmann::json;

static int failures = 0;
#define CHECK(cond, ...)                                   \
  do {                                                     \
    if (!(cond)) {                                         \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                   \
      std::fprintf(stderr, "\n");                          \
      ++failures;                                          \
    }                                                      \
  } while (0)

static void runParseGolden(const std::string& dir, const char* name) {
  std::ifstream f(dir + "/" + name);
  if (!f) { std::fprintf(stderr, "missing golden %s\n", name); std::exit(2); }
  json g = json::parse(f);
  auto got = audionotes::parseMinutesJson(g["input"].get<std::string>());
  if (g["output"].is_null()) {
    CHECK(!got.has_value(), "%s: expected null, got %zu minutes", name,
          got ? got->size() : static_cast<size_t>(0));
    return;
  }
  CHECK(got.has_value(), "%s: expected minutes, got null", name);
  if (!got) return;
  const auto& want = g["output"];
  CHECK(got->size() == want.size(), "%s: size %zu != %zu", name, got->size(), want.size());
  for (size_t i = 0; i < got->size() && i < want.size(); ++i) {
    CHECK((*got)[i].kind == want[i]["kind"].get<std::string>(), "%s[%zu].kind", name, i);
    CHECK((*got)[i].content == want[i]["content"].get<std::string>(),
          "%s[%zu].content\n  got: %s\n want: %s", name, i, (*got)[i].content.c_str(),
          want[i]["content"].get<std::string>().c_str());
    CHECK((*got)[i].source == "llm", "%s[%zu].source", name, i);
  }
}

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: test_llm_minutes <golden-dir>\n"); return 2; }
  const std::string dir = argv[1];
  runParseGolden(dir, "parse_valid.json");
  runParseGolden(dir, "parse_template_echo.json");
  runParseGolden(dir, "parse_broken.json");
  runParseGolden(dir, "parse_string_actions.json");
  runParseGolden(dir, "parse_na_due.json");

  // chunkTranscript: lines pack up to max_chars with '\n' joins; oversize single line stays whole.
  {
    std::vector<std::string> lines = {std::string(10, 'a'), std::string(10, 'b'),
                                      std::string(10, 'c')};
    auto chunks = audionotes::chunkTranscript(lines, 25);
    CHECK(chunks.size() == 2, "chunking: got %zu chunks, want 2", chunks.size());
    CHECK(chunks[0] == std::string(10, 'a') + "\n" + std::string(10, 'b'), "chunk[0] content");
    CHECK(chunks[1] == std::string(10, 'c'), "chunk[1] content");
  }

  // transcriptLines: names resolve; missing speaker -> "Speaker".
  {
    auto lines = audionotes::transcriptLines(
        {{"Hello.", "S0"}, {"World.", ""}},
        {{"S0", "Speaker 1"}});
    CHECK(lines.size() == 2 && lines[0] == "Speaker 1: Hello." && lines[1] == "Speaker: World.",
          "transcriptLines: %s | %s", lines[0].c_str(), lines[1].c_str());
  }

  // enhanceMinutes single-chunk path: map (512) THEN reduce (768).
  //
  // This used to assert one call, skipping the map phase and handing the raw transcript straight
  // to reducePrompt — which opens "These are notes from consecutive parts of ONE meeting". Every
  // meeting under ~9 minutes took that path, which is most of them.
  {
    int calls = 0;
    std::vector<std::string> seen;
    std::vector<int> budgets;
    auto fake = [&](const std::string& prompt, int max_tokens) {
      ++calls;
      seen.push_back(prompt);
      budgets.push_back(max_tokens);
      return std::string(
          "{\"summary\":\"Short meeting.\",\"decisions\":[],\"actions\":[],\"questions\":[]}");
    };
    auto out = audionotes::enhanceMinutes({{"Hi there.", "S0"}}, {{"S0", "Speaker 1"}}, fake);
    CHECK(calls == 2, "single-chunk path made %d generate calls, want 2 (map then reduce)", calls);
    CHECK(budgets.size() == 2 && budgets[0] == 512 && budgets[1] == 768,
          "single-chunk budgets should be map=512 then reduce=768");
    CHECK(seen.size() == 2 && seen[0].find("Speaker 1: Hi there.") != std::string::npos,
          "the transcript should reach the MAP prompt");
    CHECK(out && out->size() == 1 && (*out)[0].kind == "summary", "single-chunk parse");
  }

  // Whatever the chunk count, dialogue must never reach a prompt that calls its input "notes".
  {
    std::vector<std::string> seen;
    auto gen = [&seen](const std::string& p, int) {
      seen.push_back(p);
      return std::string(R"({"summary":"x","decisions":[],"actions":[],"questions":[]})");
    };
    audionotes::enhanceMinutes({{"we should ship on Friday", "s1"}}, {{"s1", "Ana"}}, gen);
    CHECK(!seen.empty(), "enhanceMinutes never called generate");
    for (const auto& p : seen) {
      const bool claims_notes = p.find("These are notes from consecutive parts") != std::string::npos;
      const bool holds_dialogue = p.find("we should ship on Friday") != std::string::npos;
      CHECK(!(claims_notes && holds_dialogue), "a raw transcript was handed to the notes prompt");
    }
  }

  // enhanceMinutes empty input -> nullopt.
  CHECK(!audionotes::enhanceMinutes({}, {}, [](const std::string&, int) { return std::string(); }),
        "empty utterances must return nullopt");

  // Prompt builders: each must embed its input and must NOT ask for JSON. The summary prompt in
  // particular must not inherit the extraction schema's framing, which made the model describe
  // what it failed to find instead of what happened.
  {
    const std::string n = audionotes::narrativePrompt("ZZNOTESZZ");
    CHECK(n.find("ZZNOTESZZ") != std::string::npos, "narrativePrompt drops its input");
    CHECK(n.find("JSON") == std::string::npos, "narrativePrompt must not ask for JSON");
    // Asked to "write the minutes", the model filled in the minutes FORM instead of writing:
    // a title, an Attendees list, a numbered Agenda, and the literal "Date & Time: [Current Date]
    // at [Time]" shown to the reader. The instruction must not name the artefact it triggers, and
    // must refuse the form field by field.
    CHECK(n.find("the minutes as plain prose") == std::string::npos,
          "narrativePrompt must not ask for 'the minutes' — that is what summons the form");
    CHECK(n.find("Attendees list") != std::string::npos,
          "narrativePrompt must refuse an attendee list by name");
    CHECK(n.find("Agenda") != std::string::npos, "narrativePrompt must refuse an agenda by name");
    CHECK(n.find("placeholder") != std::string::npos,
          "narrativePrompt must forbid unfilled placeholders");

    const std::string s = audionotes::summaryPrompt("ZZNARRATIVEZZ");
    CHECK(s.find("ZZNARRATIVEZZ") != std::string::npos, "summaryPrompt drops its input");
    CHECK(s.find("JSON") == std::string::npos, "summaryPrompt must not ask for JSON");
    // A length budget, and a hard one. Told only "2 to 3 sentences" the 1.5B model wrote eight
    // and ran into the token cap mid-clause.
    CHECK(s.find("70 words") != std::string::npos, "summaryPrompt must state a word budget");
    CHECK(s.find("at most 4 sentences") != std::string::npos,
          "summaryPrompt must cap the sentence count");

    const std::string h = audionotes::headlinePrompt("ZZSUMMARYZZ");
    CHECK(h.find("ZZSUMMARYZZ") != std::string::npos, "headlinePrompt drops its input");
    CHECK(h.find("15") != std::string::npos, "headlinePrompt must state a word budget");
  }

  // foldPlan: empty when the notes already fit; otherwise groups of >= 2 covering every note in
  // order, each group's joined length within budget.
  {
    std::vector<std::string> small = {std::string(10, 'a'), std::string(10, 'b')};
    CHECK(audionotes::foldPlan(small, 100).empty(), "foldPlan should be empty when notes fit");

    std::vector<std::string> big;
    for (int i = 0; i < 6; ++i) big.push_back(std::string(40, 'x'));
    const auto plan = audionotes::foldPlan(big, 100);
    CHECK(!plan.empty(), "foldPlan should group when notes exceed the budget");

    size_t covered = 0;
    int last = -1;
    for (const auto& group : plan) {
      CHECK(group.size() >= 2, "a fold group of one note does no work");
      size_t joined = 0;
      for (int idx : group) {
        CHECK(idx > last, "fold groups must cover notes in order without repeats");
        last = idx;
        joined += big[static_cast<size_t>(idx)].size() + 2;
        ++covered;
      }
      CHECK(joined <= 100 + 2, "fold group %zu exceeds the budget", joined);
    }
    CHECK(covered == big.size(), "foldPlan covered %zu of %zu notes", covered, big.size());

    // A single note larger than the whole budget cannot be folded with anything — it must not be
    // silently dropped, and it must not wedge the caller in an infinite fold loop.
    std::vector<std::string> huge = {std::string(500, 'y'), std::string(10, 'z')};
    const auto hplan = audionotes::foldPlan(huge, 100);
    for (const auto& group : hplan) CHECK(group.size() >= 2, "no single-note groups for oversize notes");
  }

  // foldPrompt keeps the notes format so folded output can be folded again.
  {
    const std::string f = audionotes::foldPrompt("ZZNOTESZZ");
    CHECK(f.find("ZZNOTESZZ") != std::string::npos, "foldPrompt drops its input");
    CHECK(f.find("DECISIONS") != std::string::npos, "foldPrompt must ask for the notes format back");
  }

  // stripMarkdown: the 1.5B model opens the narrative with "### Meeting Summary" despite
  // being told not to, and that heading is the first thing the reader sees.
  {
    using audionotes::stripMarkdown;
    CHECK(stripMarkdown("### Meeting Summary\n\nThe group met.") ==
              "Meeting Summary\n\nThe group met.",
          "heading marker not stripped");
    CHECK(stripMarkdown("**Meeting Topic:**\nThe group met.") ==
              "Meeting Topic:\nThe group met.",
          "bold markers not stripped");
    CHECK(stripMarkdown("Use the `--json` flag.") == "Use the --json flag.",
          "inline code ticks not stripped");
    CHECK(stripMarkdown("__Bold__ start.") == "Bold start.", "underscore emphasis not stripped");
    CHECK(stripMarkdown("No markdown at all.") == "No markdown at all.",
          "plain prose must pass through untouched");
    CHECK(stripMarkdown("A sentence with a # inside it.") == "A sentence with a # inside it.",
          "a mid-line hash is not a heading marker");
    CHECK(stripMarkdown("- one\n- two") == "- one\n- two",
          "bullet structure is left alone");
    // A horizontal rule is invisible in markdown and three literal dashes in plain text.
    CHECK(stripMarkdown("Above\n\n---\n\nBelow") == "Above\n\nBelow", "--- rule not dropped");
    CHECK(stripMarkdown("Above\n***\nBelow") == "Above\nBelow", "*** rule not dropped");
    CHECK(stripMarkdown("Above\n___\nBelow") == "Above\nBelow", "___ rule not dropped");
    CHECK(stripMarkdown("- a\n- b") == "- a\n- b", "a two-item bullet list is not a rule");
    CHECK(stripMarkdown("-- hyphens are not a rule") == "-- hyphens are not a rule",
          "a two-dash line with words is not a rule");
    CHECK(stripMarkdown("A\n\n\n\nB") == "A\n\nB", "blank-line runs should collapse");
    CHECK(stripMarkdown("\n\n  Body.  \n\n") == "Body.", "surrounding whitespace not trimmed");
    CHECK(stripMarkdown("").empty(), "empty in, empty out");
    CHECK(stripMarkdown("###").empty(), "a reply that is only a marker has no body");
  }

  // trimToSentence: a generation that runs into its token cap stops mid-word. The first summary
  // written on a real 18-minute meeting ended "...direct transfers to banks which", and that
  // fragment was shown to the reader.
  {
    using audionotes::trimToSentence;
    CHECK(trimToSentence("It was settled. Payment went to banks which") == "It was settled.",
          "a severed clause should be cut back to the last full sentence");
    CHECK(trimToSentence("The group met. They agreed.") == "The group met. They agreed.",
          "text that already ends on a sentence is left alone");
    CHECK(trimToSentence("The group met.  \n") == "The group met.",
          "trailing whitespace should not defeat the check");
    CHECK(trimToSentence("Was it settled? Not yet, because") == "Was it settled?",
          "a question mark ends a sentence");
    CHECK(trimToSentence("Stop! Then they went on to") == "Stop!",
          "an exclamation ends a sentence");
    // A dot inside a number or an abbreviation is not the end of a thought. Cutting there would
    // throw away a whole good sentence to save a fragment.
    CHECK(trimToSentence("The budget is 3.5 lakh and the team") ==
              "The budget is 3.5 lakh and the team",
          "a decimal point should not be read as a sentence end");
    CHECK(trimToSentence("He said \"we will ship it.\" Then he left the") ==
              "He said \"we will ship it.\"",
          "closing punctuation after the terminator is kept");
    CHECK(trimToSentence("One long clause with no end at all") ==
              "One long clause with no end at all",
          "with no terminator anywhere the text is returned untouched");
    CHECK(trimToSentence("").empty(), "empty in, empty out");
  }

  // stripLabels: told "no title, no heading" five ways, the model still opened with "Meeting
  // Summary" and labelled each paragraph by echoing the topics the instruction listed.
  {
    using audionotes::stripLabels;
    CHECK(stripLabels("Meeting Summary\n\nThe group met. They agreed.") ==
              "The group met. They agreed.",
          "a lead title over a blank line should be dropped");
    CHECK(stripLabels("What was settled:\nConsent forms were pre-printed.") ==
              "Consent forms were pre-printed.",
          "a section label should be dropped");
    CHECK(stripLabels("Title\n\nWhat was settled:\nIt shipped.") == "It shipped.",
          "a title and a label in the same answer both go");
    CHECK(stripLabels("The group met. They agreed.") == "The group met. They agreed.",
          "prose is left alone");
    // Without a blank line under it, a short opening line is a paragraph that has not reached its
    // full stop yet — not a heading.
    CHECK(stripLabels("The group met\nand then agreed.") == "The group met\nand then agreed.",
          "a wrapped opening line is not a title");
    CHECK(stripLabels("Ship it.\n\nThey agreed.") == "Ship it.\n\nThey agreed.",
          "a first line ending in a full stop is a sentence, not a title");
    // Length is the other guard: a real sentence that happens to end in a colon is prose.
    CHECK(stripLabels("The team raised one point that mattered more than all the others: cost.") ==
              "The team raised one point that mattered more than all the others: cost.",
          "a long line ending in a colon is prose");
    CHECK(stripLabels("").empty(), "empty in, empty out");
    CHECK(stripLabels("Meeting Summary").empty() == false,
          "a title with no body under it is all there is, so it stays");

    // Denied its placeholders, the model kept the header block and asserted the absence instead:
    // "Date & Time: Not specified", "Attendees: Not listed". Stating what was not said, as fact,
    // is the worse of the two failures.
    CHECK(stripLabels("Meeting Topic: Streamlining Registration\n"
                      "Date & Time: Not specified\n"
                      "Attendees: Not listed\n"
                      "\nThe group met. They agreed.") == "The group met. They agreed.",
          "the form header block should be dropped whole");
    // Below the first sentence the rule is off, so a colon in the body cannot trigger it.
    CHECK(stripLabels("They met. It went well.\nCost: still open") ==
              "They met. It went well.\nCost: still open",
          "a colon below the first sentence is body text");
    // A sentence that happens to contain a colon and runs to a full stop is prose wherever it is.
    CHECK(stripLabels("The problem: nobody owns it.") == "The problem: nobody owns it.",
          "a colon inside a finished sentence is not a form field");
  }

  // dropAbsenceTail: the model closes with a caveat about what the meeting did NOT do, which the
  // prompts forbid in five wordings and it writes anyway. It contradicts the Actions tab sitting
  // next to it.
  {
    using audionotes::dropAbsenceTail;
    CHECK(dropAbsenceTail("They agreed on the barcode. The session did not conclude specific "
                          "actions or decisions made.") == "They agreed on the barcode.",
          "a closing absence caveat should go");
    CHECK(dropAbsenceTail("They met. It shipped.") == "They met. It shipped.",
          "ordinary prose is left alone");
    // Two caveats in a row happen.
    CHECK(dropAbsenceTail("They agreed. No decisions were reached. Timing was not specified.") ==
              "They agreed.",
          "a second caveat behind the first should also go");
    // Only the CLOSING sentence is examined, so a caveat mid-text stays: cutting there would take
    // every good sentence after it too.
    CHECK(dropAbsenceTail("Timing was not specified. They agreed on the barcode.") ==
              "Timing was not specified. They agreed on the barcode.",
          "a caveat that is not the closing sentence is left alone");
    // A real refusal is content, not a caveat about the record.
    CHECK(dropAbsenceTail("They met. The team did not want to change the form.") ==
              "They met. The team did not want to change the form.",
          "an ordinary use of 'did not' is not an absence caveat");
    // Never return nothing: a single sentence, however unhelpful, is all there is.
    CHECK(dropAbsenceTail("No decisions were reached.") == "No decisions were reached.",
          "the only sentence is kept even when it is a caveat");
    CHECK(dropAbsenceTail("").empty(), "empty in, empty out");
  }

  // narrate() on a meeting that fits one prompt: the transcript goes straight to the narrative,
  // then summary, then headline, each fed the one above. No digest step and — critically — the
  // extraction notes never appear, because their list shape is what made the model answer with
  // "#### Actions:" instead of prose.
  {
    std::vector<std::string> seen;
    int n = 0;
    auto gen = [&](const std::string& p, int) {
      seen.push_back(p);
      return "GEN" + std::to_string(n++);
    };
    const auto out = audionotes::narrate({{"Hello there.", "S0"}}, {{"S0", "Ana"}}, gen);
    CHECK(seen.size() == 3, "narrate made %zu generate calls, want 3", seen.size());
    CHECK(seen[0].find("Ana: Hello there.") != std::string::npos,
          "the narrative should be written from the transcript itself");
    CHECK(seen[0].find("DECISIONS") == std::string::npos,
          "the narrative prompt must not carry the list-shaped notes format");
    CHECK(seen[1].find("GEN0") != std::string::npos, "summary should be fed the narrative");
    CHECK(seen[2].find("GEN1") != std::string::npos, "headline should be fed the summary");
    CHECK(out.narrative == "GEN0" && out.summary == "GEN1" && out.headline == "GEN2",
          "narrate returned the wrong generations");
  }

  // A long meeting is digested into PROSE per chunk, never into notes.
  {
    std::vector<std::string> seen;
    int n = 0;
    auto gen = [&](const std::string& p, int) {
      seen.push_back(p);
      return "GEN" + std::to_string(n++);
    };
    // Two chunks: each line is over half the 6000-char chunk budget.
    std::vector<audionotes::MinuteUtt> utts = {{std::string(4000, 'a'), ""},
                                               {std::string(4000, 'b'), ""}};
    audionotes::narrate(utts, {}, gen);
    CHECK(seen.size() == 5, "two chunks should be 2 digests + narrative + summary + headline, got %zu",
          seen.size());
    for (size_t i = 0; i < 2 && i < seen.size(); ++i) {
      CHECK(seen[i].find("DECISIONS") == std::string::npos,
            "digest %zu must not ask for the notes format", i);
      CHECK(seen[i].find("plain prose") != std::string::npos,
            "digest %zu should ask for prose", i);
    }
  }

  // A narrative that never arrives stops the chain — no summary built on nothing.
  {
    int calls = 0;
    auto gen = [&](const std::string&, int) { ++calls; return std::string(); };
    const auto out = audionotes::narrate({{"Hi.", ""}}, {}, gen);
    CHECK(out.narrative.empty() && out.summary.empty() && out.headline.empty(),
          "an empty narrative must not produce a summary or headline");
    CHECK(calls == 1, "narrate should stop after the failed narrative, made %d calls", calls);
  }

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_llm_minutes OK\n");
  return 0;
}
