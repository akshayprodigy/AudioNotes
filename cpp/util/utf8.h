// Scrubbing text that came from a model, at the one place it enters the app.
//
// Two different hazards, one rule: fix it once here rather than at each of the many places that
// later assume the text is clean.
//
// whisper.cpp returns raw decoded token bytes, and a multi-byte character split across a chunk
// boundary arrives as a fragment. Everything downstream assumes text: nlohmann::json::dump()
// throws type_error.316 on an invalid byte (uncaught, that is a SIGABRT after the whole meeting
// has been processed), and JNI's NewStringUTF aborts the ART VM. One scrub at the source is
// cheaper and safer than a guard at each of them.
#pragma once
#include <cstddef>
#include <string>

namespace audionotes {

// True if `s` is well-formed UTF-8: no overlong encodings, no surrogate halves, nothing past
// U+10FFFF, every continuation byte where one belongs.
bool validUtf8(const std::string& s);

// `s` with every byte that is not part of a well-formed UTF-8 sequence removed. A fragment of a
// character carries no meaning, so it is dropped rather than replaced — U+FFFD in a transcript
// would be scored as a word. When `dropped` is non-null it receives the number of bytes removed,
// so a caller can report damage instead of hiding it.
std::string sanitizeUtf8(const std::string& s, std::size_t* dropped = nullptr);

// `s` without the dialogue dash whisper puts at the head of a segment when it decides more than
// one person is talking: "- Okay.", "- Design and what control?".
//
// It is a transcription convention, not something anybody said, and it travels a long way. The
// minutes are extracted from this same text, so the dash reaches the PDF a customer is sent and
// reads there as a stray hyphen in front of every other line. Observed on a real export.
//
// Only a dash FOLLOWED BY WHITESPACE is removed, and only when something else follows it. That is
// the shape whisper emits, and requiring the space is what leaves "-5 degrees", a hyphenated
// fragment, and a lone "--" untouched. ASCII '-', U+2013 and U+2014 all count.
std::string stripDialogueDash(const std::string& s);

}  // namespace audionotes
