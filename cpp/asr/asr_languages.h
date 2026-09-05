#pragma once

#include <string>
#include <vector>

namespace audionotes {

struct Language {
  std::string code;   // ISO 639-1, as whisper and Qwen both expect it
  std::string label;  // shown in the picker, in English
};

/**
 * The languages this product transcribes — not the languages the engine's tokenizer knows.
 *
 * The distinction is the whole point. whisper's table lists ~99 languages; asking it produced a
 * picker offering Bengali, and a Bengali meeting came back as fluent invented English with a
 * summary that read as correct to somebody who had been in the room. See
 * docs/superpowers/specs/2026-09-04-english-only-and-refusing-to-fabricate-design.md.
 *
 * Rows are added only when MEASURED, the same rule the engine routing table in asr_factory.cpp
 * follows. The two must never be able to disagree about what is supported.
 */
const std::vector<Language>& supportedLanguages();

/** Whether `code` is a language this product claims to transcribe. "" and "auto" are not. */
bool isSupported(const std::string& code);

/** One window's opinion: what was heard there, and how sure the detector was. */
struct LanguageHeard {
  std::string code;
  float confidence = 0.f;
};

/** What a set of windows collectively heard. */
struct LanguageVerdict {
  std::string code;    //: what most of the windows heard
  float mean_p = 0.f;  //: how sure they were, averaged over the windows that agreed
  int votes = 0;       //: how many agreed
  int samples = 0;     //: how many windows produced an answer at all
};

/**
 * Reduce several windows' opinions to one.
 *
 * Ties resolve to a SUPPORTED language on purpose. The two errors are not symmetric: wrongly
 * refusing costs somebody the meeting they just recorded, while wrongly transcribing costs a
 * reprocess once the language is supported.
 */
LanguageVerdict tallyLanguage(const std::vector<LanguageHeard>& heard);

/**
 * Whether to refuse a recording outright, given what the windows heard.
 *
 * Requires AGREEMENT, not just confidence: a strict majority of the windows that produced an
 * answer must have heard the same unsupported language, and been confident on average.
 *
 * One window is not evidence. A single 30-second sample of a real English meeting was heard as
 * Turkish at p=0.88 — past any threshold that would still catch the languages this exists to
 * catch — because the opening of a meeting is greetings, cross-talk and a microphone settling.
 */
bool shouldRefuse(const LanguageVerdict& verdict, float min_confidence);

}  // namespace audionotes
