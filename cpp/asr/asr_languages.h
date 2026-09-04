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

}  // namespace audionotes
