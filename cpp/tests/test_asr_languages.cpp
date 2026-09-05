// The list of languages this product claims to transcribe.
//
// Pinned because the failure it prevents is silent and expensive: whisper's tokenizer knows ~99
// languages, the picker used to offer all of them, and an hour-long Bengali meeting came back as
// fluent invented English with minutes that read as correct to somebody who had been in the room.
// Adding a row here without an eval number behind it should require deleting an assertion that
// says so out loud.
#include "asr/asr_languages.h"

#include "asr/asr_engine.h"

#include <cstdio>
#include <string>

static int failures = 0;
#define CHECK(cond, ...)                                        \
  do {                                                          \
    if (!(cond)) {                                              \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                        \
      std::fprintf(stderr, "\n");                               \
      ++failures;                                               \
    }                                                           \
  } while (0)

using audionotes::isSupported;
using audionotes::Language;
using audionotes::supportedLanguages;

int main() {
  // ---- what is offered ----
  const auto& langs = supportedLanguages();
  CHECK(langs.size() == 1, "expected exactly one supported language, got %zu", langs.size());
  CHECK(!langs.empty() && langs[0].code == "en", "the supported language must be English");
  CHECK(!langs.empty() && !langs[0].label.empty(), "every row needs a label for the picker");

  CHECK(isSupported("en"), "English must be supported");

  // ---- what must NOT be offered ----
  //
  // bn is named because it was offered and measured to fail completely: 0.0% Bengali script from
  // both whisper models. hi is named because it has script evidence (69.8% Devanagari) and no
  // accuracy number, which is not the same thing and must not be mistaken for it.
  for (const char* unmeasured : {"bn", "hi", "de", "es", "fr", "zh", "ar", "ja", "ru"}) {
    CHECK(!isSupported(unmeasured), "%s has no measurement behind it and must not be offered",
          unmeasured);
  }

  // ---- the absence of a choice is not a language ----
  CHECK(!isSupported("auto"), "'auto' is not a language and must not be supported");
  CHECK(!isSupported(""), "the empty string must not be supported");
  CHECK(!isSupported("EN"), "codes are compared exactly; the caller normalises");
  CHECK(!isSupported("english"), "codes are ISO 639-1, not names");

  // ---- no duplicates, which would show a language twice in the picker ----
  for (size_t i = 0; i < langs.size(); ++i) {
    for (size_t j = i + 1; j < langs.size(); ++j) {
      CHECK(langs[i].code != langs[j].code, "duplicate language code %s", langs[i].code.c_str());
    }
  }

  // ---- deciding a language from several windows ----
  //
  // The failure this exists to stop, reproduced exactly: a real English meeting on a Galaxy A07,
  // whose FIRST window was heard as Turkish at p=0.88 while every later window heard English.
  // The old code trusted that first window alone and refused the recording.
  {
    const audionotes::LanguageVerdict v = audionotes::tallyLanguage({
        {"tr", 0.88f}, {"en", 0.91f}, {"en", 0.86f}, {"en", 0.94f}, {"en", 0.77f}});
    CHECK(v.code == "en", "the majority language must win, got '%s'", v.code.c_str());
    CHECK(v.votes == 4 && v.samples == 5, "votes/samples wrong: %d/%d", v.votes, v.samples);
    CHECK(!audionotes::shouldRefuse(v, 0.60f), "an English meeting must NOT be refused");
  }

  // A genuinely unsupported recording still gets refused: agreement across windows.
  {
    const audionotes::LanguageVerdict v = audionotes::tallyLanguage({
        {"bn", 0.70f}, {"bn", 0.76f}, {"bn", 0.68f}, {"en", 0.55f}});
    CHECK(v.code == "bn", "the majority language must win, got '%s'", v.code.c_str());
    CHECK(audionotes::shouldRefuse(v, 0.60f), "a Bengali meeting must be refused");
  }

  // Confident but outnumbered: one loud wrong answer cannot refuse a recording.
  {
    const audionotes::LanguageVerdict v =
        audionotes::tallyLanguage({{"de", 0.99f}, {"en", 0.50f}, {"en", 0.52f}});
    CHECK(v.code == "en", "the majority must win even against a confident minority");
    CHECK(!audionotes::shouldRefuse(v, 0.60f), "a confident minority must not refuse");
  }

  // Agreed on an unsupported language, but unsure: ambiguity resolves to carrying on.
  {
    const audionotes::LanguageVerdict v = audionotes::tallyLanguage({{"bn", 0.40f}, {"bn", 0.45f}});
    CHECK(v.code == "bn", "tally should still report what was heard");
    CHECK(!audionotes::shouldRefuse(v, 0.60f), "low mean confidence must not refuse");
  }

  // A tie resolves to the supported language: refusing wrongly costs somebody their meeting.
  {
    const audionotes::LanguageVerdict v = audionotes::tallyLanguage({{"bn", 0.90f}, {"en", 0.90f}});
    CHECK(v.code == "en", "a tie must resolve to the supported language, got '%s'", v.code.c_str());
    CHECK(!audionotes::shouldRefuse(v, 0.60f), "a tie must not refuse");
  }

  // Nothing heard at all — silence, or a detector that could not tell. Never refuse on no evidence.
  {
    const audionotes::LanguageVerdict none = audionotes::tallyLanguage({});
    CHECK(none.samples == 0 && none.code.empty(), "an empty tally must be empty");
    CHECK(!audionotes::shouldRefuse(none, 0.60f), "no evidence must never refuse");
    const audionotes::LanguageVerdict blanks = audionotes::tallyLanguage({{"", 0.9f}, {"", 0.8f}});
    CHECK(blanks.samples == 0, "blank codes must not count as samples");
    CHECK(!audionotes::shouldRefuse(blanks, 0.60f), "blank codes must never refuse");
  }

  // A single window CAN still refuse when it is all there is (a very short recording), because
  // one sample is its own majority — but it must clear the confidence bar.
  {
    const audionotes::LanguageVerdict sure = audionotes::tallyLanguage({{"de", 0.99f}});
    CHECK(audionotes::shouldRefuse(sure, 0.60f), "a lone confident window may refuse");
    const audionotes::LanguageVerdict unsure = audionotes::tallyLanguage({{"de", 0.30f}});
    CHECK(!audionotes::shouldRefuse(unsure, 0.60f), "a lone unsure window must not refuse");
  }

  // Scattered guesses: the detector heard a different unsupported language in each window and
  // none of them leads. This is what ambiguous or noisy audio looks like, and it is the case the
  // majority rule exists for — the leader is unsupported, confident, and still not a majority.
  {
    const audionotes::LanguageVerdict v = audionotes::tallyLanguage(
        {{"bn", 0.90f}, {"bn", 0.88f}, {"de", 0.92f}, {"de", 0.91f}, {"tr", 0.95f}});
    CHECK(!audionotes::isSupported(v.code), "the leader here is an unsupported language");
    CHECK(v.votes * 2 <= v.samples, "the leader must not hold a majority: %d of %d", v.votes,
          v.samples);
    CHECK(!audionotes::shouldRefuse(v, 0.60f),
          "no language holding a majority must never refuse (leader '%s' %d/%d)", v.code.c_str(),
          v.votes, v.samples);
  }

  // ---- the override ----
  //
  // A wrong refusal used to be unrecoverable: Redo re-runs the same detection and reaches the same
  // verdict. The flag exists so a person who knows the recording was English can overrule it.
  //
  // Asserted against shouldRefuse rather than a whole transcribe() run because the decision is
  // pure and the run needs 60 MB of weights. What this pins is that the flag changes the DECISION
  // and nothing else — a bypass that also skipped detection could not tell anyone what was heard.
  {
    audionotes::LanguageVerdict turkish;
    turkish.code = "tr";
    turkish.mean_p = 0.95f;
    turkish.votes = 4;
    turkish.samples = 5;
    CHECK(audionotes::shouldRefuse(turkish, 0.7f),
          "a confident majority for an unsupported language must still refuse by default");

    audionotes::AsrConfig cfg;
    CHECK(!cfg.skip_language_refusal, "the override must be off unless somebody asks for it");
  }

  if (failures == 0) std::printf("test_asr_languages: OK\n");
  return failures == 0 ? 0 : 1;
}
