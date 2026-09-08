// Parity port of src/pipeline/evidence.ts. The rules come from minutes_extractor.cpp via
// audionotes::rules; this file is bookkeeping only.
#include "minutes/evidence.h"

#include <algorithm>
#include <optional>
#include <unordered_map>

namespace audionotes {
namespace {

// UTF-16 code units in the first `bytes` bytes of s. JavaScript string indices are UTF-16 units,
// so a span measured in bytes would disagree with the golden on any non-ASCII turn. Code points
// are the well-intentioned wrong answer: they agree with UTF-16 on an em dash or a curly quote and
// disagree on an astral emoji, which is why evidence_spans.json carries one.
//
// `bytes` is always a character boundary at every call site (a find() hit, a map[] entry, or
// text.size()), so the loop's tendency to step past a boundary that splits a character never
// fires.
int32_t utf16Units(const std::string& s, size_t bytes) {
  int32_t n = 0;
  for (size_t i = 0; i < bytes && i < s.size();) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    size_t adv = 1;
    if (c >= 0xF0) adv = 4;
    else if (c >= 0xE0) adv = 3;
    else if (c >= 0xC0) adv = 2;
    n += (adv == 4) ? 2 : 1;  // astral codepoints are a surrogate PAIR in UTF-16
    i += adv;
  }
  return n;
}

// Mirrors the /\s\s|[^\S ]/ pre-check in the TypeScript: a run of two whitespace characters, or
// any whitespace that is not a plain space. Either is something collapseWhitespace would squash.
//
// Whitespace here is rules::jsWhitespaceLen, i.e. JavaScript's /\s/, and not isspace(): a turn
// carrying a non-breaking space is one where the collapsed scan is the ONLY scan that can find
// the sentence, and a byte-wise isspace would take the fast path instead and report the miss.
bool hasCollapsibleRun(const std::string& text, size_t begin, size_t end) {
  bool prev_space = false;
  for (size_t i = begin; i < end && i < text.size();) {
    const size_t w = rules::jsWhitespaceLen(text, i);
    if (w == 0) { prev_space = false; ++i; continue; }
    if (prev_space) return true;                // \s\s
    if (w != 1 || text[i] != ' ') return true;  // [^\S ]
    prev_space = true;
    i += w;
  }
  return false;
}

// The EARLIEST occurrence of `sentence` at or after byte `from`, as a byte range, or nullopt.
//
// Mirrors findFrom() in src/pipeline/evidence.ts and must keep its ordering: both a direct match
// and a whitespace-collapsed match are considered, and the one that STARTS EARLIER wins.
//
// Treating the direct hit as authoritative is wrong, and wrong in a way no ordinary fixture shows.
// A copy of the sentence carrying an internal whitespace run sits earlier in the turn, and only
// the collapsed scan can see it - so find() returns the LATER copy and two sources end up sharing
// one span. Measured on 'We agreed  to ship. We agreed to ship.' (two spaces in the first copy):
// the naive version anchors BOTH sources on the second occurrence.
std::optional<std::pair<size_t, size_t>> findFrom(const std::string& text,
                                                  const std::string& sentence, size_t from) {
  const size_t direct = text.find(sentence, from);

  // Fast path: no collapsible run anywhere in the region find() scanned, so nothing earlier can be
  // hiding behind a collapse and the direct hit is provably the earliest. Ordinary text takes this.
  if (direct != std::string::npos && !hasCollapsibleRun(text, from, direct + sentence.size())) {
    return std::make_pair(direct, direct + sentence.size());
  }

  // Collapsed scan: the squashed form alongside a map back to byte offsets.
  //
  // Built FROM `from`, not from 0 with a translated offset. The two are equivalent only because
  // every needle here is a trimmed sentence, and relying on that is how a port drifts: build the
  // window the TypeScript builds and the equivalence needs no argument.
  std::vector<size_t> map;
  std::string flat;
  bool was_space = false;
  for (size_t i = from; i < text.size();) {
    const size_t w = rules::jsWhitespaceLen(text, i);
    if (w) {
      // The whole run collapses to one flat space, anchored at the run's FIRST byte — the same
      // place the TypeScript anchors it, which is why a span can start on a collapsed space and
      // still point at the right character in the original turn.
      if (!was_space && !flat.empty()) { map.push_back(i); flat += ' '; }
      was_space = true;
      i += w;
    } else {
      was_space = false;
      map.push_back(i);
      flat += text[i];
      ++i;
    }
  }

  // rules::collapseWhitespace trims and the TypeScript's `sentence.replace(/\s+/g, ' ')` does not.
  // Unreachable while splitSentences supplies the needle - it trims - but the two DO diverge on
  // untrimmed input, so the trimmed-sentence precondition in the header is load-bearing here in a
  // way it is not in the TypeScript. Do not relax it on one side only.
  //
  // It is the splitter's own flattener, not a second copy of one: the needle must be flattened
  // exactly the way the haystack is scanned, or a sentence the splitter produced is unfindable in
  // the turn it came out of.
  const std::string needle = rules::collapseWhitespace(sentence);
  const size_t at = flat.find(needle);

  // No bounds guards on `map`, deliberately. map.size() == flat.size() by construction: every
  // branch that appends to `flat` pushes exactly one entry to `map`, and nothing else touches
  // either - so any index find() returns is in bounds. `needle` is never empty here because
  // extractItems drops sentences shorter than four characters. The TypeScript deleted its
  // equivalent guards after a 60,000-case fuzz confirmed the invariant; keeping them in one
  // language only is how a port acquires code that looks meaningful and is not.
  if (at == std::string::npos) {
    if (direct != std::string::npos) return std::make_pair(direct, direct + sentence.size());
    return std::nullopt;
  }
  const std::pair<size_t, size_t> collapsed{map[at], map[at + needle.size() - 1] + 1};
  if (direct != std::string::npos && direct <= collapsed.first) {
    return std::make_pair(direct, direct + sentence.size());
  }
  return collapsed;
}

}  // namespace

