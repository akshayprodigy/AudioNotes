// Rule-based items with their provenance. Parity port of src/pipeline/evidence.ts.
//
// The rules live in minutes_extractor.cpp and are not duplicated here; this file adds the
// bookkeeping, exactly as the TypeScript pair does.
#pragma once
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "minutes/minutes_extractor.h"  // MinuteUtt, MinuteSpk

namespace audionotes {

// A turn with the timing the extractor needs to anchor what it finds. MinuteUtt deliberately has
// no timings — extractMinutes never needed any — so this is the wider input, not a replacement.
struct TimedUtt {
  std::string id;
  int64_t start_ms = 0;
  int64_t end_ms = 0;
  std::string speaker_id;
  std::string text;
};

struct ItemSource {
  std::string utterance_id;  // convenience; re-minted every ASR run
  int64_t start_ms = 0;      // the anchor
  int64_t end_ms = 0;
  int32_t char_start = 0;    // UTF-16 code units, to match JavaScript's string indices
  int32_t char_end = 0;
};

struct DraftItem {
  std::string kind;  // decision | action | question
  std::string text;
  std::vector<ItemSource> sources;
  int64_t anchor_start_ms = 0;
  int64_t anchor_end_ms = 0;
};

// Offset of `sentence` within `text`, in UTF-16 code units. Falls back to a whitespace-insensitive
// scan, and to the whole turn when even that fails — a slightly wide anchor is honest, a missing
// one is not.
//
// `from` is a BYTE cursor into `text`; `*next_from` receives the byte offset just past the match.
// A cursor is what stops the same sentence repeated inside one turn reporting the FIRST
// occurrence's span for every repeat - whisper's repetition-loop failure mode, which this project
// has on record from the Galaxy A07. The TypeScript keeps its cursor in UTF-16 units and this one
// in bytes; both advance past the same match, so both find the same next occurrence.
//
// That equivalence is an ARGUMENT, not a measurement. It held for a while that the goldens pinned
// it; they did not - every turn in every fixture was ASCII, where the two units are the same
// number. The UTF-16 fixture row added in Task 2 is what actually tests it, and it carries an
// astral character on purpose: an em dash separates bytes from UTF-16 but NOT code points from
// UTF-16, so a port that decoded UTF-8 and counted characters - the well-intentioned wrong answer
// - passes everything else.
//
// A cursored search that fails is retried from 0 before the whole-turn fallback, so a sentence the
// cursor has already passed does not silently acquire the entire turn as its span.
//
// `text` must be the same string the needle was split out of, i.e. post-normalizeApostrophes; see
// the note in extractItems about why that does not move a single UTF-16 offset.
std::pair<int32_t, int32_t> sentenceSpan(const std::string& text, const std::string& sentence,
                                         size_t from = 0, size_t* next_from = nullptr);

std::vector<DraftItem> extractItems(const std::vector<TimedUtt>& utterances,
                                    const std::vector<MinuteSpk>& speakers = {});

}  // namespace audionotes
