// Replays the goldens written by src/pipeline/__tests__/minutes.golden.test.ts against the C++
// port. argv[1] = golden dir. Exits non-zero with a diff on the first mismatch.
#include "minutes/evidence.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "nlohmann/json.hpp"

using nlohmann::json;

static int failures = 0;
#define CHECK(cond, ...)                                        \
  do {                                                          \
    if (!(cond)) {                                              \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                        \
      std::fprintf(stderr, "\n");                               \
      ++failures;                                               \
    }                                                           \
  } while (0)

static json load(const std::string& dir, const char* name) {
  std::ifstream f(dir + "/" + name);
  if (!f) { std::fprintf(stderr, "missing golden %s\n", name); std::exit(2); }
  return json::parse(f);
}

static void runGolden(const std::string& dir, const char* name) {
  json g = load(dir, name);
  std::vector<audionotes::TimedUtt> utts;
  for (const auto& u : g["input"]["utterances"])
    utts.push_back({u["id"].get<std::string>(), u["startMs"].get<int64_t>(),
                    u["endMs"].get<int64_t>(),
                    u.contains("speakerId") && !u["speakerId"].is_null()
                        ? u["speakerId"].get<std::string>() : "",
                    u["text"].get<std::string>()});
  std::vector<audionotes::MinuteSpk> spks;
  for (const auto& s : g["input"]["speakers"])
    spks.push_back({s["id"].get<std::string>(), s["displayName"].get<std::string>()});

  auto got = audionotes::extractItems(utts, spks);
  const auto& want = g["output"];
  CHECK(got.size() == want.size(), "%s: size %zu != %zu", name, got.size(), want.size());
  for (size_t i = 0; i < got.size() && i < want.size(); ++i) {
    CHECK(got[i].kind == want[i]["kind"].get<std::string>(), "%s[%zu].kind '%s' != '%s'", name, i,
          got[i].kind.c_str(), want[i]["kind"].get<std::string>().c_str());
    CHECK(got[i].text == want[i]["text"].get<std::string>(), "%s[%zu].text\n  got: %s\n want: %s",
          name, i, got[i].text.c_str(), want[i]["text"].get<std::string>().c_str());
    CHECK(got[i].anchor_start_ms == want[i]["anchorStartMs"].get<int64_t>(),
          "%s[%zu].anchorStartMs %lld != %lld", name, i, (long long)got[i].anchor_start_ms,
          (long long)want[i]["anchorStartMs"].get<int64_t>());
    CHECK(got[i].anchor_end_ms == want[i]["anchorEndMs"].get<int64_t>(),
          "%s[%zu].anchorEndMs %lld != %lld", name, i, (long long)got[i].anchor_end_ms,
          (long long)want[i]["anchorEndMs"].get<int64_t>());
    const auto& ws = want[i]["sources"];
    CHECK(got[i].sources.size() == ws.size(), "%s[%zu].sources %zu != %zu", name, i,
          got[i].sources.size(), ws.size());
    for (size_t j = 0; j < got[i].sources.size() && j < ws.size(); ++j) {
      CHECK(got[i].sources[j].utterance_id == ws[j]["utteranceId"].get<std::string>(),
            "%s[%zu].sources[%zu].utteranceId '%s' != '%s'", name, i, j,
            got[i].sources[j].utterance_id.c_str(),
            ws[j]["utteranceId"].get<std::string>().c_str());
      CHECK(got[i].sources[j].start_ms == ws[j]["startMs"].get<int64_t>(),
            "%s[%zu].sources[%zu].startMs mismatch", name, i, j);
      CHECK(got[i].sources[j].end_ms == ws[j]["endMs"].get<int64_t>(),
            "%s[%zu].sources[%zu].endMs mismatch", name, i, j);
      CHECK(got[i].sources[j].char_start == ws[j]["charStart"].get<int32_t>(),
            "%s[%zu].sources[%zu].charStart %d != %d", name, i, j,
            got[i].sources[j].char_start, ws[j]["charStart"].get<int32_t>());
      CHECK(got[i].sources[j].char_end == ws[j]["charEnd"].get<int32_t>(),
            "%s[%zu].sources[%zu].charEnd %d != %d", name, i, j,
            got[i].sources[j].char_end, ws[j]["charEnd"].get<int32_t>());
    }
  }
}

