// The three operations every engine's output goes through, in the order they must happen in.
// test_utf8 already covers sanitizeUtf8 and stripDialogueDash individually; this pins the
// COMPOSITION, which is the part an engine author could get wrong.
#include "asr/asr_postprocess.h"

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

static void expect(const std::string& in, const std::string& want, const char* what) {
  const std::string got = audionotes::normalizeSegmentText(in);
  CHECK(got == want, "%s: got \"%s\", want \"%s\"", what, got.c_str(), want.c_str());
}

int main() {
  expect(" Okay, let's ship on Friday.", "Okay, let's ship on Friday.", "leading space trimmed");
  expect(" - Design and what control?", "Design and what control?", "space then dialogue dash");
  expect("- Okay.", "Okay.", "dash with no leading space");
  expect("-5 degrees below", "-5 degrees below", "not a speaker mark, left alone");
  expect("", "", "empty");
  expect("   ", "  ", "only the FIRST leading space is trimmed");

  // Devanagari survives intact — the product's target audio must not be damaged in transit.
  expect("\xE0\xA4\xA8\xE0\xA4\xAE\xE0\xA4\xB8\xE0\xA5\x8D\xE0\xA4\xA4\xE0\xA5\x87",
         "\xE0\xA4\xA8\xE0\xA4\xAE\xE0\xA4\xB8\xE0\xA5\x8D\xE0\xA4\xA4\xE0\xA5\x87", "devanagari");

  // The byte that actually crashed a run, in the shape an engine hands it over.
  expect(" index \xB8 here", "index  here", "lone continuation byte scrubbed");
  expect(" truncated \xE0\xA4", "truncated ", "truncated sequence at end");

  // Scrub MUST run before the dash strip. stripDialogueDash walks forward over whitespace and
  // stops at the first non-space byte, returning the rest. Unscrubbed, that walk halts on the
  // broken \xE0\xA4 and returns it as the head of the string — reintroducing exactly the invalid
  // UTF-8 that makes json::dump throw and NewStringUTF abort the VM. Scrubbed first, the bad
  // bytes are gone before the walk, the whitespace is contiguous, and "ok" survives alone.
  expect(" - \xE0\xA4 ok", "ok", "scrub precedes dash strip");

  if (failures == 0) std::printf("test_asr_postprocess OK\n");
  return failures == 0 ? 0 : 1;
}
