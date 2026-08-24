// Scrubbing text that came from a model before it crosses a boundary that assumes valid UTF-8.
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

}  // namespace audionotes
