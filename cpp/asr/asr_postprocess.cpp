#include "asr/asr_postprocess.h"

#include "util/utf8.h"

namespace audionotes {

std::string normalizeSegmentText(const std::string& raw) {
  // Order matters and is preserved from whisper_asr.cpp: scrub first, because stripDialogueDash
  // walks forward over whitespace and STOPS at the first byte that is not a space. A broken byte
  // sitting after the dash would halt that walk and be returned as the head of the string, which
  // is precisely the invalid UTF-8 the scrub exists to remove.
  std::string s = sanitizeUtf8(raw);
  if (!s.empty() && s.front() == ' ') s.erase(0, 1);
  return stripDialogueDash(s);
}

}  // namespace audionotes