std::pair<int32_t, int32_t> sentenceSpan(const std::string& text, const std::string& sentence,
                                         size_t from, size_t* next_from) {
  auto finish = [&](size_t byte_start, size_t byte_end) {
    // std::max rather than a bare assignment, so an external caller cannot drive the cursor
    // backwards. Now that findFrom returns the EARLIEST match, extractItems can no longer overshoot
    // a findable sentence and the retry below is unreachable from it - so this is hygiene on an
    // exported function, not a correctness fix. The TypeScript says the same. Do not restate it as
    // preventing a re-scan of claimed ground: measured over 60,000 random turns, max and a bare
    // assignment differ on 2,610 of them and neither is reliably closer to the truth.
    if (next_from) *next_from = std::max(from, byte_end);
    return std::make_pair(utf16Units(text, byte_start), utf16Units(text, byte_end));
  };

  if (auto hit = findFrom(text, sentence, from)) return finish(hit->first, hit->second);
  // Retried from 0 rather than falling straight through: a sentence the cursor has already passed
  // must not silently acquire the whole turn as its span.
  if (from > 0) {
    if (auto hit = findFrom(text, sentence, 0)) return finish(hit->first, hit->second);
  }
  // Found nowhere at all. A slightly wide anchor is honest; a missing one is not.
  return finish(0, text.size());
}

