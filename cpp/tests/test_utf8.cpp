// Whisper can emit a byte sequence that is not valid UTF-8 — most easily when a multi-byte
// character straddles a chunk boundary, which is why it took a Hindi/English meeting to find.
// Every consumer downstream treats a transcript as text and none of them survive that byte:
// nlohmann's dump() throws (uncaught -> SIGABRT, which is how this was found), and ART's
// NewStringUTF aborts the VM. So it gets scrubbed once, at the source.
#include "util/utf8.h"

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
  const std::string got = audionotes::sanitizeUtf8(in);
  CHECK(got == want, "%s: got %zu bytes, want %zu", what, got.size(), want.size());
}

int main() {
  using audionotes::sanitizeUtf8;
  using audionotes::validUtf8;

  // Text that is already fine must come back byte-identical, whatever script it is in.
  expect("Okay, let's ship on Friday.", "Okay, let's ship on Friday.", "ascii");
  expect("\xE0\xA4\xA8\xE0\xA4\xAE\xE0\xA4\xB8\xE0\xA5\x8D\xE0\xA4\xA4\xE0\xA5\x87",
         "\xE0\xA4\xA8\xE0\xA4\xAE\xE0\xA4\xB8\xE0\xA5\x8D\xE0\xA4\xA4\xE0\xA5\x87",
         "devanagari");
  expect("\xE2\x80\x94", "\xE2\x80\x94", "em dash");          // U+2014, minutes emit these
  expect("\xF0\x9F\x99\x82", "\xF0\x9F\x99\x82", "emoji");    // U+1F642, 4-byte

  // The byte that actually crashed the run: a lone continuation byte.
  expect("index \xB8 here", "index  here", "lone continuation byte 0xB8");

  // A multi-byte character cut short — the chunk-boundary case.
  expect("truncated \xE0\xA4", "truncated ", "truncated 3-byte sequence at end");
  expect("cut \xE0\xA4 off", "cut  off", "truncated 3-byte sequence mid-string");
  expect("\xF0\x9F\x99 x", " x", "truncated 4-byte sequence");

  // Malformed encodings a validator must reject even though the byte count looks right.
  expect("a\xC0\x80z", "az", "overlong two-byte NUL");
  expect("a\xE0\x80\xAFz", "az", "overlong three-byte");
  expect("a\xED\xA0\x80z", "az", "UTF-16 surrogate half");
  expect("a\xF5\x80\x80\x80z", "az", "beyond U+10FFFF");
  expect("a\xFEz", "az", "0xFE is never valid UTF-8");

  // Good text on both sides of the damage has to survive intact.
  expect("\xE0\xA4\xA8\xB8\xE0\xA4\xAE", "\xE0\xA4\xA8\xE0\xA4\xAE", "valid around invalid");

  // The count is what lets a run say how much it lost instead of silently swallowing it.
  size_t dropped = 0;
  sanitizeUtf8("ok \xB8\xB9 still ok", &dropped);
  CHECK(dropped == 2, "dropped %zu, want 2", dropped);
  sanitizeUtf8("all fine", &dropped);
  CHECK(dropped == 0, "dropped %zu on clean input, want 0", dropped);

  // A sanitized string is valid by construction — the property the crash sites depend on.
  const char* nasty[] = {"\xB8", "\xE0\xA4", "\xC0\x80", "\xED\xA0\x80", "\xF5\x80\x80\x80",
                         "a\xFE\xFF\xFEz", ""};
  for (const char* s : nasty) {
    CHECK(validUtf8(sanitizeUtf8(s)), "sanitized output still invalid for %p", (void*)s);
  }
  CHECK(!validUtf8("\xB8"), "validUtf8 accepted a lone continuation byte");
  CHECK(validUtf8("hello \xE2\x80\x94 world"), "validUtf8 rejected good text");

  // The dialogue dash whisper puts in front of a turn. These exact strings came off a real
  // export, where every other transcript line began with a stray hyphen.
  {
    using audionotes::stripDialogueDash;
    auto dash = [](const std::string& in, const std::string& want, const char* what) {
      const std::string got = stripDialogueDash(in);
      CHECK(got == want, "%s: got \"%s\", want \"%s\"", what, got.c_str(), want.c_str());
    };
    dash("- Okay.", "Okay.", "ascii dash");
    dash("- Design and what control?", "Design and what control?", "dash before a question");
    dash("-  I just got it.", "I just got it.", "two spaces");
    dash("\xE2\x80\x93 Okay.", "Okay.", "en dash");
    dash("\xE2\x80\x94 Okay.", "Okay.", "em dash");

    // Left alone: the space is what distinguishes a speaker mark from arithmetic, a hyphenated
    // fragment, or dictated punctuation.
    dash("-5 degrees below", "-5 degrees below", "no space, so not a speaker mark");
    dash("-ish, I would say", "-ish, I would say", "hyphenated fragment");
    dash("-- and then", "-- and then", "a run of dashes is not a speaker mark");
    dash("- ", "- ", "nothing follows the dash");
    dash("", "", "empty");
    dash("Okay.", "Okay.", "untouched when there is no dash");
    dash("well - not really", "well - not really", "a dash mid-sentence stays");
  }

  if (failures == 0) std::printf("test_utf8 OK\n");
  return failures == 0 ? 0 : 1;
}
