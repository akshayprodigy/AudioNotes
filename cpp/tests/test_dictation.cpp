// Spoken punctuation, off a device and off a model.
#include "minutes/dictation.h"

#include <cstdio>
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

static void eq(const std::string& got, const std::string& want, int line) {
  if (got != want) {
    std::fprintf(stderr, "FAIL %s:%d:\n  got:  [%s]\n  want: [%s]\n", __FILE__, line, got.c_str(), want.c_str());
    ++failures;
  }
}
#define EQ(got, want) eq((got), (want), __LINE__)

int main() {
  // The worked example from the header.
  EQ(applySpokenPunctuation("we will not ship, full stop new paragraph tell finance comma the invoice is late question mark"),
     "We will not ship.\n\nTell finance, the invoice is late?");
  // The recogniser's own punctuation around a command is absorbed, not doubled.
  EQ(applySpokenPunctuation("I am unsure the table is ready. Full stop."), "I am unsure the table is ready.");
  EQ(applySpokenPunctuation("ready, comma, and then"), "Ready, and then");
  // Case does not matter; the next word is capitalised after a sentence mark, not after a comma.
  EQ(applySpokenPunctuation("first point FULL STOP second point comma third"), "First point. Second point, third");
  // Line breaks.
  EQ(applySpokenPunctuation("one new line two new paragraph three"), "One\nTwo\n\nThree");
  // "period" and "colon" are words, never commands; "mark" alone is a word.
  EQ(applySpokenPunctuation("the trial period ends and the colon is fine, mark it"), "the trial period ends and the colon is fine, mark it");
  // No command: byte for byte, including the lower-case start.
  EQ(applySpokenPunctuation("nothing to do here"), "nothing to do here");
  EQ(applySpokenPunctuation(""), "");
  // Exclamation, both spellings.
  EQ(applySpokenPunctuation("well done exclamation mark and again exclamation point"), "Well done! And again!");
  // A command inside a word is not a command.
  EQ(applySpokenPunctuation("the commander said"), "the commander said");

  if (failures) { std::fprintf(stderr, "test_dictation: %d failure(s)\n", failures); return 1; }
  std::puts("test_dictation: ok");
  return 0;
}