std::vector<DraftItem> extractItems(const std::vector<TimedUtt>& utterances,
                                    const std::vector<MinuteSpk>& speakers) {
  std::unordered_map<std::string, std::string> name_by_id;
  for (const auto& s : speakers) name_by_id[s.id] = s.display_name;

  std::vector<DraftItem> decisions, actions, questions;
  std::vector<DraftItem>* const buckets[3] = {&decisions, &actions, &questions};
  // (bucket, index), never a pointer. Holding DraftItem* here and reserving the vectors up front
  // looks equivalent and is not: sentences per utterance is unbounded, so one long turn overflows
  // any reservation, reallocates, and dangles every pointer in the map. Silent UB that depends on
  // the shape of the input, which no golden can catch.
  std::unordered_map<std::string, std::pair<int, size_t>> by_key;

  auto add = [&](int bucket, const char* kind, const std::string& text, const ItemSource& src) {
    if (text.empty()) return;
    const std::string key = std::string(kind) + "|" + rules::norm(text);
    auto it = by_key.find(key);
    if (it != by_key.end()) {
      // Said twice. One item, two pieces of evidence, and an anchor widened to cover both — min
      // and max, not assignment: an item said at 1000-3000 and again at 8000-9500 anchors at
      // 1000-9500. (That envelope is for ordering and for drawing a range, never a play range;
      // see the DraftItem doc comment in evidence.ts.)
      DraftItem& existing = (*buckets[it->second.first])[it->second.second];
      existing.sources.push_back(src);
      existing.anchor_start_ms = std::min(existing.anchor_start_ms, src.start_ms);
      existing.anchor_end_ms = std::max(existing.anchor_end_ms, src.end_ms);
      return;
    }
    buckets[bucket]->push_back({kind, text, {src}, src.start_ms, src.end_ms});
    by_key[key] = {bucket, buckets[bucket]->size() - 1};
  };

  for (const auto& u : utterances) {
    std::string speaker_name;
    if (!u.speaker_id.empty()) {
      auto it = name_by_id.find(u.speaker_id);
      if (it != name_by_id.end()) speaker_name = it->second;
    }
    // The spans are measured against the apostrophe-normalized turn, not the raw one, because that
    // is the string splitSentences was handed and therefore the only one the needles are guaranteed
    // to occur in. It moves no offset the caller sees: normalizeApostrophes swaps one character for
    // one character (U+2019 -> '), so every UTF-16 index into `normalized` is the same index into
    // u.text. It does change the BYTES, which is the whole reason the conversion above is not
    // optional.
    const std::string normalized = rules::normalizeApostrophes(u.text);
    size_t cursor = 0;  // per turn, reset here; see the note on sentenceSpan
    for (const auto& sentence : rules::splitSentences(normalized)) {
      // JS: `sentence.length < 4`, and `.length` is UTF-16 units. Counting bytes here would keep a
      // three-emoji sentence the TypeScript drops. minutes_extractor.cpp's extractMinutes still
      // counts bytes at its own copy of this line; that is a pre-existing divergence from
      // minutes.ts and fixing it would change extractMinutes, which this port must not do.
      if (utf16Units(sentence, sentence.size()) < 4) continue;
      const auto span = sentenceSpan(normalized, sentence, cursor, &cursor);
      const ItemSource src{u.id, u.start_ms, u.end_ms, span.first, span.second};

      if (rules::isQuestion(sentence)) { add(2, "question", sentence, src); continue; }
      if (rules::isDecision(sentence)) { add(0, "decision", sentence, src); continue; }
      if (rules::isAction(sentence)) {
        const std::string owner = rules::detectOwner(sentence, speaker_name);
        std::string text = sentence + " \xE2\x80\x94 " + owner;  // " — <owner>"
        std::string due;
        if (rules::matchDue(sentence, &due)) text += " (due " + due + ")";
        add(1, "action", text, src);
      }
    }
  }

  // Same caps and same order as extractMinutes.
  if (decisions.size() > 20) decisions.resize(20);
  if (actions.size() > 30) actions.resize(30);
  if (questions.size() > 20) questions.resize(20);

  std::vector<DraftItem> out;
  out.insert(out.end(), decisions.begin(), decisions.end());
  out.insert(out.end(), actions.begin(), actions.end());
  out.insert(out.end(), questions.begin(), questions.end());
  return out;
}

}  // namespace audionotes