// The JSON that crosses the JNI boundary.
//
// itemsToJson is the whole of the serialization: the JNI entry point calls it and does nothing
// else to the payload, so proving the JSON here leaves only the marshalling glue
// (GetArrayLength/GetObjectArrayElement/NewStringUTF) needing a phone. Field-for-field against the
// golden's own `output`, which is what the TypeScript wrote — the same standard runGolden holds
// the structs to, applied to the bytes.
static void runJsonGolden(const std::string& dir, const char* name) {
  json g = load(dir, name);
  std::vector<audionotes::TimedUtt> utts;
  for (const auto& u : g["input"]["utterances"])
    utts.push_back({u["id"].get<std::string>(), u["startMs"].get<int64_t>(),
                    u["endMs"].get<int64_t>(),
                    u.contains("speakerId") && !u["speakerId"].is_null()
                        ? u["speakerId"].get<std::string>() : "",
                    u["text"].get<std::string>()});
  std::vector<audionotes::MinuteSpk> spks;
  for (const auto& s : g["input"]["speakers"])
    spks.push_back({s["id"].get<std::string>(), s["displayName"].get<std::string>()});

  const std::string dumped = audionotes::itemsToJson(audionotes::extractItems(utts, spks));
  json got;
  try {
    got = json::parse(dumped);
  } catch (const std::exception& e) {
    CHECK(false, "%s: itemsToJson emitted unparseable JSON: %s\n%s", name, e.what(),
          dumped.c_str());
    return;
  }
  // Parsed and re-serialised on both sides, so key order and whitespace cannot make this pass or
  // fail — only the values can.
  CHECK(got == g["output"], "%s: JSON differs from the golden output\n  got: %s\n want: %s", name,
        got.dump().c_str(), g["output"].dump().c_str());
}

// The escaper, on the characters no golden happens to contain. A transcript reaches this from
// GetStringUTFChars, so it is valid (modified) UTF-8 and multi-byte sequences pass through as
// bytes; what has to be escaped is the ASCII control range, the quote and the backslash. An
// unescaped newline here is a JSONException on the Kotlin side and an empty items list in the app.
static void runJsonEscaping() {
  audionotes::DraftItem item;
  item.kind = "decision";
  item.text = "a\"b\\c\nd\te\rf\x01g \xE2\x80\x94 \xF0\x9F\x9A\x80";
  item.sources.push_back({"u\"0", 1, 2, 3, 4});
  item.anchor_start_ms = 1;
  item.anchor_end_ms = 2;

  const std::string dumped = audionotes::itemsToJson({item});
  json got;
  try {
    got = json::parse(dumped);
  } catch (const std::exception& e) {
    CHECK(false, "escaping: unparseable JSON: %s\n%s", e.what(), dumped.c_str());
    return;
  }
  CHECK(got.size() == 1, "escaping: %zu items", got.size());
  if (got.size() != 1) return;
  CHECK(got[0]["text"].get<std::string>() == item.text, "escaping: text did not round-trip\n  %s",
        got[0]["text"].dump().c_str());
  CHECK(got[0]["sources"][0]["utteranceId"].get<std::string>() == "u\"0",
        "escaping: utteranceId did not round-trip");
  // The em dash and the astral emoji must survive as themselves, not as \u escapes of the bytes.
  CHECK(dumped.find("\xE2\x80\x94") != std::string::npos, "escaping: em dash was mangled");
  CHECK(dumped.find("\xF0\x9F\x9A\x80") != std::string::npos, "escaping: astral char was mangled");
}

