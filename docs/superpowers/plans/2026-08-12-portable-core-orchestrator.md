# Portable Core Orchestrator (Phase 1 final slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the pipeline brain — stage sequencing, ASR↔speaker alignment, rule-based minutes, and the LLM map-reduce MOM — from Kotlin/TS into the shared C++ core behind an `extern "C"` facade, so the desktop CLI emits a complete MOM and every future shell (iOS/macOS/Windows, and later Android itself) binds to one identical brain.

**Architecture:** Three new core modules (`cpp/minutes/` rule extractor, `cpp/minutes/` LLM enhancer, `cpp/pipeline/` orchestrator) plus a thin C API (`cpp/capi/`). The C++ ports are **line-for-line parity ports** of `src/pipeline/minutes.ts` / `summarize.ts` (the same discipline `MinutesExtractor.kt` already follows — match the JS exactly, oddities included). Parity is *proven*, not assumed: a jest test runs the real TS against fixtures and writes golden JSON; C++ tests replay the goldens.

**Tech Stack:** C++17, std::regex (ECMAScript grammar — **no lookbehind**, see Task 3), nlohmann/json (vendored single header), ctest via the existing `cpp/cli/` CMake (SDK cmake+ninja at `~/Library/Android/sdk/cmake/3.22.1/bin`), jest (already configured) for golden generation.

**Scope boundary (agreed in roadmap §6 Phase 1):** the core is capture-agnostic — PCM in → transcript + speakers + minutes JSON out. DB writes, retitle, retention, and status bookkeeping stay app-side (`ProcessingEngine.kt` keeps them). Swapping Android's Kotlin `MinutesExtractor`/JNI onto the new facade is a **follow-up slice, not this plan**. Phase 1b scoring (WER/DER/MOM rubric) is also out — but the CLI's new `--json` output is deliberately the input format that harness will consume.

**Branch:** continue on `feat/portable-core` (no worktree needed — this branch is the isolation).

---

## Source-of-truth map (read before starting a task)

| Port target | Ported from | Parity notes |
|---|---|---|
| `cpp/minutes/minutes_extractor.{h,cpp}` | `src/pipeline/minutes.ts` (via `MinutesExtractor.kt`, a documented parity port with JS regexes in comments) | Priority question > decision > action; caps 30/20/20; dedup on `kind\|norm(content)`; summary counts from *trimmed* lists |
| `cpp/minutes/llm_minutes.{h,cpp}` | `src/pipeline/summarize.ts` | CHUNK_CHARS=6000; map 512 tok, reduce 768; placeholder-echo filter; LLM result **replaces** rule minutes only when parse succeeds (`PipelineController.ts:249-252`) |
| `cpp/pipeline/pipeline.{h,cpp}` align | `AudioDb.assignSpeakers` (`AudioDb.kt:245-286`) | Per utterance: sum overlap per cluster, max wins, no-overlap → unassigned; speakers numbered "Speaker 1..K" over clusters that own utterances, ascending cluster order |
| `cpp/pipeline/pipeline.{h,cpp}` stages | `ProcessingEngine.kt:74-161` order (VAD→ASR→diarize→minutes) | Stage skipping/resume/DB is app-side; core always runs all stages it has models for |
| `cpp/capi/audionotes_capi.{h,cpp}` | new (roadmap §6: "the stable boundary the JNI shim occupies today") | C-only header, opaque handle, JSON out |

---

### Task 1: Vendor nlohmann/json + ctest scaffolding

**Files:**
- Create: `cpp/third_party/nlohmann/json.hpp` (downloaded, committed — pinned v3.11.3)
- Modify: `cpp/cli/CMakeLists.txt` (append test scaffolding at end of file)

- [ ] **Step 1: Download the pinned single header**

```bash
mkdir -p cpp/third_party/nlohmann
curl -sL -o cpp/third_party/nlohmann/json.hpp \
  https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp
shasum -a 256 cpp/third_party/nlohmann/json.hpp
# Expected: 9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6
```

- [ ] **Step 2: Add ctest scaffolding to `cpp/cli/CMakeLists.txt`** (append at end)

```cmake
# --- Core unit tests (ctest). Plain assert-based executables, no framework dep. ---
enable_testing()
function(audionotes_add_test name)
  add_executable(${name} ${ARGN})
  target_include_directories(${name} PRIVATE ${CORE} ${CORE}/third_party)
  add_test(NAME ${name} COMMAND ${name} ${CMAKE_CURRENT_SOURCE_DIR}/../tests/golden)
endfunction()
```

(Each later task adds its `audionotes_add_test(...)` call next to this. Tests receive the golden dir as `argv[1]`.)

- [ ] **Step 3: Configure to prove the scaffolding parses**

