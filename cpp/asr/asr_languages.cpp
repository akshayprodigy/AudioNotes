#include "asr_languages.h"

namespace audionotes {
namespace {

// The table, and the evidence for every row.
//
// en: the only language with an accuracy number behind it — WER 29.7% over four AMI meetings
//     (eval/, slice 1). Far-field, multi-speaker, deliberately hard audio.
//
// Deliberately absent, and why:
//
// hi: Qwen3-ASR reads the 2026-08-19 recording at 69.8% Devanagari against whisper-base's 4.1%,
//     which says it writes the right SCRIPT. Nobody has scored it against a corrected ground truth,
//     so nothing says it writes the right WORDS. It returns the day there is a WER number, and it
//     is first in the queue.
//
// bn: measured 2026-09-04 on a real 61-minute meeting. whisper-base and whisper-small both produced
//     0.0% Bengali script; Qwen3-ASR produced 13.1% Bengali and 75% of characters in Devanagari and
//     Thai. Amplifying the audio by 21.6 dB changed nothing. We cannot do this language at all.
//
// Everything else: never measured. That is the only reason needed.
const std::vector<Language>& table() {
  static const std::vector<Language> kLanguages = {
      {"en", "English"},
  };
  return kLanguages;
}

}  // namespace

const std::vector<Language>& supportedLanguages() { return table(); }

bool isSupported(const std::string& code) {
  for (const Language& l : table()) {
    if (l.code == code) return true;
  }
  return false;
}

}  // namespace audionotes