// Re-encode every astral character as a CESU-8 surrogate pair: the 4-byte UTF-8 sequence becomes
// two 3-byte sequences encoding the UTF-16 surrogate halves. Everything below U+10000 is copied
// through, so this is the identity on any ASCII or BMP text.
//
// Input must be well-formed UTF-8, which every golden is.
static std::string toCesu8(const std::string& in) {
  std::string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size();) {
    const unsigned char c = static_cast<unsigned char>(in[i]);
    size_t adv = 1;
    if (c >= 0xF0) adv = 4;
    else if (c >= 0xE0) adv = 3;
    else if (c >= 0xC0) adv = 2;
    if (adv != 4 || i + 4 > in.size()) {
      out.append(in, i, adv);
      i += adv;
      continue;
    }
    const uint32_t cp = ((c & 0x07u) << 18) |
                        ((static_cast<unsigned char>(in[i + 1]) & 0x3Fu) << 12) |
                        ((static_cast<unsigned char>(in[i + 2]) & 0x3Fu) << 6) |
                        (static_cast<unsigned char>(in[i + 3]) & 0x3Fu);
    const uint32_t v = cp - 0x10000u;
    const uint32_t hi = 0xD800u + (v >> 10), lo = 0xDC00u + (v & 0x3FFu);
    for (uint32_t sur : {hi, lo}) {
      out += static_cast<char>(0xE0u | (sur >> 12));
      out += static_cast<char>(0x80u | ((sur >> 6) & 0x3Fu));
      out += static_cast<char>(0x80u | (sur & 0x3Fu));
    }
    i += 4;
  }
  return out;
}

