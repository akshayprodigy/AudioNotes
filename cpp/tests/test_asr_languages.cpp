// The list of languages this product claims to transcribe.
//
// Pinned because the failure it prevents is silent and expensive: whisper's tokenizer knows ~99
// languages, the picker used to offer all of them, and an hour-long Bengali meeting came back as
// fluent invented English with minutes that read as correct to somebody who had been in the room.
// Adding a row here without an eval number behind it should require deleting an assertion that
// says so out loud.
#include "asr/asr_languages.h"

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

  if (failures == 0) std::printf("test_asr_languages: OK\n");
  return failures == 0 ? 0 : 1;
}
