#include "asr/asr_postprocess.h"

#include "util/utf8.h"

namespace audionotes {
namespace {

/**
 * A copy without surrounding whitespace, FOR INSPECTION ONLY.
 *
 * Deliberately not applied to the returned text: callers hash this string to identify an action
 * item, so quietly re-trimming it would change the identity of items already extracted, and the
 * suite pins the existing "only the first leading space is trimmed" behaviour on purpose.
 */
std::string trimmedView(const std::string& s) {
  std::size_t b = 0;
  while (b < s.size() && (s[b] == ' ' || s[b] == '\t')) ++b;
  std::size_t e = s.size();
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\n' || s[e - 1] == '\r')) --e;
  return s.substr(b, e - b);
}

/**
 * Whether the WHOLE segment is a bracketed annotation: "[BLANK_AUDIO]", "(upbeat music)".
 *
 * whisper emits these to say there was nothing to transcribe, and they were being stored as though
 * somebody had said them — 120 seconds of room tone produced two "[BLANK_AUDIO]" utterances, which
 * is the model correctly reporting silence and us recording it as speech.
 *
 * Only when it is the whole segment. "[laughs] yes, agreed" carries real words and must survive,
 * so a segment with anything outside the brackets is left exactly as it is.
 */
bool wholeIsBracketed(const std::string& s) {
  if (s.size() < 2) return false;
  char close;
  if (s.front() == '[') close = ']';
  else if (s.front() == '(') close = ')';
  else return false;
  if (s.back() != close) return false;
  return s.find(close) == s.size() - 1;  // the only closing bracket is the final byte
}

/**
 * Drop a leading ">>" subtitle speaker marker.
 *
 * whisper was trained on subtitles and reproduces their convention for "a new speaker starts
 * here". We have real diarization for that, so the marker is noise — and it was reaching the
 * transcript, the minutes and the clipboard.
 *
 * Requires the space, exactly like stripDialogueDash: ">>" with text hard against it is far more
 * likely to be something dictated than a speaker mark.
 */
std::string stripSubtitleMarker(const std::string& s) {
  std::size_t n = 0;
  while (n < s.size() && s[n] == '>') ++n;
  if (n == 0) return s;

  std::size_t j = n;
  while (j < s.size() && (s[j] == ' ' || s[j] == '\t')) ++j;
  if (j == n || j >= s.size()) return s;  // no space after it, or nothing left behind it
  return s.substr(j);
}

}  // namespace

std::string normalizeSegmentText(const std::string& raw) {
  // Order matters and is preserved from whisper_asr.cpp: scrub first, because stripDialogueDash
  // walks forward over whitespace and STOPS at the first byte that is not a space. A broken byte
  // sitting after the dash would halt that walk and be returned as the head of the string, which
  // is precisely the invalid UTF-8 the scrub exists to remove.
  std::string s = sanitizeUtf8(raw);
  if (!s.empty() && s.front() == ' ') s.erase(0, 1);
  s = stripDialogueDash(s);
  // After the dash, so "- >> yes" is reduced the whole way rather than one layer at a time.
  s = stripSubtitleMarker(s);
  // Inspected trimmed, returned untrimmed: see trimmedView.
  if (wholeIsBracketed(trimmedView(s))) return std::string();
  return s;
}

}  // namespace audionotes