// The JNI boundary hands C++ MODIFIED UTF-8, not standard UTF-8: GetStringUTFChars encodes an
// astral character as a CESU-8 surrogate pair, six bytes, never the four a UTF-8 encoder writes.
// Every golden is produced by Node and read by nlohmann, so every fixture in this file feeds the
// FOUR-byte form. The encoding the app actually runs on is therefore the one nothing tested.
//
// This closes that. Nothing about CESU-8 needs a JVM — it is only a different byte sequence for
// the same string — so the property can be measured here rather than argued: the spans are
// offsets into the string being searched, and if they are stable across the two encodings then a
// device sees the same numbers a golden records.
//
// The claim being measured is that utf16Units answers 2 for both forms (one 4-byte lead counted 2,
// or two 3-byte leads counted 1 each) and that sentenceSpan is byte-self-consistent within
// whichever string it was handed. Both encodings must yield IDENTICAL char_start/char_end.
//
// If this ever fails, the port is wrong on every meeting containing an emoji and no golden can see
// it. That is the whole reason it is here.
static void runCesu8(const std::string& dir, const char* name) {
  // Pin the transcoder first: a toCesu8 that silently did nothing would make everything below
  // pass by construction. U+1F680 is F0 9F 9A 80 in UTF-8 and the surrogate pair U+D83D U+DE80 —
  // ED A0 BD ED BA 80 — in CESU-8.
  CHECK(toCesu8("\xF0\x9F\x9A\x80") == std::string("\xED\xA0\xBD\xED\xBA\x80", 6),
        "toCesu8 does not produce the surrogate pair");
  CHECK(toCesu8("Priya said \xE2\x80\x9Cship it\xE2\x80\x9D.") ==
            "Priya said \xE2\x80\x9Cship it\xE2\x80\x9D.",
        "toCesu8 disturbed a BMP-only string");

  json g = load(dir, name);
  std::vector<audionotes::TimedUtt> utts;
  for (const auto& u : g["input"]["utterances"])
    utts.push_back({u["id"].get<std::string>(), u["startMs"].get<int64_t>(),
                    u["endMs"].get<int64_t>(),
                    u.contains("speakerId") && !u["speakerId"].is_null()
                        ? u["speakerId"].get<std::string>() : "",
                    // The one difference from runGolden. Everything else is byte-identical.
                    toCesu8(u["text"].get<std::string>())});
  std::vector<audionotes::MinuteSpk> spks;
  for (const auto& s : g["input"]["speakers"])
    spks.push_back({s["id"].get<std::string>(), s["displayName"].get<std::string>()});

  auto got = audionotes::extractItems(utts, spks);
  const auto& want = g["output"];
  CHECK(got.size() == want.size(), "cesu8 %s: size %zu != %zu", name, got.size(), want.size());
  for (size_t i = 0; i < got.size() && i < want.size(); ++i) {
    CHECK(got[i].kind == want[i]["kind"].get<std::string>(), "cesu8 %s[%zu].kind", name, i);
    // The text comes back in the encoding it went in as, so the golden's own text is transcoded
    // for the comparison. Every other field must match the golden EXACTLY.
    CHECK(got[i].text == toCesu8(want[i]["text"].get<std::string>()),
          "cesu8 %s[%zu].text\n  got: %s\n want: %s", name, i, got[i].text.c_str(),
          toCesu8(want[i]["text"].get<std::string>()).c_str());
    CHECK(got[i].anchor_start_ms == want[i]["anchorStartMs"].get<int64_t>(),
          "cesu8 %s[%zu].anchorStartMs", name, i);
    CHECK(got[i].anchor_end_ms == want[i]["anchorEndMs"].get<int64_t>(),
          "cesu8 %s[%zu].anchorEndMs", name, i);
    const auto& ws = want[i]["sources"];
    CHECK(got[i].sources.size() == ws.size(), "cesu8 %s[%zu].sources %zu != %zu", name, i,
          got[i].sources.size(), ws.size());
    for (size_t j = 0; j < got[i].sources.size() && j < ws.size(); ++j) {
      CHECK(got[i].sources[j].utterance_id == ws[j]["utteranceId"].get<std::string>(),
            "cesu8 %s[%zu].sources[%zu].utteranceId", name, i, j);
      CHECK(got[i].sources[j].start_ms == ws[j]["startMs"].get<int64_t>(),
            "cesu8 %s[%zu].sources[%zu].startMs", name, i, j);
      CHECK(got[i].sources[j].end_ms == ws[j]["endMs"].get<int64_t>(),
            "cesu8 %s[%zu].sources[%zu].endMs", name, i, j);
      // The measurement. A byte-counting or codepoint-counting port answers a different number
      // here for one encoding than for the other, and the golden pins which one is right.
      CHECK(got[i].sources[j].char_start == ws[j]["charStart"].get<int32_t>(),
            "cesu8 %s[%zu].sources[%zu].charStart %d != %d (UTF-8 and CESU-8 DISAGREE)", name, i, j,
            got[i].sources[j].char_start, ws[j]["charStart"].get<int32_t>());
      CHECK(got[i].sources[j].char_end == ws[j]["charEnd"].get<int32_t>(),
            "cesu8 %s[%zu].sources[%zu].charEnd %d != %d (UTF-8 and CESU-8 DISAGREE)", name, i, j,
            got[i].sources[j].char_end, ws[j]["charEnd"].get<int32_t>());
    }
  }
}

// An empty run must be "[]", not "" — Kotlin's JSONArray("") throws, which would turn a meeting
// with nothing extractable into a crash rather than an empty list.
static void runJsonEmpty() {
  CHECK(audionotes::itemsToJson({}) == "[]", "empty: '%s' != '[]'",
        audionotes::itemsToJson({}).c_str());
}

