#include "util/utf8.h"

namespace audionotes {
namespace {

// Length of the well-formed UTF-8 sequence starting at `p`, or 0 if there is not one there.
// Range checks follow the Unicode table of well-formed byte sequences (D92): the second byte's
// legal range depends on the leader, which is what rejects overlongs, surrogates and >U+10FFFF
// without needing to decode the code point.
std::size_t sequenceLength(const unsigned char* p, std::size_t avail) {
  const unsigned char b0 = p[0];
  if (b0 < 0x80) return 1;                       // ASCII
  if (b0 < 0xC2) return 0;                       // continuation byte, or an overlong leader
  auto cont = [](unsigned char b, unsigned char lo, unsigned char hi) {
    return b >= lo && b <= hi;
  };
  if (b0 <= 0xDF) {                              // 2-byte: C2..DF 80..BF
    if (avail < 2 || !cont(p[1], 0x80, 0xBF)) return 0;
    return 2;
  }
  if (b0 <= 0xEF) {                              // 3-byte
    if (avail < 3) return 0;
    const unsigned char lo = (b0 == 0xE0) ? 0xA0 : 0x80;   // E0 A0..BF rejects overlongs
    const unsigned char hi = (b0 == 0xED) ? 0x9F : 0xBF;   // ED 80..9F rejects surrogates
    if (!cont(p[1], lo, hi) || !cont(p[2], 0x80, 0xBF)) return 0;
    return 3;
  }
  if (b0 <= 0xF4) {                              // 4-byte
    if (avail < 4) return 0;
    const unsigned char lo = (b0 == 0xF0) ? 0x90 : 0x80;   // F0 90..BF rejects overlongs
    const unsigned char hi = (b0 == 0xF4) ? 0x8F : 0xBF;   // F4 80..8F caps at U+10FFFF
    if (!cont(p[1], lo, hi) || !cont(p[2], 0x80, 0xBF) || !cont(p[3], 0x80, 0xBF)) return 0;
    return 4;
  }
  return 0;                                      // F5..FF are never valid
}

}  // namespace

bool validUtf8(const std::string& s) {
  const unsigned char* p = reinterpret_cast<const unsigned char*>(s.data());
  std::size_t i = 0;
  while (i < s.size()) {
    const std::size_t n = sequenceLength(p + i, s.size() - i);
    if (n == 0) return false;
    i += n;
  }
  return true;
}

std::string sanitizeUtf8(const std::string& s, std::size_t* dropped) {
  std::string out;
  out.reserve(s.size());
  const unsigned char* p = reinterpret_cast<const unsigned char*>(s.data());
  std::size_t i = 0, lost = 0;
  while (i < s.size()) {
    const std::size_t n = sequenceLength(p + i, s.size() - i);
    if (n == 0) {
      // Drop exactly one byte and re-sync: a valid sequence may start at the very next byte.
      ++i;
      ++lost;
      continue;
    }
    out.append(s, i, n);
    i += n;
  }
  if (dropped) *dropped = lost;
  return out;
}

}  // namespace audionotes
