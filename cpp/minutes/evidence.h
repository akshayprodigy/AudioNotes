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
  // Where the sentence sits inside that turn's text, in UTF-16 code units, to match JavaScript's
  // string indices. Highlight the turn with them; do not expect them to reproduce the item.
  //
  // DraftItem::text is NOT turn_text.substr(char_start, char_end - char_start). The offsets index
  // the turn as it was recorded, and the text comes from a normalized copy of it: U+2019 has been
  // folded to an ASCII apostrophe and every JavaScript-whitespace run collapsed to one space. So a
  // turn containing a curly apostrophe — most transcripts — slices back to a string that differs
  // from the item's own text at that character.
  //
  // This is a real divergence from src/pipeline/evidence.ts, not a restatement of a shared quirk.
  // There, item text keeps the curly apostrophe and the equality holds for any turn whose
  // whitespace is already single spaces; evidence.test.ts asserts it. It cannot hold here while
  // the rules run on bytes through std::regex and need the apostrophe folded before they match.
  //
  // A consumer that needs the exact spoken characters should slice the turn. A consumer that needs
  // the item should read DraftItem::text. A consumer that compares the two will be wrong roughly
  // as often as people use apostrophes.
  //
  // These offsets are STABLE ACROSS UTF-8 AND CESU-8 encodings of the same string, and that
  // property is load-bearing at the JNI boundary: GetStringUTFChars hands C++ modified UTF-8, so
  // an astral character arrives as a six-byte surrogate PAIR where a UTF-8 encoder writes four
  // bytes — and every golden here is written by Node, in the four-byte form. The app therefore
  // runs on the encoding no fixture contains.
  //
  // It holds for two reasons, and both are needed. utf16Units answers 2 for either form: one
  // 4-byte lead scores 2, and two 3-byte surrogate leads score 1 each. And sentenceSpan works in
  // bytes of whichever single string it was handed, converting to UTF-16 only at the end, so the
  // differing byte lengths never leak out.
  //
  // That was an argument until test_evidence's runCesu8 made it a measurement: it replays
  // evidence_spans.json with every astral character re-encoded as a surrogate pair and requires
  // char_start/char_end to come back IDENTICAL to the golden. Mutating utf16Units to score a
  // surrogate half as 2 fails that test in five places and leaves every golden green — which is
  // exactly how wrong this could have been while looking correct.
  int32_t char_start = 0;
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
// `text` must be the string the needle was split out of, or a per-character transform of it —
// extractItems passes the apostrophe-normalized turn and splits sentences out of a further
// whitespace-asciified copy, which is offset-identical. See the note there.
//
// `sentence` must be non-empty after whitespace collapse, i.e. it must contain at least one
// non-whitespace character. It is a precondition, not an input this validates: an empty or
// all-whitespace sentence returns the whole-turn span [0, utf16 length]. The TypeScript answers
// the same violation with NaN, so there is no shared behaviour to port — only a bounds check that
// C++ needs and JavaScript does not, because here the arithmetic would index a vector out of
// bounds rather than produce a wrong number.
std::pair<int32_t, int32_t> sentenceSpan(const std::string& text, const std::string& sentence,
                                         size_t from = 0, size_t* next_from = nullptr);

// The five parallel arrays the JNI boundary carries, zipped into turns.
//
// This exists so that "which array feeds which field" is host-testable. In the JNI function it was
// five subscripts inside a loop that no test on this machine could reach, and a transposition
// there — texts into speaker_id, ends into starts — compiles, runs, and produces plausible
// nonsense. Here a test can simply call it.
//
// ALL FIVE must be the same length; a mismatch throws std::invalid_argument. That is a deliberate
// change from tolerating a short array with a default. Every read was already bounds-guarded, so
// the old behaviour was never a bad access — it was worse than that: a short `starts_ms` anchored
// those items at 0, and an item said forty minutes in would send the player to the top of the
// meeting with nothing anywhere reporting a problem. The caller builds all five from one list, so
// a mismatch is a programming error and should say so.
//
// The speaker arrays are deliberately NOT held to this. A short spk_names costs an owner name —
// "Unassigned" instead of "Ana" — which is visibly wrong in the item text itself, and no amount of
// it can point a seek at the wrong second.
std::vector<TimedUtt> zipTurns(const std::vector<std::string>& ids,
                               const std::vector<int64_t>& starts_ms,
                               const std::vector<int64_t>& ends_ms,
                               const std::vector<std::string>& speaker_ids,
                               const std::vector<std::string>& texts);

std::vector<DraftItem> extractItems(const std::vector<TimedUtt>& utterances,
                                    const std::vector<MinuteSpk>& speakers = {});

// The items as the JSON that crosses the JNI boundary — an array of
// {kind, text, sources:[{utteranceId, startMs, endMs, charStart, charEnd}], anchorStartMs,
// anchorEndMs}, field-for-field the shape the goldens' `output` array carries. Empty input gives
// "[]", never "".
//
// JSON rather than the parallel string arrays the rest of the bridge exchanges (nativeVad,
// nativeDiarize, nativeMinutes) because an item has a VARIABLE number of sources: parallel arrays
// cannot express that without a second array of per-item source counts and matching index
// arithmetic on both sides of the boundary. One string is cheaper to get right, and the payload is
// a few kilobytes for a long meeting.
//
// It lives HERE rather than inline in the JNI function so it can be tested on the host: the
// goldens then pin the bytes as well as the structs, and the only thing left needing a device is
// the marshalling glue itself.
//
// Hand-rolled rather than nlohmann on purpose. This file is compiled into libaudionotes.so, and
// nlohmann is deliberately kept out of that library — ~200 KB of template machinery, which is why
// llm_prompts.cpp was split out of llm_minutes.cpp in the first place. Writing two field names in
// a loop does not justify reversing that.
//
// `text` is DraftItem::text and is NOT reconstructible by slicing the turn with charStart and
// charEnd; see the note on ItemSource above. It is carried explicitly for exactly that reason —
// no consumer on the far side should ever be in a position to re-derive it.
//
// Item text originates in a Java string (GetStringUTFChars) or in this file's own literals, so it
// is well-formed UTF-8 and multi-byte sequences are emitted as themselves. This function escapes
// the JSON metacharacters and the C0 control range and validates nothing else; it is not a
// sanitiser for engine output.
std::string itemsToJson(const std::vector<DraftItem>& items);

}  // namespace audionotes