// The exported surface, called directly rather than through extractItems.
//
// extractItems only ever hands sentenceSpan a trimmed, non-empty sentence found in the turn it
// came from, so the goldens cannot reach any of these. sentenceSpan is declared in evidence.h and
// ships in libaudionotes.so, and the all-whitespace case below was a heap read at map[SIZE_MAX]
// until the guard in findFrom went in: an empty needle makes find() return 0 rather than npos,
// and `at + needle.size() - 1` underflows. Run this under ASan; that is where it was caught.
static void runEdgeCases() {
  using audionotes::sentenceSpan;
  auto eq = [](std::pair<int32_t, int32_t> got, int32_t a, int32_t b, const char* what) {
    CHECK(got.first == a && got.second == b, "edge %s: (%d,%d) != (%d,%d)", what, got.first,
          got.second, a, b);
  };
  // Whitespace-only needle: the precondition violation. The whole-turn span, not a crash.
  eq(sentenceSpan("   ", "   "), 0, 3, "all-whitespace needle");
  // ...and again from a cursor, so BOTH the cursored search and the retry-from-0 return nullopt.
  eq(sentenceSpan("  x  ", "   ", 3), 0, 5, "all-whitespace needle, cursored");
  // Empty everything. The direct find of "" in "" succeeds at 0, so this never reaches the guard.
  eq(sentenceSpan("", ""), 0, 0, "empty text and needle");
  // Text that flattens to nothing: `map` is empty, and only the npos branch may touch it.
  eq(sentenceSpan("   ", "abc"), 0, 3, "unfindable needle, empty map");
  // A cursor past the end of the text: the retry from 0 is what finds it.
  size_t next = 0;
  eq(sentenceSpan("abc", "abc", 99, &next), 0, 3, "cursor past end");
  CHECK(next == 99, "edge cursor past end: next_from %zu != 99", next);
  // The collapsed scan across a non-breaking space, which is not isspace() whitespace: three
  // UTF-16 units over four bytes, so this also pins the unit conversion on the collapsed path.
  eq(sentenceSpan("a\xC2\xA0" "b", "a b"), 0, 3, "U+00A0 collapsed match");
}

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: test_evidence <golden-dir>\n"); return 2; }
  const std::string dir = argv[1];
  // This list must match exactly what src/pipeline/__tests__/minutes.golden.test.ts writes. A
  // golden the C++ never replays is not a parity test, it is a file - and the set grew after
  // review: cross-turn anchor widening, decision-over-action precedence, a null speakerId, an
  // empty input and the UTF-16 row were all added because a wrong port passed without them.
  // Check the writeEvidenceGolden calls in that file before trusting this list.
  runGolden(dir, "evidence_meeting.json");
  runGolden(dir, "evidence_dedup.json");
  runGolden(dir, "evidence_spans.json");
  runGolden(dir, "evidence_decision_dedup.json");
  runGolden(dir, "evidence_priority.json");
  runGolden(dir, "evidence_unassigned.json");
  runGolden(dir, "evidence_empty.json");
  runGolden(dir, "evidence_caps.json");
  runEdgeCases();
  // The serialization, on EVERY golden rather than a sample. The Android instrumentation test
  // replays these same files through the JNI boundary and asserts the same numbers, so pinning all
  // of them here means a failure over there is the marshalling and nothing else - which is the
  // only question a device can answer that the host cannot.
  runJsonGolden(dir, "evidence_meeting.json");
  runJsonGolden(dir, "evidence_dedup.json");
  runJsonGolden(dir, "evidence_spans.json");
  runJsonGolden(dir, "evidence_decision_dedup.json");
  runJsonGolden(dir, "evidence_priority.json");
  runJsonGolden(dir, "evidence_unassigned.json");
  runJsonGolden(dir, "evidence_empty.json");
  runJsonGolden(dir, "evidence_caps.json");
  runJsonEscaping();
  runJsonEmpty();
  // The same fixtures again in the encoding the JNI boundary actually delivers. evidence_spans is
  // the one that matters — it is the only golden carrying an astral character — and
  // evidence_meeting is the control, where toCesu8 is the identity and the run must be unchanged.
  runCesu8(dir, "evidence_spans.json");
  runCesu8(dir, "evidence_meeting.json");
  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_evidence: OK\n");
  return 0;
}