```bash
export PATH=$HOME/Library/Android/sdk/cmake/3.22.1/bin:$PATH
cd cpp/cli && cmake -B build -G Ninja
```
Expected: `-- Configuring done` (no targets yet reference the function — that's fine).

- [ ] **Step 4: Commit**

```bash
git add cpp/third_party/nlohmann/json.hpp cpp/cli/CMakeLists.txt
git commit -m "chore(core): vendor nlohmann/json 3.11.3 + ctest scaffolding for core unit tests"
```

---

### Task 2: Golden fixtures from the real TS

The TS is the parity source. A jest test (jest is already configured; RN preset transpiles TS) runs `extractMinutes` + `parseMinutesJson` on fixtures and writes goldens the C++ tests replay. It stays committed as a TS regression lock — if minutes.ts changes, the goldens change, and the C++ parity test fails until re-ported. **Golden regeneration is manual** (`npx jest minutes.golden`), and goldens are committed.

**Files:**
- Create: `src/pipeline/__tests__/minutes.golden.test.ts`
- Create (generated, committed): `cpp/tests/golden/minutes_meeting.json`, `minutes_dedup.json`, `minutes_priority.json`, `parse_valid.json`, `parse_template_echo.json`, `parse_broken.json`, `parse_string_actions.json`, `parse_na_due.json`

- [ ] **Step 1: Write the golden generator test**

```typescript
// src/pipeline/__tests__/minutes.golden.test.ts
//
// Parity lock between src/pipeline/minutes.ts + summarize.ts and their C++ ports
// (cpp/minutes/). Runs the REAL TS on fixed fixtures and writes golden JSON that the C++
// tests (cpp/tests/) replay byte-for-byte. If you edit minutes.ts or summarize.ts:
//   npx jest minutes.golden   # regenerates goldens
// then re-run the C++ tests and fix the port until they pass again.
import * as fs from 'fs';
import * as path from 'path';
import { extractMinutes } from '../minutes';
import { parseMinutesJson } from '../summarize';

const GOLDEN_DIR = path.join(__dirname, '../../../cpp/tests/golden');

const SPEAKERS = [
  { id: 'S0', displayName: 'Speaker 1' },
  { id: 'S1', displayName: 'Speaker 2' },
];

const MEETING = [
  { text: "Alright team, let's kick off the design review. We have three items on the agenda today.", speakerId: 'S0' },
  { text: 'Thanks. First, the rollout plan. I think we should ship version 2.1 this Friday.', speakerId: 'S1' },
  { text: 'Agreed. We decided to go with the phased rollout. Can you also update the project roadmap by Thursday?', speakerId: 'S0' },
  { text: "Sure, I'll update the roadmap by Thursday. Maya will send the summary to everyone tomorrow.", speakerId: 'S1' },
  { text: 'What about the pricing question? Should we revisit it next week?', speakerId: 'S0' },
];

const DEDUP = [
  { text: "I'll send the report by Friday. I'll send the report by Friday.", speakerId: 'S0' },
  { text: "i'll send THE REPORT by friday!", speakerId: 'S1' },
];

const PRIORITY = [
  // question wins over action ("should we" is both QUESTION_WORDS and ACTION_OBLIGATION):
  { text: 'Should we update the roadmap?', speakerId: 'S0' },
  // decision wins over action ("we agreed" + "need to"):
  { text: 'We agreed that we need to ship on Friday.', speakerId: 'S1' },
];

const PARSE_CASES: Record<string, string> = {
  parse_valid:
    'Here are the minutes:\n{"summary":"Team reviewed the rollout.","decisions":["Ship 2.1 Friday"],' +
    '"actions":[{"text":"Update roadmap","owner":"Sam","due":"Thursday"}],"questions":["Revisit pricing?"]}\nDone.',
  parse_template_echo:
    '{"summary":"<2-3 sentence overview>","decisions":["..."],"actions":[{"text":"...","owner":"<who>","due":""}],"questions":[]}',
  parse_broken: 'DECISIONS: ship friday. no json here {oops',
  parse_string_actions: '{"summary":"S.","decisions":[],"actions":["Send the deck — Ana"],"questions":[]}',
  parse_na_due: '{"summary":"S.","decisions":[],"actions":[{"text":"Send deck","owner":"Ana","due":"N/A"}],"questions":[]}',
};

test('write golden files for the C++ parity tests', () => {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(GOLDEN_DIR, `${name}.json`), JSON.stringify(data, null, 1) + '\n');

  const meeting = extractMinutes(MEETING as any, SPEAKERS as any);
  write('minutes_meeting', { input: { utterances: MEETING, speakers: SPEAKERS }, output: meeting });
  expect(meeting.length).toBeGreaterThan(3);

  const dedup = extractMinutes(DEDUP as any, SPEAKERS as any);
  write('minutes_dedup', { input: { utterances: DEDUP, speakers: SPEAKERS }, output: dedup });
  // 3 sentences normalize to one key -> exactly 1 action + summary
  expect(dedup.filter(m => m.kind === 'action').length).toBe(1);

  const priority = extractMinutes(PRIORITY as any, SPEAKERS as any);
  write('minutes_priority', { input: { utterances: PRIORITY, speakers: SPEAKERS }, output: priority });
  expect(priority.filter(m => m.kind === 'action').length).toBe(0); // both classified away from action

  for (const [name, raw] of Object.entries(PARSE_CASES)) {
    write(name, { input: raw, output: parseMinutesJson(raw) });
  }
  expect(parseMinutesJson(PARSE_CASES.parse_template_echo)).toBeNull();
  expect(parseMinutesJson(PARSE_CASES.parse_broken)).toBeNull();
});
```

- [ ] **Step 2: Run it; inspect the goldens**

```bash
npx jest minutes.golden
cat cpp/tests/golden/minutes_meeting.json
```
Expected: PASS; `minutes_meeting.json` has a summary line, ≥1 decision ("We decided to go with the phased rollout."), actions with `— Speaker 1` / `— Maya` owners and `(due by Thursday)` / `(due tomorrow)` dues, and the two questions.

**If an expect fails** (i.e., the real TS behaves differently than this plan assumed): the TS is right, the plan is wrong — adjust the `expect(...)` to what the TS actually produced, look at the golden output to confirm it's sane, and carry the corrected expectation into the C++ test in Tasks 3-4.

- [ ] **Step 3: Commit generator + goldens**

```bash
git add src/pipeline/__tests__/minutes.golden.test.ts cpp/tests/golden/
git commit -m "test(minutes): golden fixtures generated from the real TS for C++ parity tests"
```

---

### Task 3: `MinutesExtractor` C++ port (rule-based floor)

**Files:**
- Create: `cpp/minutes/minutes_extractor.h`
- Create: `cpp/minutes/minutes_extractor.cpp`
- Create: `cpp/tests/test_minutes.cpp`
- Modify: `cpp/cli/CMakeLists.txt` (add test target)

**Two std::regex traps this port must handle (this is why it isn't a mechanical translation):**
1. **No lookbehind.** JS `SENTENCE_SPLIT = /(?<=[.!?])\s+/` cannot be expressed in std::regex. Hand-roll the splitter: normalize whitespace runs to a single space first, then break after any `.`/`!`/`?` that is followed by a space (consume the space). Identical semantics for normalized input.
2. **Multi-byte `’` in char classes.** Byte-oriented std::regex can't put U+2019 in `['’]`. Normalize `’` (UTF-8 `\xE2\x80\x99`) → `'` in each utterance's text once, up front, then use plain `'` in every pattern. (Whisper emits straight apostrophes; the normalization only matters for hand-typed transcripts. Deviation is output-visible only if the source text contained `’` — accepted.)

- [ ] **Step 1: Write the header**

```cpp
// cpp/minutes/minutes_extractor.h
// Rule-based minutes — the deterministic Free-tier floor. No model, no network.
// C++ parity port of src/pipeline/minutes.ts (same discipline as MinutesExtractor.kt: match the
// JS exactly, oddities included — see the golden tests in cpp/tests/test_minutes.cpp).
#pragma once
#include <string>
#include <vector>

namespace audionotes {

struct DraftMinute {
  std::string kind;     // summary | decision | action | question
  std::string content;
  std::string source;   // "rule" here; "llm" from llm_minutes
};

struct MinuteUtt {      // minimal utterance fields the extractor needs
  std::string text;
  std::string speaker_id;  // "" = none
};
struct MinuteSpk {
  std::string id;
  std::string display_name;
};

std::vector<DraftMinute> extractMinutes(const std::vector<MinuteUtt>& utterances,
                                        const std::vector<MinuteSpk>& speakers = {});

}  // namespace audionotes
```

- [ ] **Step 2: Write the failing golden test**

```cpp
// cpp/tests/test_minutes.cpp
// Replays the goldens written by src/pipeline/__tests__/minutes.golden.test.ts against the C++
// port. argv[1] = golden dir. Exits non-zero with a diff on the first mismatch.
#include "minutes/minutes_extractor.h"

#include <cstdio>
#include <fstream>
#include <string>

#include "nlohmann/json.hpp"

using nlohmann::json;

static int failures = 0;
#define CHECK(cond, ...)                                   \
  do {                                                     \
    if (!(cond)) {                                         \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                   \
      std::fprintf(stderr, "\n");                          \
      ++failures;                                          \
    }                                                      \
  } while (0)

static json load(const std::string& dir, const char* name) {
  std::ifstream f(dir + "/" + name);
  if (!f) { std::fprintf(stderr, "missing golden %s\n", name); std::exit(2); }
  return json::parse(f);
}

static void runMinutesGolden(const std::string& dir, const char* name) {
  json g = load(dir, name);
  std::vector<audionotes::MinuteUtt> utts;
  for (const auto& u : g["input"]["utterances"])
    utts.push_back({u["text"].get<std::string>(),
                    u.contains("speakerId") && !u["speakerId"].is_null()
                        ? u["speakerId"].get<std::string>() : ""});
  std::vector<audionotes::MinuteSpk> spks;
  for (const auto& s : g["input"]["speakers"])
    spks.push_back({s["id"].get<std::string>(), s["displayName"].get<std::string>()});

  auto got = audionotes::extractMinutes(utts, spks);
  const auto& want = g["output"];
  CHECK(got.size() == want.size(), "%s: size %zu != %zu", name, got.size(), want.size());
  for (size_t i = 0; i < got.size() && i < want.size(); ++i) {
    CHECK(got[i].kind == want[i]["kind"].get<std::string>(), "%s[%zu].kind '%s' != '%s'", name,
          i, got[i].kind.c_str(), want[i]["kind"].get<std::string>().c_str());
    CHECK(got[i].content == want[i]["content"].get<std::string>(), "%s[%zu].content\n  got: %s\n want: %s",
          name, i, got[i].content.c_str(), want[i]["content"].get<std::string>().c_str());
  }
}

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: test_minutes <golden-dir>\n"); return 2; }
  const std::string dir = argv[1];
  runMinutesGolden(dir, "minutes_meeting.json");
  runMinutesGolden(dir, "minutes_dedup.json");
  runMinutesGolden(dir, "minutes_priority.json");

  // Caps: 35 distinct action sentences -> 30 actions kept; summary counts the trimmed list.
  {
    std::vector<audionotes::MinuteUtt> many;
    for (int i = 0; i < 35; ++i)
      many.push_back({"We need to fix bug number " + std::to_string(i) + ".", ""});
    auto m = audionotes::extractMinutes(many, {});
    int actions = 0;
    for (const auto& d : m) if (d.kind == "action") ++actions;
    CHECK(actions == 30, "caps: got %d actions, want 30", actions);
    CHECK(!m.empty() && m[0].kind == "summary" &&
          m[0].content.rfind("30 action items", 0) == 0,
          "caps summary: '%s'", m.empty() ? "(empty)" : m[0].content.c_str());
  }

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_minutes OK\n");
  return 0;
}
```

Add to `cpp/cli/CMakeLists.txt` (after the scaffolding function):

```cmake
audionotes_add_test(test_minutes
  ${CORE}/../tests/test_minutes.cpp  # NOTE: adjust — see below
  ${CORE}/minutes/minutes_extractor.cpp)
```

**Path note:** `CORE` is `cpp/`, so the test file is `${CORE}/tests/test_minutes.cpp` if you create `cpp/tests/`. Use exactly:

```cmake
audionotes_add_test(test_minutes
  ${CORE}/tests/test_minutes.cpp
  ${CORE}/minutes/minutes_extractor.cpp)
```

- [ ] **Step 3: Run to verify it fails to build** (extractor not yet written)

```bash
cd cpp/cli && cmake -B build -G Ninja && cmake --build build --target test_minutes
```
Expected: FAIL — `minutes_extractor.cpp` missing.

- [ ] **Step 4: Write the implementation**

```cpp
// cpp/minutes/minutes_extractor.cpp
// Parity port of src/pipeline/minutes.ts. Each pattern carries its JS original in a comment.
// Two deliberate departures forced by std::regex (see header/tests): the sentence splitter is
// hand-rolled (no lookbehind), and U+2019 is normalized to ' before matching (no multi-byte
// char classes). Everything else matches the JS byte-for-byte.
#include "minutes/minutes_extractor.h"

#include <algorithm>
#include <cctype>
#include <regex>
#include <unordered_map>
#include <unordered_set>

namespace audionotes {
namespace {

// JS: /\b(i['’]ll|i will|i am going to|i'm going to|let me|we['’]ll|we will|we need to|let['’]s)\b/i
const std::regex ACTION_FIRST_PERSON(
    R"rx(\b(i'll|i will|i am going to|i'm going to|let me|we'll|we will|we need to|let's)\b)rx",
    std::regex::icase);
// JS: /\b(can you|could you|would you|please|you need to|you should|make sure (you|to)|assign(ed)? to)\b/i
const std::regex ACTION_ASSIGN(
    R"rx(\b(can you|could you|would you|please|you need to|you should|make sure (you|to)|assign(ed)? to)\b)rx",
    std::regex::icase);
// JS: /\b(need to|needs to|have to|has to|must|should|going to|will send|will get|will do|follow[- ]?up|action item|to-?do)\b/i
const std::regex ACTION_OBLIGATION(
    R"rx(\b(need to|needs to|have to|has to|must|should|going to|will send|will get|will do|follow[- ]?up|action item|to-?do)\b)rx",
    std::regex::icase);
// JS: /\b(we decided|the decision|we agreed|agreed to|let['’]s go with|we['’]ll go with|we chose|going with|we['’]re going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b/i
const std::regex DECISION(
    R"rx(\b(we decided|the decision|we agreed|agreed to|let's go with|we'll go with|we chose|going with|we're going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b)rx",
    std::regex::icase);
// JS DUE regex, verbatim (only ['’] simplified):
const std::regex DUE(
    R"rx(\b(today|tonight|tomorrow|this (morning|afternoon|evening|week|month)|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by (the )?(end of (the )?(day|week|month)|eod|cob|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|\w+day)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in \d+ (day|days|week|weeks)|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b)rx",
    std::regex::icase);
// JS: /\b([A-Z][a-z]{1,20})\s+(?:will|to|should|is going to|needs to|has to|can|could|please)\b/
// (case-SENSITIVE on purpose — capitalization is what marks a proper name)
const std::regex NAMED_OWNER(
    R"rx(\b([A-Z][a-z]{1,20})\s+(?:will|to|should|is going to|needs to|has to|can|could|please)\b)rx");
// JS: /^(what|why|how|when|where|who|which|should we|do we|can we|are we|is it|could we|would it)\b/i
const std::regex QUESTION_WORDS(
    R"rx(^(what|why|how|when|where|who|which|should we|do we|can we|are we|is it|could we|would it)\b)rx",
    std::regex::icase);
// JS: /^(I|We|You|The|This|That|It|Let|Please)$/  (case-sensitive)
const std::regex EXCLUDED_OWNER_WORDS(R"rx(^(I|We|You|The|This|That|It|Let|Please)$)rx");

const char* IMPERATIVE_VERBS[] = {
    "send", "prepare", "schedule", "email", "call", "review", "update", "create", "finish",
    "draft", "share", "set up", "book", "confirm", "check", "fix", "add", "remove", "ping",
};

// U+2019 (\xE2\x80\x99) -> ' so the patterns above can use plain apostrophes.
std::string normalizeApostrophes(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (i + 2 < s.size() && static_cast<unsigned char>(s[i]) == 0xE2 &&
        static_cast<unsigned char>(s[i + 1]) == 0x80 &&
        static_cast<unsigned char>(s[i + 2]) == 0x99) {
      out += '\'';
      i += 2;
    } else {
      out += s[i];
    }
  }
  return out;
}

std::string collapseWhitespace(const std::string& s) {
  std::string out;
  bool in_ws = false;
  for (char c : s) {
    if (std::isspace(static_cast<unsigned char>(c))) {
      in_ws = true;
    } else {
      if (in_ws && !out.empty()) out += ' ';
      in_ws = false;
      out += c;
    }
  }
  return out;
}

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

// JS: text.replace(/\s+/g,' ').split(/(?<=[.!?])\s+/).map(trim).filter(Boolean)
// Hand-rolled: after whitespace collapse, break after [.!?] followed by a space.
std::vector<std::string> splitSentences(const std::string& text) {
  const std::string t = collapseWhitespace(text);
  std::vector<std::string> out;
  std::string cur;
  for (size_t i = 0; i < t.size(); ++i) {
    cur += t[i];
    if ((t[i] == '.' || t[i] == '!' || t[i] == '?') && i + 1 < t.size() && t[i + 1] == ' ') {
      std::string s = trim(cur);
      if (!s.empty()) out.push_back(s);
      cur.clear();
      ++i;  // consume the space
    }
  }
  std::string s = trim(cur);
  if (!s.empty()) out.push_back(s);
  return out;
}

// JS: s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
std::string norm(const std::string& s) {
  std::string lowered;
  lowered.reserve(s.size());
  for (char c : s) lowered += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  std::string out;
  bool in_run = false;
  for (char c : lowered) {
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      in_run = false;
      out += c;
    } else if (!in_run) {
      in_run = true;
      out += ' ';
    }
  }
  return trim(out);
}

bool startsWithImperative(const std::string& sentence) {
  std::string first = trim(sentence);
  for (char& c : first) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  for (const char* v : IMPERATIVE_VERBS) {
    if (first.rfind(std::string(v) + " ", 0) == 0) return true;
  }
  return false;
}

std::string detectOwner(const std::string& sentence, const std::string& speaker_name) {
  std::smatch m;
  if (std::regex_search(sentence, m, NAMED_OWNER)) {
    const std::string n = m[1].str();
    if (!std::regex_match(n, EXCLUDED_OWNER_WORDS)) return n;
  }
  if (std::regex_search(sentence, ACTION_FIRST_PERSON) && !speaker_name.empty()) return speaker_name;
  if (std::regex_search(sentence, ACTION_ASSIGN)) return "Unassigned";
  return "Unassigned";
}

bool isAction(const std::string& sentence) {
  return std::regex_search(sentence, ACTION_FIRST_PERSON) ||
         std::regex_search(sentence, ACTION_ASSIGN) ||
         std::regex_search(sentence, ACTION_OBLIGATION) || startsWithImperative(sentence);
}

bool isQuestion(const std::string& sentence) {
  const std::string t = trim(sentence);
  if (!t.empty() && t.back() == '?') return true;
  return std::regex_search(t, QUESTION_WORDS) && t.size() < 160;
}

}  // namespace

std::vector<DraftMinute> extractMinutes(const std::vector<MinuteUtt>& utterances,
                                        const std::vector<MinuteSpk>& speakers) {
  std::unordered_map<std::string, std::string> name_by_id;
  for (const auto& s : speakers) name_by_id[s.id] = s.display_name;

  std::vector<DraftMinute> actions, decisions, questions;
  std::unordered_set<std::string> seen;

  auto add = [&seen](std::vector<DraftMinute>& arr, const std::string& kind,
                     const std::string& content) {
    const std::string key = kind + "|" + norm(content);
    if (content.empty() || seen.count(key)) return;
    seen.insert(key);
    arr.push_back({kind, content, "rule"});
  };

  for (const auto& u : utterances) {
    std::string speaker_name;
    if (!u.speaker_id.empty()) {
      auto it = name_by_id.find(u.speaker_id);
      if (it != name_by_id.end()) speaker_name = it->second;
    }

    for (const auto& sentence : splitSentences(normalizeApostrophes(u.text))) {
      if (sentence.size() < 4) continue;

      if (isQuestion(sentence)) {
        add(questions, "question", sentence);
        continue;  // a question is not also an action
      }
      if (std::regex_search(sentence, DECISION)) {
        add(decisions, "decision", sentence);
        continue;
      }
      if (isAction(sentence)) {
        const std::string owner = detectOwner(sentence, speaker_name);
        std::smatch due;
        std::string content = sentence + " \xE2\x80\x94 " + owner;  // " — <owner>"
        if (std::regex_search(sentence, due, DUE)) content += " (due " + due[0].str() + ")";
        add(actions, "action", content);
      }
    }
  }

  if (actions.size() > 30) actions.resize(30);
  if (decisions.size() > 20) decisions.resize(20);
  if (questions.size() > 20) questions.resize(20);

  DraftMinute summary{
      "summary",
      std::to_string(actions.size()) + " action item" + (actions.size() == 1 ? "" : "s") + ", " +
          std::to_string(decisions.size()) + " decision" + (decisions.size() == 1 ? "" : "s") +
          ", " + std::to_string(questions.size()) + " open question" +
          (questions.size() == 1 ? "" : "s") + ".",
      "rule"};

  std::vector<DraftMinute> out;
  out.push_back(summary);
  out.insert(out.end(), decisions.begin(), decisions.end());
  out.insert(out.end(), actions.begin(), actions.end());
  out.insert(out.end(), questions.begin(), questions.end());
  return out;
}

}  // namespace audionotes
```

**Note the em dash:** the JS emits `" — ${owner}"` — U+2014 as UTF-8 `\xE2\x80\x94`. The golden comparison is byte-exact; a plain `-` fails the test.

- [ ] **Step 5: Build + run the test until it passes**

```bash
cmake --build build --target test_minutes && ctest --test-dir build -R test_minutes --output-on-failure
```
Expected: `test_minutes OK`, ctest `100% tests passed`. If a golden mismatch prints, diff the strings — most likely suspects are sentence-split boundaries and the em dash/due formatting.

- [ ] **Step 6: Commit**

```bash
git add cpp/minutes/minutes_extractor.h cpp/minutes/minutes_extractor.cpp cpp/tests/test_minutes.cpp cpp/cli/CMakeLists.txt
git commit -m "feat(core): C++ MinutesExtractor — parity port of minutes.ts, golden-tested against the real TS"
```

---

### Task 4: LLM minutes (map-reduce) C++ port

**Files:**
- Create: `cpp/minutes/llm_minutes.h`
- Create: `cpp/minutes/llm_minutes.cpp`
- Create: `cpp/tests/test_llm_minutes.cpp`
- Modify: `cpp/cli/CMakeLists.txt` (add test target)

- [ ] **Step 1: Write the header**

```cpp
// cpp/minutes/llm_minutes.h
// LLM minutes enhancement — chunked map-reduce over the transcript. Parity port of
// src/pipeline/summarize.ts. Strictly best-effort: on generation/parse failure callers keep the
// rule-based minutes (the guaranteed floor). Takes an injected generate fn so it is testable
// without llama.
#pragma once
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "minutes/minutes_extractor.h"  // DraftMinute, MinuteUtt, MinuteSpk

namespace audionotes {

// (prompt, max_tokens) -> generated text. Wraps LlamaEngine::generate in production.
using GenerateFn = std::function<std::string(const std::string&, int)>;

std::vector<std::string> transcriptLines(const std::vector<MinuteUtt>& utterances,
                                         const std::vector<MinuteSpk>& speakers);
std::vector<std::string> chunkTranscript(const std::vector<std::string>& lines,
                                         size_t max_chars = 6000);
std::string mapPrompt(const std::string& chunk);
std::string reducePrompt(const std::string& notes);

// Returns std::nullopt when nothing parses / everything is placeholder — caller keeps the floor.
std::optional<std::vector<DraftMinute>> parseMinutesJson(const std::string& raw);

std::optional<std::vector<DraftMinute>> enhanceMinutes(const std::vector<MinuteUtt>& utterances,
                                                       const std::vector<MinuteSpk>& speakers,
                                                       const GenerateFn& generate);

}  // namespace audionotes
```

- [ ] **Step 2: Write the failing test**

```cpp
// cpp/tests/test_llm_minutes.cpp
// Golden parity for parseMinutesJson (fixtures from summarize.ts via the jest golden test) plus
// direct unit tests for chunking and the map/reduce plumbing (fake generate fn).
#include "minutes/llm_minutes.h"

#include <cstdio>
#include <fstream>
#include <string>

#include "nlohmann/json.hpp"

using nlohmann::json;

static int failures = 0;
#define CHECK(cond, ...)                                   \
  do {                                                     \
    if (!(cond)) {                                         \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                   \
      std::fprintf(stderr, "\n");                          \
      ++failures;                                          \
    }                                                      \
  } while (0)

static void runParseGolden(const std::string& dir, const char* name) {
  std::ifstream f(dir + "/" + name);
  if (!f) { std::fprintf(stderr, "missing golden %s\n", name); std::exit(2); }
  json g = json::parse(f);
  auto got = audionotes::parseMinutesJson(g["input"].get<std::string>());
  if (g["output"].is_null()) {
    CHECK(!got.has_value(), "%s: expected null, got %zu minutes", name,
          got ? got->size() : 0);
    return;
  }
  CHECK(got.has_value(), "%s: expected minutes, got null", name);
  if (!got) return;
  const auto& want = g["output"];
  CHECK(got->size() == want.size(), "%s: size %zu != %zu", name, got->size(), want.size());
  for (size_t i = 0; i < got->size() && i < want.size(); ++i) {
    CHECK((*got)[i].kind == want[i]["kind"].get<std::string>(), "%s[%zu].kind", name, i);
    CHECK((*got)[i].content == want[i]["content"].get<std::string>(),
          "%s[%zu].content\n  got: %s\n want: %s", name, i, (*got)[i].content.c_str(),
          want[i]["content"].get<std::string>().c_str());
    CHECK((*got)[i].source == "llm", "%s[%zu].source", name, i);
  }
}

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: test_llm_minutes <golden-dir>\n"); return 2; }
  const std::string dir = argv[1];
  runParseGolden(dir, "parse_valid.json");
  runParseGolden(dir, "parse_template_echo.json");
  runParseGolden(dir, "parse_broken.json");
  runParseGolden(dir, "parse_string_actions.json");
  runParseGolden(dir, "parse_na_due.json");

  // chunkTranscript: lines pack up to max_chars with '\n' joins; oversize single line stays whole.
  {
    std::vector<std::string> lines = {std::string(10, 'a'), std::string(10, 'b'),
                                      std::string(10, 'c')};
    auto chunks = audionotes::chunkTranscript(lines, 25);
    CHECK(chunks.size() == 2, "chunking: got %zu chunks, want 2", chunks.size());
    CHECK(chunks[0] == std::string(10, 'a') + "\n" + std::string(10, 'b'), "chunk[0] content");
    CHECK(chunks[1] == std::string(10, 'c'), "chunk[1] content");
  }

  // transcriptLines: names resolve; missing speaker -> "Speaker".
  {
    auto lines = audionotes::transcriptLines(
        {{"Hello.", "S0"}, {"World.", ""}},
        {{"S0", "Speaker 1"}});
    CHECK(lines.size() == 2 && lines[0] == "Speaker 1: Hello." && lines[1] == "Speaker: World.",
          "transcriptLines: %s | %s", lines[0].c_str(), lines[1].c_str());
  }

  // enhanceMinutes single-chunk path: notes = raw chunk (no map), one reduce call at 768 tokens.
  {
    int calls = 0;
    std::string seen_prompt;
    auto fake = [&](const std::string& prompt, int max_tokens) {
      ++calls;
      seen_prompt = prompt;
      CHECK(max_tokens == 768, "single-chunk reduce max_tokens %d != 768", max_tokens);
      return std::string(
          "{\"summary\":\"Short meeting.\",\"decisions\":[],\"actions\":[],\"questions\":[]}");
    };
    auto out = audionotes::enhanceMinutes({{"Hi there.", "S0"}}, {{"S0", "Speaker 1"}}, fake);
    CHECK(calls == 1, "single-chunk path made %d generate calls, want 1", calls);
    CHECK(seen_prompt.find("Speaker 1: Hi there.") != std::string::npos, "notes not in prompt");
    CHECK(out && out->size() == 1 && (*out)[0].kind == "summary", "single-chunk parse");
  }

  // enhanceMinutes empty input -> nullopt.
  CHECK(!audionotes::enhanceMinutes({}, {}, [](const std::string&, int) { return std::string(); }),
        "empty utterances must return nullopt");

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_llm_minutes OK\n");
  return 0;
}
```

CMake addition:

```cmake
audionotes_add_test(test_llm_minutes
  ${CORE}/tests/test_llm_minutes.cpp
  ${CORE}/minutes/llm_minutes.cpp
  ${CORE}/minutes/minutes_extractor.cpp)
```

- [ ] **Step 3: Verify it fails to build** (`llm_minutes.cpp` missing)

```bash
cmake -B build -G Ninja && cmake --build build --target test_llm_minutes
```
Expected: FAIL.

- [ ] **Step 4: Write the implementation**

```cpp
// cpp/minutes/llm_minutes.cpp
// Parity port of src/pipeline/summarize.ts. The prompt strings are copied VERBATIM from the TS —
// they are model-tuned artifacts, not prose to be improved. See summarize.ts for the reasoning
// on the placeholder filter (small models echo the template shape back).
#include "minutes/llm_minutes.h"

#include <regex>
#include <unordered_map>

#include "nlohmann/json.hpp"

namespace audionotes {
namespace {

using nlohmann::json;

// JS: !/[a-z0-9]/i.test(text.replace(/<[^>]*>/g, ''))
bool isPlaceholder(const std::string& text) {
  static const std::regex ANGLE(R"rx(<[^>]*>)rx");
  static const std::regex ALNUM(R"rx([a-z0-9])rx", std::regex::icase);
  return !std::regex_search(std::regex_replace(text, ANGLE, ""), ALNUM);
}

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

// Tolerant string read: JSON strings pass through, everything else -> "".
std::string asString(const json& v) {
  if (v.is_string()) return v.get<std::string>();
  return "";
}

}  // namespace

std::vector<std::string> transcriptLines(const std::vector<MinuteUtt>& utterances,
                                         const std::vector<MinuteSpk>& speakers) {
  std::unordered_map<std::string, std::string> name_by_id;
  for (const auto& s : speakers) name_by_id[s.id] = s.display_name;
  std::vector<std::string> out;
  out.reserve(utterances.size());
  for (const auto& u : utterances) {
    std::string who = "Speaker";
    if (!u.speaker_id.empty()) {
      auto it = name_by_id.find(u.speaker_id);
      if (it != name_by_id.end()) who = it->second;
    }
    out.push_back(who + ": " + u.text);
  }
  return out;
}

std::vector<std::string> chunkTranscript(const std::vector<std::string>& lines,
                                         size_t max_chars) {
  std::vector<std::string> chunks;
  std::string cur;
  for (const auto& line : lines) {
    if (cur.size() + line.size() + 1 > max_chars && !cur.empty()) {
      chunks.push_back(cur);
      cur.clear();
    }
    cur += (cur.empty() ? "" : "\n") + line;
  }
  if (!cur.empty()) chunks.push_back(cur);
  return chunks;
}

std::string mapPrompt(const std::string& chunk) {
  return "Below is part of a meeting transcript. Extract only what is explicitly stated. "
         "List decisions, action items (with owner and any due date), and open questions. "
         "Be concise and factual; do not invent anything.\n\n"
         "TRANSCRIPT:\n" + chunk + "\n\n"
         "Format:\nDECISIONS:\n- ...\nACTIONS:\n- <task> \xE2\x80\x94 <owner> (due <when>)\nQUESTIONS:\n- ...";
}

std::string reducePrompt(const std::string& notes) {
  return "These are notes from consecutive parts of ONE meeting. Merge them into final minutes. "
         "Remove duplicates. Only include what the notes support.\n\n"
         "NOTES:\n" + notes + "\n\n"
         "Respond with ONLY a JSON object, no prose, in exactly this shape. Replace every "
         "angle-bracket description with real text from the notes, and use an empty array when a "
         "section has nothing in it:\n"
         "{\"summary\":\"<2-3 sentence overview>\",\"decisions\":[\"<a decision that was made>\"],"
         "\"actions\":[{\"text\":\"<what will be done>\",\"owner\":\"<who>\",\"due\":\"<when, or empty>\"}],"
         "\"questions\":[\"<a question left unanswered>\"]}";
}

std::optional<std::vector<DraftMinute>> parseMinutesJson(const std::string& raw) {
  const size_t start = raw.find('{');
  const size_t end = raw.rfind('}');
  if (start == std::string::npos || end == std::string::npos || end <= start) return std::nullopt;

  json obj = json::parse(raw.substr(start, end - start + 1), nullptr, /*allow_exceptions=*/false);
  if (obj.is_discarded() || !obj.is_object()) return std::nullopt;

  std::vector<DraftMinute> out;
  auto push = [&out](const std::string& kind, const std::string& content) {
    const std::string c = trim(content);
    if (!c.empty() && !isPlaceholder(c)) out.push_back({kind, c, "llm"});
  };

  if (obj.contains("summary")) push("summary", asString(obj["summary"]));
  if (obj.contains("decisions") && obj["decisions"].is_array())
    for (const auto& d : obj["decisions"])
      push("decision", d.is_string() ? d.get<std::string>()
                                     : (d.is_object() && d.contains("text") ? asString(d["text"]) : ""));
  if (obj.contains("actions") && obj["actions"].is_array()) {
    for (const auto& a : obj["actions"]) {
      if (a.is_string()) {
        push("action", a.get<std::string>());
      } else if (a.is_object()) {
        // Judge each field BEFORE composing (see summarize.ts isPlaceholder note): the em dash
        // and the literal word "due" we add are letters the filter would count as content.
        const std::string text = trim(a.contains("text") ? asString(a["text"]) : "");
        if (text.empty() || isPlaceholder(text)) continue;
        std::string s = text;
        const std::string owner = trim(a.contains("owner") ? asString(a["owner"]) : "");
        if (!owner.empty() && !isPlaceholder(owner)) s += " \xE2\x80\x94 " + owner;
        const std::string due = trim(a.contains("due") ? asString(a["due"]) : "");
        static const std::regex NA(R"rx(^n/?a$)rx", std::regex::icase);
        if (!due.empty() && !isPlaceholder(due) && !std::regex_match(due, NA)) s += " (due " + due + ")";
        push("action", s);
      }
    }
  }
  if (obj.contains("questions") && obj["questions"].is_array())
    for (const auto& q : obj["questions"])
      push("question", q.is_string() ? q.get<std::string>()
                                     : (q.is_object() && q.contains("text") ? asString(q["text"]) : ""));

  if (out.empty()) return std::nullopt;
  return out;
}

std::optional<std::vector<DraftMinute>> enhanceMinutes(const std::vector<MinuteUtt>& utterances,
                                                       const std::vector<MinuteSpk>& speakers,
                                                       const GenerateFn& generate) {
  if (utterances.empty()) return std::nullopt;
  const auto lines = transcriptLines(utterances, speakers);
  const auto chunks = chunkTranscript(lines);

  std::string notes;
  if (chunks.size() == 1) {
    notes = chunks[0];
  } else {
    for (size_t i = 0; i < chunks.size(); ++i) {
      if (i) notes += "\n\n";
      notes += generate(mapPrompt(chunks[i]), 512);
    }
  }
  return parseMinutesJson(generate(reducePrompt(notes), 768));
}

}  // namespace audionotes
```

**Parity caveat to verify against the golden, not assume:** JS `parseMinutesJson` accepts non-string scalars via `(content ?? '').toString()` (a number 42 becomes "42"); `asString` above returns "" for them. None of the fixtures exercise that path — if you want it covered, add a fixture in Task 2 and match the JS behavior (`v.is_number() ? std::to_string(...)`).

- [ ] **Step 5: Build + run to pass**

```bash
cmake --build build --target test_llm_minutes && ctest --test-dir build -R test_llm_minutes --output-on-failure
```
Expected: `test_llm_minutes OK`.

- [ ] **Step 6: Commit**

```bash
git add cpp/minutes/llm_minutes.h cpp/minutes/llm_minutes.cpp cpp/tests/test_llm_minutes.cpp cpp/cli/CMakeLists.txt
git commit -m "feat(core): C++ LLM minutes map-reduce — parity port of summarize.ts incl. placeholder-echo filter"
```

---

### Task 5: The Pipeline orchestrator

**Files:**
- Create: `cpp/pipeline/pipeline.h`
- Create: `cpp/pipeline/pipeline.cpp`
- Create: `cpp/tests/test_pipeline_align.cpp`
- Delete: `cpp/audionotes_core.h` (unimplemented sketch; only `cpp/README.md` references it)
- Modify: `cpp/README.md` (point at `pipeline/pipeline.h` + `capi/audionotes_capi.h` instead)
- Modify: `cpp/cli/CMakeLists.txt` (add test target)

- [ ] **Step 1: Write the header**

```cpp
// cpp/pipeline/pipeline.h
// The shared brain: PCM in -> transcript + speakers + minutes out. Capture-agnostic — every
// platform shell (desktop CLI today; Android JNI / iOS / Windows next) drives this same class, so
// the pipeline behaves identically everywhere. DB writes, retitling, retention and status
// bookkeeping are deliberately NOT here — they are app concerns (see ProcessingEngine.kt).
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "asr/whisper_asr.h"   // Utterance {start_ms,end_ms,text}
#include "vad/silero_vad.h"    // Segment
#include "minutes/minutes_extractor.h"  // DraftMinute

namespace audionotes {

struct AlignedUtterance {
  int64_t start_ms;
  int64_t end_ms;
  int speaker;  // diar cluster index; -1 = unassigned
  std::string text;
};

struct PipelineConfig {
  std::string asr_model;      // required
  std::string vad_model;      // "" = skip VAD, fall back to fixed 30 s windows
  std::string diar_seg_model; // both diar paths "" = skip diarization
  std::string diar_emb_model;
  std::string llm_model;      // "" = rule-based minutes only
  int num_speakers = 0;       // 0 = auto clustering
  int sample_rate = 16000;
  int asr_threads = 0;        // 0 = engine default
  int llm_threads = 4;
  int llm_n_ctx = 8192;       // mirrors LlmModule.kt
};

// progress(stage, done, total); stage in: "vad" | "asr" | "diarize" | "minutes"
// (the same stage names ProcessingEngine.Listener.onStage emits on Android).
using PipelineProgressFn = std::function<void(const std::string&, int, int)>;

struct PipelineResult {
  int64_t audio_ms = 0;
  std::vector<Segment> segments;             // VAD speech spans
  std::vector<AlignedUtterance> transcript;  // ASR + speaker alignment
  std::vector<DraftMinute> minutes;          // summary/decisions/actions/questions
  std::string minutes_source;                // "llm" | "rule" | "" (no transcript)
  // Per-stage wall-clock ms (same rationale as ProcessingEngine's stageDone logging).
  int64_t vad_ms = 0, asr_ms = 0, diar_ms = 0, minutes_ms = 0;
};

// Pure function, exposed for tests: max-summed-overlap speaker assignment.
// Port of AudioDb.assignSpeakers (AudioDb.kt:245-286): per utterance, sum the temporal overlap
// with each cluster's diar segments; the cluster with the greatest sum wins; no overlap -> -1.
std::vector<AlignedUtterance> alignSpeakers(const std::vector<Utterance>& utts,
                                            const std::vector<DiarSegment>& diar);

// Cluster -> "Speaker N" display names, numbered 1..K over the clusters that actually own
// utterances, ascending cluster index (parity with AudioDb's create-then-drop-empty-then-renumber).
std::vector<MinuteSpk> speakerNames(const std::vector<AlignedUtterance>& transcript);

class Pipeline {
 public:
  explicit Pipeline(PipelineConfig cfg) : cfg_(std::move(cfg)) {}

  // Runs vad -> asr -> diarize -> align -> minutes over a headerless PCM16 mono file.
  // Returns false only on fatal setup errors (model failed to load); error() explains.
  // Missing optional models degrade exactly like Android: no VAD model -> 30 s windows,
  // no diar models -> all speakers -1, no LLM -> rule minutes.
  bool run(const std::string& pcm_path, PipelineResult* out,
           const PipelineProgressFn& progress = nullptr);

  const std::string& error() const { return error_; }

 private:
  PipelineConfig cfg_;
  std::string error_;
};

}  // namespace audionotes
```

(`DiarSegment` comes from `diar/diarizer.h` — add `#include "diar/diarizer.h"` to the header's includes.)

- [ ] **Step 2: Write the failing align test**

```cpp
// cpp/tests/test_pipeline_align.cpp
#include "pipeline/pipeline.h"

#include <cstdio>

static int failures = 0;
#define CHECK(cond, ...)                                   \
  do {                                                     \
    if (!(cond)) {                                         \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                   \
      std::fprintf(stderr, "\n");                          \
      ++failures;                                          \
    }                                                      \
  } while (0)

int main() {
  using audionotes::Utterance;
  using audionotes::DiarSegment;

  // Utterance A overlaps cluster 0 for 800ms and cluster 1 for 200ms -> 0.
  // Utterance B overlaps only cluster 1 -> 1. Utterance C overlaps nothing -> -1.
  std::vector<Utterance> utts = {
      {0, 1000, "A"}, {1500, 2500, "B"}, {5000, 6000, "C"}};
  std::vector<DiarSegment> diar = {
      {0, 800, 0}, {800, 1000, 1}, {1400, 2600, 1}};
  auto aligned = audionotes::alignSpeakers(utts, diar);
  CHECK(aligned.size() == 3, "size %zu", aligned.size());
  CHECK(aligned[0].speaker == 0, "A -> %d, want 0", aligned[0].speaker);
  CHECK(aligned[1].speaker == 1, "B -> %d, want 1", aligned[1].speaker);
  CHECK(aligned[2].speaker == -1, "C -> %d, want -1", aligned[2].speaker);
  CHECK(aligned[0].text == "A" && aligned[0].start_ms == 0 && aligned[0].end_ms == 1000,
        "fields carried");

  // Summed overlap across split segments of the same cluster must win:
  // cluster 2 covers [0,300)+[700,1000) = 600ms vs cluster 3's [300,700) = 400ms.
  std::vector<DiarSegment> split = {{0, 300, 2}, {300, 700, 3}, {700, 1000, 2}};
  auto a2 = audionotes::alignSpeakers({{0, 1000, "X"}}, split);
  CHECK(a2[0].speaker == 2, "summed overlap -> %d, want 2", a2[0].speaker);

  // speakerNames: clusters {2, 0} in use -> "Speaker 1" for 0, "Speaker 2" for 2 (ascending).
  auto names = audionotes::speakerNames(
      {{0, 1, 2, "x"}, {1, 2, 0, "y"}, {2, 3, -1, "z"}});
  CHECK(names.size() == 2, "names size %zu", names.size());
  CHECK(names[0].id == "S0" && names[0].display_name == "Speaker 1", "names[0] %s=%s",
        names[0].id.c_str(), names[0].display_name.c_str());
  CHECK(names[1].id == "S2" && names[1].display_name == "Speaker 2", "names[1] %s=%s",
        names[1].id.c_str(), names[1].display_name.c_str());

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_pipeline_align OK\n");
  return 0;
}
```

CMake addition (pipeline.cpp needs the engines, so this test links them):

```cmake
audionotes_add_test(test_pipeline_align
  ${CORE}/tests/test_pipeline_align.cpp
  ${CORE}/pipeline/pipeline.cpp
  ${CORE}/minutes/minutes_extractor.cpp
  ${CORE}/minutes/llm_minutes.cpp
  ${CORE}/asr/whisper_asr.cpp
  ${CORE}/util/ort_init.cpp
  ${CORE}/vad/silero_vad.cpp
  ${CORE}/diar/diarizer.cpp
  ${CORE}/llm/llama_engine.cpp)
target_include_directories(test_pipeline_align PRIVATE
  ${TP}/onnxruntime/include ${TP}/whisper.cpp/include ${TP}/whisper.cpp/ggml/include
  ${TP}/llama.cpp/include)
target_compile_definitions(test_pipeline_align PRIVATE HAVE_WHISPER HAVE_LLAMA=1)
target_link_libraries(test_pipeline_align PRIVATE whisper llama ${CMAKE_DL_LIBS})
if(ORT_LIB)
  target_compile_definitions(test_pipeline_align PRIVATE HAVE_SHERPA=1)
  target_include_directories(test_pipeline_align PRIVATE ${TP}/sherpa-onnx)
  target_link_libraries(test_pipeline_align PRIVATE sherpa-onnx-c-api)
  set_target_properties(test_pipeline_align PROPERTIES BUILD_RPATH "${ORT_ROOT}/lib")
endif()
```

- [ ] **Step 3: Verify it fails to build** (pipeline.cpp missing). Run the cmake+build command; expect FAIL.

- [ ] **Step 4: Write the implementation**

```cpp
// cpp/pipeline/pipeline.cpp
#include "pipeline/pipeline.h"

#include <chrono>
#include <map>

#include "diar/diarizer.h"
#include "llm/llama_engine.h"
#include "minutes/llm_minutes.h"

namespace audionotes {
namespace {

int64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

int64_t pcmDurationMs(const std::string& pcm_path, int sample_rate) {
  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return 0;
  std::fseek(f, 0, SEEK_END);
  long bytes = std::ftell(f);
  std::fclose(f);
  if (bytes <= 0) return 0;
  return static_cast<int64_t>(bytes) / 2 * 1000 / sample_rate;
}

}  // namespace

std::vector<AlignedUtterance> alignSpeakers(const std::vector<Utterance>& utts,
                                            const std::vector<DiarSegment>& diar) {
  std::vector<AlignedUtterance> out;
  out.reserve(utts.size());
  for (const auto& u : utts) {
    std::map<int, int64_t> overlap;  // cluster -> summed ms (AudioDb.kt:275-279)
    for (const auto& d : diar) {
      const int64_t ov = std::min(u.end_ms, d.end_ms) - std::max(u.start_ms, d.start_ms);
      if (ov > 0) overlap[d.speaker] += ov;
    }
    int best = -1;
    int64_t best_ov = 0;
    for (const auto& [spk, ov] : overlap) {
      if (ov > best_ov) { best = spk; best_ov = ov; }
    }
    out.push_back({u.start_ms, u.end_ms, best, u.text});
  }
  return out;
}

std::vector<MinuteSpk> speakerNames(const std::vector<AlignedUtterance>& transcript) {
  std::map<int, bool> used;  // ordered -> ascending cluster index
  for (const auto& u : transcript)
    if (u.speaker >= 0) used[u.speaker] = true;
  std::vector<MinuteSpk> out;
  int n = 1;
  for (const auto& [cluster, _] : used) {
    out.push_back({"S" + std::to_string(cluster), "Speaker " + std::to_string(n)});
    ++n;
  }
  return out;
}

bool Pipeline::run(const std::string& pcm_path, PipelineResult* out,
                   const PipelineProgressFn& progress) {
  auto report = [&progress](const char* stage, int done, int total) {
    if (progress) progress(stage, done, total);
  };
  out->audio_ms = pcmDurationMs(pcm_path, cfg_.sample_rate);

  // ---- VAD (or fixed 30 s windows when no model is configured) ----
  {
    const int64_t t0 = nowMs();
    report("vad", 0, 1);
    if (!cfg_.vad_model.empty()) {
      try {
        SileroVad vad(cfg_.vad_model, cfg_.sample_rate);
        out->segments = vad.process(pcm_path);
      } catch (const std::exception& e) {
        error_ = std::string("vad: ") + e.what();
        return false;
      }
    } else {
      for (int64_t s = 0; s < out->audio_ms; s += 30000)
        out->segments.push_back({s, std::min<int64_t>(s + 30000, out->audio_ms)});
    }
    out->vad_ms = nowMs() - t0;
    report("vad", 1, 1);
  }

  // ---- ASR ----
  std::vector<Utterance> utts;
  if (!out->segments.empty()) {
    const int64_t t0 = nowMs();
    WhisperAsr asr(cfg_.asr_model);
    if (!asr.ok()) {
      error_ = "asr: failed to load model " + cfg_.asr_model;
      return false;
    }
    utts = asr.transcribe(pcm_path, out->segments, cfg_.sample_rate, cfg_.asr_threads,
                          [&report](int done, int total) { report("asr", done, total); });
    out->asr_ms = nowMs() - t0;
  }

  // ---- Diarize (optional, best-effort — parity with ProcessingEngine's "skipped" path) ----
  std::vector<DiarSegment> diar;
  if (!utts.empty() && !cfg_.diar_seg_model.empty() && !cfg_.diar_emb_model.empty()) {
    const int64_t t0 = nowMs();
    report("diarize", 0, 1);
    try {
      Diarizer d(cfg_.diar_seg_model, cfg_.diar_emb_model, cfg_.sample_rate, cfg_.num_speakers);
      if (d.ok()) diar = d.process(pcm_path);
    } catch (const std::exception&) {
      // Best-effort: a diarization failure never sinks a good transcript.
    }
    out->diar_ms = nowMs() - t0;
    report("diarize", 1, 1);
  }

  out->transcript = alignSpeakers(utts, diar);

  // ---- Minutes: rule floor, then optional LLM enhancement that REPLACES on success ----
  // (parity: ProcessingEngine minutes stage + PipelineController.enhanceMinutes:249-252)
  if (!out->transcript.empty()) {
    const int64_t t0 = nowMs();
    report("minutes", 0, 1);
    const auto speakers = speakerNames(out->transcript);
    std::vector<MinuteUtt> mutts;
    mutts.reserve(out->transcript.size());
    for (const auto& u : out->transcript)
      mutts.push_back({u.text, u.speaker >= 0 ? "S" + std::to_string(u.speaker) : ""});

    out->minutes = extractMinutes(mutts, speakers);
    out->minutes_source = "rule";

    if (!cfg_.llm_model.empty()) {
      LlamaEngine llm;
      if (llm.load(cfg_.llm_model, cfg_.llm_n_ctx, cfg_.llm_threads)) {
        auto enhanced = enhanceMinutes(mutts, speakers, [&llm](const std::string& p, int t) {
          return llm.generate(p, t);
        });
        if (enhanced) {
          out->minutes = *enhanced;
          out->minutes_source = "llm";
        }
      }
    }
    out->minutes_ms = nowMs() - t0;
    report("minutes", 1, 1);
  }

  return true;
}

}  // namespace audionotes
```

- [ ] **Step 5: Delete the sketch header, update the README reference**

```bash
git rm cpp/audionotes_core.h
grep -n "audionotes_core" cpp/README.md   # rewrite that line to reference pipeline/pipeline.h + capi/audionotes_capi.h
```

- [ ] **Step 6: Build + run the test to pass**

```bash
cmake -B build -G Ninja && cmake --build build --target test_pipeline_align && ctest --test-dir build -R test_pipeline_align --output-on-failure
```
Expected: `test_pipeline_align OK`.

- [ ] **Step 7: Commit**

```bash
git add -A cpp/pipeline cpp/tests/test_pipeline_align.cpp cpp/README.md cpp/cli/CMakeLists.txt
git commit -m "feat(core): Pipeline orchestrator — VAD->ASR->diarize->align->minutes in C++, align parity with AudioDb.assignSpeakers"
```

---

### Task 6: `extern "C"` facade

The stable ABI boundary every non-C++ shell binds to (roadmap §6: it occupies the seam the JNI shim sits on today; iOS/Swift and Windows call this directly, and the eval harness can too).

**Files:**
- Create: `cpp/capi/audionotes_capi.h`
- Create: `cpp/capi/audionotes_capi.cpp`
- Create: `cpp/tests/test_capi.c` (compiled as **C**, proving the header is C-clean)
- Modify: `cpp/cli/CMakeLists.txt`

- [ ] **Step 1: Write the header**

```c
/* cpp/capi/audionotes_capi.h
 * C ABI over the Verbale pipeline (pipeline/pipeline.h). This header must stay C-compilable:
 * no C++ types, no exceptions across the boundary. Strings are UTF-8; the result is a JSON
 * document (see an_result_json) so bindings never chase struct layouts across versions.
 */
#ifndef AUDIONOTES_CAPI_H
#define AUDIONOTES_CAPI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct an_result an_result; /* opaque */

typedef struct an_options {
  const char* pcm_path;       /* headerless PCM16 mono, required */
  const char* asr_model;      /* required */
  const char* vad_model;      /* NULL = fixed 30 s windows */
  const char* diar_seg_model; /* NULL (either) = skip diarization */
  const char* diar_emb_model;
  const char* llm_model;      /* NULL = rule-based minutes only */
  int num_speakers;           /* 0 = auto */
  int sample_rate;            /* 0 = 16000 */
  int asr_threads;            /* 0 = engine default */
  int llm_threads;            /* 0 = 4 */
} an_options;

/* stage: "vad"|"asr"|"diarize"|"minutes". Called from the processing thread. */
typedef void (*an_progress_fn)(const char* stage, int done, int total, void* user);

/* Run the full pipeline. Returns NULL only on allocation failure; check an_result_error for
 * run failures. Free with an_result_free. */
an_result* an_process(const an_options* opts, an_progress_fn progress, void* user);

/* NULL when the run succeeded, else a message owned by the result. */
const char* an_result_error(const an_result* r);

/* The full result as JSON, owned by the result (valid until an_result_free):
 * {"audio_ms":N,"timings":{"vad_ms":N,"asr_ms":N,"diar_ms":N,"minutes_ms":N},
 *  "segments":[{"start_ms":N,"end_ms":N}],
 *  "transcript":[{"start_ms":N,"end_ms":N,"speaker":N,"text":"..."}],
 *  "minutes_source":"llm"|"rule"|"",
 *  "minutes":[{"kind":"...","content":"...","source":"..."}]} */
const char* an_result_json(const an_result* r);

void an_result_free(an_result* r);

#ifdef __cplusplus
}
#endif
#endif /* AUDIONOTES_CAPI_H */
```

- [ ] **Step 2: Write the failing C test**

```c
/* cpp/tests/test_capi.c — compiled as C. The assertion under test is the header itself:
 * if this file compiles and links, the ABI boundary is C-clean. The runtime check just
 * exercises the error path (bogus model) without needing model files. */
#include "capi/audionotes_capi.h"

#include <stdio.h>
#include <string.h>

int main(void) {
  an_options opts;
  memset(&opts, 0, sizeof opts);
  opts.pcm_path = "/nonexistent.pcm";
  opts.asr_model = "/nonexistent.bin";
  an_result* r = an_process(&opts, NULL, NULL);
  if (!r) { fprintf(stderr, "an_process returned NULL\n"); return 1; }
  if (!an_result_error(r)) { fprintf(stderr, "expected an error for bogus models\n"); return 1; }
  if (!an_result_json(r)) { fprintf(stderr, "json must be non-NULL even on error\n"); return 1; }
  an_result_free(r);
  printf("test_capi OK\n");
  return 0;
}
```

CMake (note: `project(audionotes_cli CXX C)` already enables C):

```cmake
audionotes_add_test(test_capi
  ${CORE}/tests/test_capi.c
  ${CORE}/capi/audionotes_capi.cpp
  ${CORE}/pipeline/pipeline.cpp
  ${CORE}/minutes/minutes_extractor.cpp
  ${CORE}/minutes/llm_minutes.cpp
  ${CORE}/asr/whisper_asr.cpp
  ${CORE}/util/ort_init.cpp
  ${CORE}/vad/silero_vad.cpp
  ${CORE}/diar/diarizer.cpp
  ${CORE}/llm/llama_engine.cpp)
target_include_directories(test_capi PRIVATE
  ${TP}/onnxruntime/include ${TP}/whisper.cpp/include ${TP}/whisper.cpp/ggml/include
  ${TP}/llama.cpp/include)
target_compile_definitions(test_capi PRIVATE HAVE_WHISPER HAVE_LLAMA=1)
target_link_libraries(test_capi PRIVATE whisper llama ${CMAKE_DL_LIBS})
if(ORT_LIB)
  target_compile_definitions(test_capi PRIVATE HAVE_SHERPA=1)
  target_include_directories(test_capi PRIVATE ${TP}/sherpa-onnx)
  target_link_libraries(test_capi PRIVATE sherpa-onnx-c-api)
  set_target_properties(test_capi PROPERTIES BUILD_RPATH "${ORT_ROOT}/lib")
endif()
```

- [ ] **Step 3: Verify it fails to build** (capi cpp missing). Expected: FAIL.

- [ ] **Step 4: Write the implementation**

```cpp
// cpp/capi/audionotes_capi.cpp
#include "capi/audionotes_capi.h"

#include <string>

#include "nlohmann/json.hpp"
#include "pipeline/pipeline.h"

using nlohmann::json;

struct an_result {
  std::string error;  // "" = success
  std::string json_doc;
};

extern "C" {

an_result* an_process(const an_options* opts, an_progress_fn progress, void* user) {
  an_result* r = new (std::nothrow) an_result;
  if (!r) return nullptr;
  try {
    audionotes::PipelineConfig cfg;
    cfg.asr_model = opts->asr_model ? opts->asr_model : "";
    cfg.vad_model = opts->vad_model ? opts->vad_model : "";
    cfg.diar_seg_model = opts->diar_seg_model ? opts->diar_seg_model : "";
    cfg.diar_emb_model = opts->diar_emb_model ? opts->diar_emb_model : "";
    cfg.llm_model = opts->llm_model ? opts->llm_model : "";
    cfg.num_speakers = opts->num_speakers;
    if (opts->sample_rate > 0) cfg.sample_rate = opts->sample_rate;
    cfg.asr_threads = opts->asr_threads;
    if (opts->llm_threads > 0) cfg.llm_threads = opts->llm_threads;

    audionotes::Pipeline pipeline(cfg);
    audionotes::PipelineResult res;
    audionotes::PipelineProgressFn cb;
    if (progress) {
      cb = [progress, user](const std::string& stage, int done, int total) {
        progress(stage.c_str(), done, total, user);
      };
    }
    const bool ok = pipeline.run(opts->pcm_path ? opts->pcm_path : "", &res, cb);
    if (!ok) r->error = pipeline.error().empty() ? "pipeline failed" : pipeline.error();

    json doc;
    doc["audio_ms"] = res.audio_ms;
    doc["timings"] = {{"vad_ms", res.vad_ms}, {"asr_ms", res.asr_ms},
                      {"diar_ms", res.diar_ms}, {"minutes_ms", res.minutes_ms}};
    doc["segments"] = json::array();
    for (const auto& s : res.segments)
      doc["segments"].push_back({{"start_ms", s.start_ms}, {"end_ms", s.end_ms}});
    doc["transcript"] = json::array();
    for (const auto& u : res.transcript)
      doc["transcript"].push_back({{"start_ms", u.start_ms}, {"end_ms", u.end_ms},
                                   {"speaker", u.speaker}, {"text", u.text}});
    doc["minutes_source"] = res.minutes_source;
    doc["minutes"] = json::array();
    for (const auto& m : res.minutes)
      doc["minutes"].push_back({{"kind", m.kind}, {"content", m.content}, {"source", m.source}});
    if (!r->error.empty()) doc["error"] = r->error;
    r->json_doc = doc.dump(1);
  } catch (const std::exception& e) {
    r->error = e.what();
    r->json_doc = json({{"error", r->error}}).dump(1);
  }
  return r;
}

const char* an_result_error(const an_result* r) {
  return r->error.empty() ? nullptr : r->error.c_str();
}
const char* an_result_json(const an_result* r) { return r->json_doc.c_str(); }
void an_result_free(an_result* r) { delete r; }

}  // extern "C"
```

- [ ] **Step 5: Build + run to pass**

```bash
cmake -B build -G Ninja && cmake --build build --target test_capi && ctest --test-dir build -R test_capi --output-on-failure
```
Expected: `test_capi OK`.

- [ ] **Step 6: Commit**

```bash
git add cpp/capi cpp/tests/test_capi.c cpp/cli/CMakeLists.txt
git commit -m "feat(core): extern \"C\" facade (an_process) — the stable ABI every shell binds to"
```

---

### Task 7: CLI onto the Pipeline (+ `--json` eval output)

**Files:**
- Modify: `cpp/cli/main.cpp` (replace hand-rolled stage sequencing with `Pipeline`; the `wavToPcm` helper stays)
- Modify: `cpp/cli/CMakeLists.txt` (add new sources to `audionotes_cli`)

- [ ] **Step 1: Add pipeline sources to the CLI target**

In the `add_executable(audionotes_cli ...)` block, add:

```cmake
  ${CORE}/pipeline/pipeline.cpp
  ${CORE}/minutes/minutes_extractor.cpp
  ${CORE}/minutes/llm_minutes.cpp
  ${CORE}/capi/audionotes_capi.cpp
```

- [ ] **Step 2: Rewrite `main.cpp`'s pipeline section**

Keep the header comment (update milestone to "full pipeline"), `rd32/rd16/wavToPcm`, the arg parsing, and the `AUDIONOTES_ORT_LIB_DEFAULT` setenv. Replace everything from the `WhisperAsr asr(model);` line down with:

```cpp
  // New flag alongside the existing ones:
  //   else if (std::strcmp(argv[i], "--json") == 0 && i + 1 < argc) json_out = argv[++i];
  // (declare `std::string json_out;` next to the other flag strings)

  audionotes::PipelineConfig cfg;
  cfg.asr_model = model;
  cfg.vad_model = vad_model;
  cfg.diar_seg_model = diar_seg;
  cfg.diar_emb_model = diar_emb;
  cfg.llm_model = llm_model;
  cfg.num_speakers = num_speakers;

  audionotes::Pipeline pipeline(cfg);
  audionotes::PipelineResult res;
  bool ok = pipeline.run(pcm, &res, [](const std::string& stage, int done, int total) {
    std::fprintf(stderr, "[%s] %d/%d\n", stage.c_str(), done, total);
  });
  if (!ok) {
    std::fprintf(stderr, "pipeline error: %s\n", pipeline.error().c_str());
    return 1;
  }

  std::fprintf(stderr, "vad: %zu segment(s), asr: %zu utterance(s)\n", res.segments.size(),
               res.transcript.size());
  for (const auto& u : res.transcript) {
    if (u.speaker >= 0) {
      std::printf("[%6lld-%6lld ms] S%d: %s\n", static_cast<long long>(u.start_ms),
                  static_cast<long long>(u.end_ms), u.speaker, u.text.c_str());
    } else {
      std::printf("[%6lld-%6lld ms] %s\n", static_cast<long long>(u.start_ms),
                  static_cast<long long>(u.end_ms), u.text.c_str());
    }
  }
  if (!res.minutes.empty()) {
    std::printf("\n== minutes (%s) ==\n", res.minutes_source.c_str());
    for (const auto& m : res.minutes)
      std::printf("%s: %s\n", m.kind.c_str(), m.content.c_str());
  }

  if (!json_out.empty()) {
    // Reuse the C API's serializer so the CLI JSON and the ABI JSON can never drift apart.
    an_options copts = {};
    // ... NOT another pipeline run: serialize `res` directly instead. Build the same JSON doc
    // here with nlohmann (copy the doc-building block from audionotes_capi.cpp into a shared
    // helper `cpp/pipeline/result_json.h` — audionotes::resultToJson(res) -> std::string — and
    // call it from BOTH audionotes_capi.cpp and here).
    std::ofstream jf(json_out);
    jf << audionotes::resultToJson(res);
    std::fprintf(stderr, "wrote %s\n", json_out.c_str());
  }
  return 0;
```

**Refactor note (do it in this task, it's 15 lines):** extract the JSON-document construction from `audionotes_capi.cpp` into `cpp/pipeline/result_json.h`:

```cpp
// cpp/pipeline/result_json.h
// Single serializer for PipelineResult so the C ABI and the CLI emit byte-identical JSON.
#pragma once
#include <string>
#include "pipeline/pipeline.h"

namespace audionotes {
std::string resultToJson(const PipelineResult& res, const std::string& error = "");
}
```

with the implementation moved to a new `cpp/pipeline/result_json.cpp` (add to both the capi test target and the CLI target in CMake; `audionotes_capi.cpp` calls it too).

- [ ] **Step 3: Build everything + run the whole test suite**

```bash
cmake -B build -G Ninja && cmake --build build && ctest --test-dir build --output-on-failure
```
Expected: all 4 tests pass, CLI links.

- [ ] **Step 4: End-to-end verification, rule floor** (no `--llm`) — models/wavs live in the session scratchpad; re-download via `ModelCatalog.kt` URLs if gone:

```bash
S=<scratchpad>   # see memory/portable-core.md
./build/audionotes_cli $S/ggml-base-q5_1.bin $S/two_speakers.wav \
  --vad $S/silero_vad.onnx --diar-seg $S/diar_segmentation.onnx --diar-emb $S/diar_embedding.onnx \
  --json /tmp/out.json
```
Expected: same 8 utterances with S0/S1 labels as the previous milestone; a `== minutes (rule) ==` block whose summary line counts actions/decisions/questions; action items carry `— Speaker N` owners and `(due by Thursday)`; `/tmp/out.json` contains `transcript`, `minutes`, `timings`.

- [ ] **Step 5: End-to-end verification, LLM tier** (add `--llm $S/qwen-instruct-q4_k_m.gguf`)

Expected: `== minutes (llm) ==` with a prose summary; if the model echoes the template, the block correctly says `(rule)` instead — that fallback is a pass, not a failure.

- [ ] **Step 6: Commit**

```bash
git add cpp/cli/main.cpp cpp/cli/CMakeLists.txt cpp/pipeline/result_json.h cpp/pipeline/result_json.cpp cpp/capi/audionotes_capi.cpp
git commit -m "feat(core): CLI drives the Pipeline orchestrator; --json emits the eval-harness document"
```

---

### Task 8: Wrap up

- [ ] **Step 1: Full suite + both e2e runs one more time** (`ctest` + Task 7 steps 4-5). All green.
- [ ] **Step 2: Update `cpp/README.md`** if Task 5's edit left anything stale (it should now describe: engines → minutes → pipeline → capi, and the CLI as the desktop host).
- [ ] **Step 3: Update memory** (`memory/portable-core.md`): orchestrator done; next = Phase 1b scoring harness (consumes `--json`), then Android JNI swap onto `an_process`.
- [ ] **Step 4: Use superpowers:finishing-a-development-branch** to decide merge/PR for `feat/portable-core` — Phase 1a is complete at this point.

---

## Self-review notes (already applied)

- **Spec coverage** (roadmap §6 Phase 1a/1b): orchestrator ✓ (Task 5), align ✓ (Task 5), minutes port ✓ (Task 3), LLM map-reduce port ✓ (Task 4), extern "C" ✓ (Task 6), CLI emits full MOM ✓ (Task 7), machine-readable output for the eval harness ✓ (`--json`). Benchmark *scoring* is Phase 1b — deliberately out.
- **Known risks called out inline:** std::regex lookbehind (Task 3 splitter), multi-byte `’` (Task 3 normalization), em dash exactness (Task 3 note), template-echo placeholder filter judged per-field (Task 4), no double pipeline run for `--json` (Task 7 refactor note).
- **Type consistency:** `DraftMinute`/`MinuteUtt`/`MinuteSpk` defined once in Task 3's header and reused in Tasks 4-7; `AlignedUtterance`/`PipelineResult` defined in Task 5 and reused in 6-7; `resultToJson` introduced in Task 7 and used by both emitters.
