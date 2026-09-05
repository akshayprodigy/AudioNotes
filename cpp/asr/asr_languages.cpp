#include "asr_languages.h"

#include <map>

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

LanguageVerdict tallyLanguage(const std::vector<LanguageHeard>& heard) {
  LanguageVerdict out;
  std::map<std::string, std::pair<int, float>> tally;  // code -> {votes, summed confidence}
  for (const LanguageHeard& h : heard) {
    if (h.code.empty()) continue;
    auto& slot = tally[h.code];
    slot.first += 1;
    slot.second += h.confidence;
    ++out.samples;
  }
  for (const auto& kv : tally) {
    const bool wins = kv.second.first > out.votes;
    const bool ties_but_supported =
        kv.second.first == out.votes && isSupported(kv.first) && !isSupported(out.code);
    if (wins || ties_but_supported) {
      out.code = kv.first;
      out.votes = kv.second.first;
      out.mean_p = kv.second.second / static_cast<float>(kv.second.first);
    }
  }
  return out;
}

bool shouldRefuse(const LanguageVerdict& verdict, float min_confidence) {
  if (verdict.code.empty() || verdict.samples <= 0) return false;
  if (isSupported(verdict.code)) return false;
  if (verdict.votes * 2 <= verdict.samples) return false;  // no majority
  return verdict.mean_p >= min_confidence;
}

}  // namespace audionotes
