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

  // ---- non-speech markers ----
  //
  // Measured: 120 seconds of room tone produced two "[BLANK_AUDIO]" utterances. That is whisper
  // correctly reporting that nothing was said, and us storing it as though somebody had.
  CHECK(audionotes::normalizeSegmentText("[BLANK_AUDIO]").empty(), "a blank-audio marker must not survive");
  CHECK(audionotes::normalizeSegmentText(" [BLANK_AUDIO] ").empty(), "padding must not save a marker");
  CHECK(audionotes::normalizeSegmentText("(upbeat music)").empty(), "a parenthesised annotation must not survive");
  CHECK(audionotes::normalizeSegmentText("[ Silence ]").empty(), "a spaced marker must not survive");

  // But only when the marker is the WHOLE segment: these carry real words.
  CHECK(audionotes::normalizeSegmentText("[laughs] yes, agreed") == "[laughs] yes, agreed",
        "a segment with words outside the brackets must be untouched");
  CHECK(audionotes::normalizeSegmentText("we shipped it (finally)") == "we shipped it (finally)",
        "a trailing parenthetical must be untouched");
  CHECK(audionotes::normalizeSegmentText("[a] and [b]") == "[a] and [b]",
        "two brackets with words between them must be untouched");

  // ---- subtitle speaker markers ----
  //
  // whisper was trained on subtitles and reproduces ">>" for "a new speaker starts here". We have
  // real diarization; the marker reached the transcript, the minutes and the clipboard.
  CHECK(audionotes::normalizeSegmentText(">> Computer security, and the rest.") == "Computer security, and the rest.",
        "a subtitle marker must be stripped");
  CHECK(audionotes::normalizeSegmentText(">>> Okay") == "Okay", "a triple marker must be stripped");
  CHECK(audionotes::normalizeSegmentText("- >> Okay") == "Okay", "dash then marker must both go");

  // The space is required, as it is for the dialogue dash: without it these would be mangled.
  CHECK(audionotes::normalizeSegmentText(">>=") == ">>=", "no space means it is not a speaker mark");
  CHECK(audionotes::normalizeSegmentText(">>") == ">>", "a bare marker with nothing behind it is left alone");
  CHECK(audionotes::normalizeSegmentText("a >> b") == "a >> b", "a marker mid-sentence must be left alone");

  // A marker wrapped in a marker still reduces to nothing.
  CHECK(audionotes::normalizeSegmentText(">> [BLANK_AUDIO]").empty(), "a marked-up blank must not survive");

  if (failures == 0) std::printf("test_asr_postprocess OK\n");
  return failures == 0 ? 0 : 1;
}
