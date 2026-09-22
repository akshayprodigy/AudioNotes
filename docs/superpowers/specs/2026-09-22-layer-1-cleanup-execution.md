# Layer 1 cleanup — execution sheet (the nine open items from the A07 session)

*22 September 2026, against `55d8575`. For the session that builds it. Every file, line range,
pattern, string and test below is decided and was grepped today. Do not design anything: where
this sheet names a regex, a word, a number or a copy string, it is the measured or reviewed
answer, not a suggestion. Source of the list: `docs/superpowers/reports/2026-09-22-a07-layer-1-session.md`
§4, found by driving the phone.*

**Three sessions.** Session A = Steps 1–4 (the rules layer: TypeScript, C++, one Kotlin service).
Session B = Steps 5–9 (the screens). Session D = the device checks, run only with the A07
attached. Each run starts from the progress file.

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. Never print a file over 200
  lines; `grep -n` to locate, then `sed -n 'A,Bp'` for at most 60 lines. `MeetingScreen.tsx` is
  1,500 lines, `ui.tsx` 1,063, `SummaryTab.tsx` 613, `PaywallScreen.tsx` 580: only the ranges
  named. Every command below ends in its filter — run it exactly as written. Do not re-read a file
  after editing it. Do not paste code into your messages; commit it and name the file.
- **TDD + mutant.** Test first, watch it fail, write the code, watch it pass, apply the **named
  mutant**, watch the test fail, restore, green again. Record every mutant in the progress file's
  *Mutants* section as it happens, not from memory at the end.
- **Commit after each step**, subject in the house style (`git log --oneline -6`). **Never push** —
  the founder pushes. **Never run `connectedDebugAndroidTest`** (it uninstalls the app and wipes
  the phone's data). **`git status` must be clean before you stop.**
- **Indent like the surrounding file**: two spaces in TypeScript, Kotlin and C++ alike; JSX
  attributes one per line when the tag wraps, as the neighbours do. C++ is clang-format'd at 100
  columns — match the file you are in.
- **Progress file.** First action of Session A: create
  `docs/superpowers/reports/layer-1-cleanup-progress.md` with the nine steps as checkboxes and the
  headings *Decisions*, *Mutants*, *Notes for the next session*. Update and commit it with every
  step. Session B and Session D read it first.
- **Hand-over at 150 steps**, whatever remains: finish the step you are on, commit, update the
  progress file, stop.
- **Sessions A and B need no device.** Do not run `adb` in them. Session D is device-only.

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `src/pipeline/minutes.ts` | 1–35, 60–80, 140–185 | Steps 1, 2: the cue patterns, `isQuestion`, the extract loop |
| `src/pipeline/evidence.ts` | 1–20, 220–240 | Step 1: the second call site of the decision check |
| `src/pipeline/__tests__/minutes.golden.test.ts` | 1–60, 200–235, 375–400 | Steps 1, 2: the fixtures and the assertions; this file WRITES the goldens |
| `cpp/minutes/minutes_extractor.cpp` | 14–46, 155–175 | Steps 1, 2: the C++ mirror of both |
| `cpp/minutes/templates.cpp` | 40–70, 144–190 | Step 3: `headerIndex`, `fragment`, `foldSections` |
| `cpp/minutes/templates.h` | 22–34 | Step 3: the contract comment to extend |
| `cpp/tests/test_templates.cpp` | 1–30, 82–126, 160–182 | Step 3: the CHECK harness, the fold tests, the runner list |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingService.kt` | 1–26, 27–55, 79–140, 167–200, 270–310 | Step 4 |
| `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ResumePlan.kt` | 1–45 | Step 4: the pure-object idiom to copy |
| `android/app/src/test/java/com/innocorelabs/verbale/pipeline/ResumePlanTest.kt` | all | Step 4: the JVM test idiom to copy |
| `src/screens/meeting/SummaryTab.tsx` | 160–240, 330–400, 420–440, 585–600 | Steps 5, 8 |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | 1–100 | Steps 5, 8: the harness and mocks |
| `src/components/ui.tsx` | 1–20, 364–460, 461–580, 1000–1035 | Steps 6, 7 |
| `src/components/__tests__/TextPrompt.test.tsx` | all (≈70) | Step 6: the harness to extend |
| `src/screens/PaywallScreen.tsx` | 1–40, 170–270, 305–330, 505–525 | Step 9 |
| `src/screens/__tests__/ActionsScreen.test.tsx` | 1–45 | Step 9: the screen-test mock idiom to copy |
| `src/screens/MeetingScreen.tsx` | 855–915 | Step 7 only: the nine-row `sheetActions` that overflows. Read, do not edit |

**Interfaces you use without reading their files** (they exist; do not open them):
`entitlement(): Promise<{ paid: boolean; viaTrial: boolean; trial: { status: 'unstarted'|'active'|'ended'; daysLeft: number; summariesLeft: number } }>`
and `TRIAL_DAYS = 7`, `TRIAL_SUMMARIES = 3` from `src/billing/trial`;
`startTrial(): Promise<void>` from the same file;
`Txt`, `SoftButton`, `Sheet`, `TextPrompt`, `Raised`, `Pop`, `Slide`, `IconButton` from `src/components/ui`;
`ToolButton` from `src/screens/meeting/shared`;
`radius, s, sv, motion, useTheme, type Colors` from `src/theme`;
`stripLabels(text)` and `narrativePrompt(...)` from `cpp/minutes/llm_minutes.h`;
`sectionsFor(id)` from `cpp/minutes/templates.h`;
`AudioDb.get(ctx).pipelineState(id)` and `ProcessingEngine.cancelled` in Kotlin.

---

## 2. Files that must not change

- `cpp/minutes/evidence.cpp`, `cpp/minutes/llm_minutes.cpp`, `cpp/minutes/llm_prompts.cpp`,
  `cpp/minutes/ask.cpp`, `cpp/jni/audionotes_jni.cpp` — the shared core beyond the two functions
  named in Steps 1–3.
- Any `.json` under `cpp/tests/golden/` **by hand**. They are generated: `npx jest minutes.golden`
  rewrites them. Editing one by hand is how the port silently stops being a port.
- `src/db/queries.ts`, `src/db/schema*`, `android/.../data/**` — no schema change is needed here.
- `android/.../pipeline/ProcessingEngine.kt`, `Narrator.kt`, `RecordingService.kt`.
- `src/billing/trial.ts` — Step 5 reads its entitlement, it does not change it.
- `scripts/gate.sh`, `scripts/device-verify.sh`, `jest.config.js`, `jest.setup.js`.
- Every `docs/**` file except the progress file and the report you write at the end.

---

## 3. Implementation sequence

### Session A — the rules layer

#### Step 1. A schedule change is a decision

**Why.** On the A07, "Shipping moved to Thursday because QA is not done" produced no item at all,
so Phase 3's `changes:` link never fires on the commonest kind of changed decision. The cue list
has no verb for a date moving.

**The decision, already taken (do not re-open):** two halves must BOTH match the same sentence — a
change verb in a form that *reports a change already made* (past or passive), and an explicit new
time. The bare infinitives (`move`, `push`, `postpone`) are deliberately absent: "we need to move
the review to Friday" is an action somebody still owes, and it must stay an action.

**1a. `src/pipeline/minutes.ts`.** After the `DECISION` const (anchor: the line beginning
`export const DECISION = /\b(we decided|`), insert:

```ts
// A schedule change reported as already made is a decision. "Shipping moved to Thursday because
// QA is not done" produced no item at all on the A07 (22 Sep), so a thread's "changes:" link
// never fired on the commonest kind of changed decision.
//
// Two halves, both required on the same sentence: a verb in a form that REPORTS the change, and
// an explicit new time. Bare infinitives are absent on purpose — "we need to move the review to
// Friday" is an action somebody still owes and must stay one. The time half is why "I moved to
// Bangalore last year" and "he pushed back on the price" are not decisions.
// Mirrored in cpp/minutes/minutes_extractor.cpp; the goldens keep the two in step.
export const SCHEDULE_VERB = /\b(moved|pushed|postponed|delayed|rescheduled|shifted|slipped|bumped|brought forward|pulled forward|put back)\b/i;
export const SCHEDULE_WHEN = /\b(to|till|until|into|for)\s+(the\s+)?(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (week|month|morning|afternoon|evening)|the (end of (the )?(day|week|month)|weekend)|q[1-4]|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b/i;

/** The decision test both extractors use. A wrapper so there is one place the rule can drift. */
export function isDecision(sentence: string): boolean {
  return DECISION.test(sentence) || (SCHEDULE_VERB.test(sentence) && SCHEDULE_WHEN.test(sentence));
}
```

Then replace the call site in `extractMinutes` (anchor: `      if (DECISION.test(sentence)) {`)
with `      if (isDecision(sentence)) {`.

**1b. `src/pipeline/evidence.ts`.** Anchor: `      if (DECISION.test(sentence)) {` → `      if (isDecision(sentence)) {`.
Change the import at the top of the file (anchor: the `  DECISION,` line inside the
`from '../minutes'`-style import block) to import `isDecision` instead of `DECISION`. If `DECISION`
is then unused in that file, remove it from the import list — `npx tsc --noEmit` must stay silent.

**1c. `cpp/minutes/minutes_extractor.cpp`.** After the `DECISION` regex (anchor: the line
`    R"rx(\b(we decided|we have decided|`), insert:

```cpp
// JS: SCHEDULE_VERB / SCHEDULE_WHEN in src/pipeline/minutes.ts. Both must match the same sentence
// for it to be a decision; see the JS comment for why the bare infinitives are absent.
const std::regex SCHEDULE_VERB(
    R"rx(\b(moved|pushed|postponed|delayed|rescheduled|shifted|slipped|bumped|brought forward|pulled forward|put back)\b)rx",
    std::regex::icase);
const std::regex SCHEDULE_WHEN(
    R"rx(\b(to|till|until|into|for)\s+(the\s+)?(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (week|month|morning|afternoon|evening)|the (end of (the )?(day|week|month)|weekend)|q[1-4]|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b)rx",
    std::regex::icase);
```

and replace the one-line `isDecision` (anchor: `bool isDecision(const std::string& sentence) { return std::regex_search(sentence, DECISION); }`)
with:

```cpp
bool isDecision(const std::string& sentence) {
  if (std::regex_search(sentence, DECISION)) return true;
  return std::regex_search(sentence, SCHEDULE_VERB) && std::regex_search(sentence, SCHEDULE_WHEN);
}
```

Both C++ call sites already go through `rules::isDecision` — do not touch them.

**1d. The golden fixtures.** In `src/pipeline/__tests__/minutes.golden.test.ts`, append to the
`RULES` array (anchor: `const RULES = [`), with these comments:

```ts
  // A schedule change reported as made. Neither half alone is enough, which the two rows after
  // this one pin from both sides.
  { text: 'Shipping moved to Thursday because QA is not done.', speakerId: 'S0' },
  { text: 'The demo was pushed to next week.', speakerId: 'S1' },
  // Must NOT be decisions: a verb with no new time, and a new time with no change verb.
  { text: 'I moved to Bangalore last year.', speakerId: 'S0' },
  { text: 'He pushed back on the price.', speakerId: 'S1' },
  // Still an action, not a decision: nobody has moved anything yet.
  { text: 'We need to move the review to Friday.', speakerId: 'S0' },
```

and in the test body that asserts over the RULES output, add:

```ts
  const kindOf = (t: string) => rules.find(m => m.content.startsWith(t))?.kind;
  expect(kindOf('Shipping moved to Thursday')).toBe('decision');
  expect(kindOf('The demo was pushed to next week')).toBe('decision');
  expect(kindOf('I moved to Bangalore')).toBeUndefined();
  expect(kindOf('He pushed back on the price')).toBeUndefined();
  expect(kindOf('We need to move the review to Friday')).toBe('action');
```

(`rules` is whatever the existing test already calls the extracted array for that fixture — read
lines 200–235 and use the existing name; do not introduce a second extraction.)

**Run, in this order:**
1. `npx jest src/pipeline/__tests__/minutes.golden.test.ts --forceExit --silent 2>&1 | tail -6` →
   fails on the new assertions before 1a–1c, passes after, and REWRITES `cpp/tests/golden/*.json`.
2. `git diff --stat cpp/tests/golden` → only `minutes_rules.json` (and, if the evidence fixtures
   moved, `evidence_*.json`) changed. **Read the new rows in the diff** and check each new sentence
   landed in the kind the assertions above name.
3. Build and replay in C++:
   `cmake -S cpp/cli -B cpp/cli/build -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build cpp/cli/build -j 8 2>&1 | grep -E "error|warning: unused|FAILED" | tail -20`
   then `(cd cpp/cli/build && ctest -R "test_minutes|test_evidence" --output-on-failure 2>&1 | tail -8)`
   → `100% tests passed`. Use `$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake` and the `ctest`
   beside it if plain `cmake` is not on the path (that is what `scripts/gate.sh` does).

**Mutant (named):** in the C++ `isDecision`, change `&&` to `||` between SCHEDULE_VERB and
SCHEDULE_WHEN → `ctest -R test_minutes` must FAIL on "I moved to Bangalore last year." Restore.
Second mutant, in the TS: delete `SCHEDULE_VERB.test(sentence) &&` → the jest assertion on
"I moved to Bangalore" must fail. Restore.

**Commit:** `fix(extractor): a date that moved is a decision — "shipping moved to Thursday" now lands in the thread`

---

#### Step 2. A question needs three words

**Why.** The extractor emits "And what?", "Okay?", "What?" as open questions on real speech
(recorded 8 Sep, still true). They are how a transcript renders a pause.

**The decision, already taken:** the floor is **three ASCII-alnum words**, and it does not apply to
a sentence with no ASCII words at all. That exception is load-bearing: the golden's `🚀🚀?` row
exists to prove the caller's `sentence.length < 4` filter counts UTF-16 units, and it must keep
reaching the question branch. Counting ASCII runs (not `\p{L}`) is what keeps the TS and the
`std::regex`-over-bytes C++ giving the same answer.

**2a. `src/pipeline/minutes.ts`.** Replace `isQuestion` (anchor: `export function isQuestion(sentence: string): boolean {`):

```ts
// ASCII-alnum runs rather than \p{L}: the C++ port matches bytes with std::regex and has no
// Unicode classes, so a Unicode-aware count here would diverge from it on exactly the text no
// golden covers. English-only for v1.
const WORDS = /[A-Za-z0-9]+/g;

export function isQuestion(sentence: string): boolean {
  const t = sentence.trim();
  if (!(t.endsWith('?') || (QUESTION_WORDS.test(t) && t.length < 160))) return false;
  // "Okay?", "What?", "And what?" are how a transcript renders a pause, and they were listed as
  // open questions on real speech. Three words is the floor. A sentence with no ASCII words at
  // all is left to the caller's length filter — see the emoji row in the goldens.
  const words = t.match(WORDS)?.length ?? 0;
  return words === 0 || words >= 3;
}
```

**2b. `cpp/minutes/minutes_extractor.cpp`.** Replace `isQuestion` (anchor: `bool isQuestion(const std::string& sentence) {`):

```cpp
// JS: /[A-Za-z0-9]+/g counted over the trimmed sentence. ASCII on purpose — see the JS comment.
int asciiWordCount(const std::string& s) {
  int n = 0;
  bool in_word = false;
  for (unsigned char c : s) {
    const bool w = c < 128 && std::isalnum(c) != 0;
    if (w && !in_word) ++n;
    in_word = w;
  }
  return n;
}

bool isQuestion(const std::string& sentence) {
  const std::string t = trim(sentence);
  const bool asked = (!t.empty() && t.back() == '?') ||
                     (std::regex_search(t, QUESTION_WORDS) && t.size() < 160);
  if (!asked) return false;
  const int words = asciiWordCount(t);
  return words == 0 || words >= 3;
}
```

`asciiWordCount` goes in the same anonymous-namespace block as the other helpers, above
`isQuestion`. Do not export it in the header.

**2c. The goldens.** In `src/pipeline/__tests__/minutes.golden.test.ts`, the `SPANS` fixture has a
row `{ text: 'Ok?', speakerId: 'S0' }` whose comment says its absence proves the `< 4` length
filter fired "because isQuestion has no length floor of its own". That reasoning stops being true
in this step, so the row must change rather than quietly become a tautology. Replace it with:

```ts
  // The length filter (`sentence.length < 4`), still with nothing else able to exclude it: three
  // characters, no words, so isQuestion's own three-word floor does NOT apply (it exempts a
  // sentence with no ASCII words, which is what keeps the emoji row below reaching the question
  // branch). Its absence from the output is therefore proof of the length filter alone.
  { text: '?!?', speakerId: 'S0' },
```

and the assertion (anchor: `expect(spans.some(i => i.text === 'Ok?')).toBe(false);`) becomes
`expect(spans.some(i => i.text === '?!?')).toBe(false);`, with the comment above it updated to say
`"?!?"` instead of `"Ok?"`. Add, next to it:

```ts
  // The three-word floor: a fragment that ends in '?' and passes the length filter is still not
  // an open question. "And what?" is nine characters, so only the floor can exclude it.
  expect(spans.some(i => i.text === 'And what?')).toBe(false);
  // ...and a real short question survives it.
  expect(spans.some(i => i.text === 'Should we revisit pricing?')).toBe(true);
```

with the two matching fixture rows **appended at the END of `SPANS`** (anchor: the last row,
`  { text: '\uFEFFWe agreed to launch.', speakerId: 'S0' },`). Never insert into the middle of that
array: its comments are numbered "Row 1…Row 11" and the assertions index it as `SPANS[4]`, so a row
inserted higher up silently re-points both.

```ts
  // Row 12: the three-word floor on questions. Nine characters, so the length filter cannot be
  // what excludes it — only the floor can. This is the fragment the phone produced on real
  // speech ("And what?", "Okay?", "What?").
  { text: 'And what?', speakerId: 'S1' },
  // Row 13: the other side of the same floor — four words, so a real short question survives it.
  { text: 'Should we revisit pricing?', speakerId: 'S0' },
```

**Run:** same three commands as Step 1 (jest regenerates, read the golden diff, then
`ctest -R "test_minutes|test_evidence"`).

**Mutant:** in the C++ `asciiWordCount`, change `if (w && !in_word) ++n;` to `if (w) ++n;` (count
characters, not words) → `ctest -R test_minutes` must FAIL, because "And what?" then counts 8 and
survives. Restore.

**Commit:** `fix(extractor): "Okay?" is a pause, not an open question — a question needs three words`

---

#### Step 3. Inline section labels are still sections

**Why.** On the A07 a client-call narrative came back as one paragraph with all four section names
inside it ("… the vendor code format. What we committed to: ship by Friday. Risks and open
points: …"), where the stand-up's three came back separate. `foldSections` splits on line breaks
only, so it saw one line with no bare header and returned the text untouched.

**The decision, already taken:** this is a **new branch**, not a change to the existing one. The
existing fold path (bare header lines) stays byte-identical, and
`foldLeavesAnInlineOpenerAndItsParagraphAlone` must keep passing unchanged: a label at the START of
its own line is already the asked-for shape. The new branch fires only when there is **no bare
header line anywhere** and the text contains **two or more** section labels that begin
mid-line — that pair of guards is what stops a single "Next steps: …" sentence inside ordinary
prose being torn out of it.

**3a. `cpp/minutes/templates.cpp`.** In the anonymous namespace, above `foldSections`, add:

```cpp
// A section label that begins inside a line rather than at the start of one: "<Name>:" preceded
// by a space, and before that the end of a sentence. The 1.5B writer does this with the longer
// section lists — a client call came back on the A07 as one paragraph holding all four (22 Sep),
// where the stand-up's three arrived on lines of their own.
//
// Returns the byte offsets at which `line` should be cut, in order, never including 0.
std::vector<std::size_t> inlineLabelCuts(const std::string& line,
                                         const std::vector<std::string>& sections) {
  std::vector<std::size_t> cuts;
  const std::string low = lowered(line);
  for (const auto& name : sections) {
    const std::string needle = lowered(name) + ":";
    for (std::size_t at = low.find(needle); at != std::string::npos;
         at = low.find(needle, at + 1)) {
      if (at == 0) continue;                       // already opens its line: the existing shape
      if (line[at - 1] != ' ') continue;           // "…and what we committed to:" is not a label
      std::size_t before = at - 1;
      while (before > 0 && line[before] == ' ') --before;
      const char end = line[before];
      if (end != '.' && end != '!' && end != '?') continue;  // mid-sentence: leave it alone
      cuts.push_back(at);
    }
  }
  std::sort(cuts.begin(), cuts.end());
  cuts.erase(std::unique(cuts.begin(), cuts.end()), cuts.end());
  return cuts;
}
```

Then, inside `foldSections`, immediately after the `if (!anyHeader) return text;` line, replace
that line with:

```cpp
  if (!anyHeader) {
    // No header on a line of its own. The writer may still have put the labels inside the prose;
    // two or more of them is a shape, one is a sentence. Each piece becomes its own paragraph,
    // opened by the canonical section name so the casing matches the folded path.
    std::vector<std::string> pieces;
    for (const auto& l : lines) {
      const auto cuts = inlineLabelCuts(l, sections);
      std::size_t from = 0;
      for (const std::size_t at : cuts) {
        pieces.push_back(trimmed(l.substr(from, at - from)));
        from = at;
      }
      pieces.push_back(trimmed(l.substr(from)));
    }
    std::size_t labelled = 0;
    for (const auto& p : pieces) {
      for (const auto& name : sections) {
        if (lowered(p).rfind(lowered(name) + ":", 0) == 0) { ++labelled; break; }
      }
    }
    if (labelled < 2) return text;
    std::string out;
    for (std::size_t i = 0; i < pieces.size(); ++i) {
      if (pieces[i].empty()) continue;
      if (!out.empty()) out += "\n\n";
      // Canonical casing for the label, the rest of the piece as written.
      bool named = false;
      for (const auto& name : sections) {
        const std::string needle = lowered(name) + ":";
        if (lowered(pieces[i]).rfind(needle, 0) == 0) {
          out += name + ":" + pieces[i].substr(needle.size());
          named = true;
          break;
        }
      }
      if (!named) out += pieces[i];
    }
    return out;
  }
```

`<algorithm>` and `<vector>` must be included at the top of the file — check and add only what is
missing.

**3b. `cpp/minutes/templates.h`.** Extend the `foldSections` contract comment (anchor: the
sentence beginning `// is exactly one of the type's section names`) with one sentence:

```
// When NO line is a bare header but two or more section labels open sentences inside the prose,
// each label starts a new paragraph instead — the shape a longer section list came back in.
```

**3c. `cpp/tests/test_templates.cpp`.** Add three tests, and add all three names to the runner list
at the bottom in the same order:

```cpp
static void foldSplitsInlineLabelsWhenNoLineIsAHeader() {
  // What the A07 showed for a client call on 22 Sep: four labels, one paragraph.
  const std::string in =
      "What the client asked for: a fixed date for the pilot. "
      "What we committed to: a build by Friday. "
      "Risks and open points: the licence server is still returning 500. "
      "Next steps: Ravi sends the revised plan.";
  const std::string want =
      "What the client asked for: a fixed date for the pilot.\n\n"
      "What we committed to: a build by Friday.\n\n"
      "Risks and open points: the licence server is still returning 500.\n\n"
      "Next steps: Ravi sends the revised plan.";
  CHECK(foldSections(in, "client") == want);
}

static void foldLeavesASingleInlineLabelInsideProse() {
  // One label is a sentence, not a shape: two are needed before anything is cut.
  const std::string in =
      "The call ran long. Next steps: Ravi sends the revised plan by Friday.";
  CHECK(foldSections(in, "client") == in);
  // ...and a label that is part of a sentence is never a cut, however many there are.
  const std::string mid =
      "We talked about what the client asked for: a date. Then we agreed what we committed to: a build.";
  CHECK(foldSections(mid, "client") == mid);
}

static void foldNormalisesTheCasingOfAnInlineLabel() {
  const std::string in =
      "what the client asked for: a date. next steps: Ravi sends the plan.";
  CHECK(foldSections(in, "client") ==
        "What the client asked for: a date.\n\nNext steps: Ravi sends the plan.");
}
```

**Run:** `cmake --build cpp/cli/build -j 8 2>&1 | grep -E "error|FAILED" | tail -20` then
`(cd cpp/cli/build && ctest -R test_templates --output-on-failure 2>&1 | tail -6)` → passes, and
the five existing `fold*` tests are still in the runner list and still pass.

**Mutant:** change `if (labelled < 2) return text;` to `if (labelled < 1) return text;` →
`foldLeavesASingleInlineLabelInsideProse` must FAIL. Restore.

**Commit:** `fix(templates): a section label inside the prose still starts a section`

---

#### Step 4. The six-hour foreground-service limit

**Why.** Android 15+ stops a `dataSync` foreground service after six hours in any 24, calls
`Service.onTimeout(startId, fgsType)`, and crashes the app with
`ForegroundServiceDidNotStopInTimeException` if it has not stopped a few seconds later.
`ProcessingService` does not override it. This is reachable, not theoretical: narration measured
**3.9× realtime** on the A07, so one 90-minute meeting is already ~6 hours of work.

**The decision, already taken:** the run is not abandoned, it is *interrupted*. The engine is told
to cancel (it stops at the next stage boundary and its stage rows are already committed — see
`ResumePlan`), the person is told in a notification, and the next foreground sweep resumes the
meeting from the stage it reached. Nothing is deleted and nothing is marked failed.

**4a. A pure helper, so the decision is testable.** New file
`android/app/src/main/java/com/innocorelabs/verbale/pipeline/ServiceTimeout.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

/**
 * What to say when Android stops processing at its six-hour foreground-service limit.
 *
 * Android 15 (API 35) allows a dataSync foreground service six hours in any 24 and then calls
 * Service.onTimeout; the app must be stopped seconds later or it is killed with
 * ForegroundServiceDidNotStopInTimeException. Narration measured 3.9x realtime on a Helio G99, so
 * a long meeting reaches this honestly rather than through a bug.
 *
 * The work is not lost: stage rows are committed as they land and ResumePlan re-plans what is
 * left, so the next foreground sweep carries on. This object decides only whether there is
 * anything to tell the person, and in what words — the part worth a test.
 */
object ServiceTimeout {
  data class Notice(val title: String, val text: String)

  /**
   * [running] is the meeting in the engine when the limit hit, [queued] how many were waiting.
   * Null when nothing was in flight: the service being stopped with an empty queue is not news,
   * and a notification for it would be a lie about work that was not happening.
   */
  fun notice(running: String?, queued: Int): Notice? {
    if (running == null && queued == 0) return null
    val more = if (queued > 0) " $queued more ${if (queued == 1) "meeting is" else "meetings are"} waiting." else ""
    return Notice(
      "Paused for today",
      "Android limits background work to six hours a day and has stopped this one." +
        " Open Verbale to carry on where it left off.$more",
    )
  }
}
```

**4b. `ProcessingService.kt`.** Add the imports `androidx.annotation.RequiresApi` (and keep the
existing ones). After `onTaskRemoved` (anchor: `  override fun onTaskRemoved(rootIntent: Intent?) {`
… its closing brace), insert:

```kotlin
  /**
   * Android's six-hour limit on a dataSync foreground service (API 35+).
   *
   * We have seconds, not minutes: the system kills the app with
   * ForegroundServiceDidNotStopInTimeException if the service is still up. So this cancels rather
   * than waits — the engine stops at its next stage boundary, every stage it finished is already
   * in the database, and the next foreground sweep resumes from there via ResumePlan. The
   * notification exists because a meeting that quietly stops for six hours is indistinguishable
   * from one that failed.
   */
  @RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
  override fun onTimeout(startId: Int, fgsType: Int) {
    val id = currentId
    val waiting = queue.size
    Log.w(TAG, "foreground service timed out (type=$fgsType) with running=$id queued=$waiting")
    synchronized(lock) {
      current?.cancelled = true
      queue.clear()
      running = false
    }
    ServiceTimeout.notice(id, waiting)?.let { postTimeoutNotice(it) }
    try { stopForegroundCompat() } catch (_: Exception) {}
    stopSelf(startId)
  }

  private fun postTimeoutNotice(n: ServiceTimeout.Notice) {
    try {
      NotificationManagerCompat.from(this).notify(
        NOTIF_TIMEOUT_ID,
        NotificationCompat.Builder(this, CHANNEL_ID)
          .setSmallIcon(R.drawable.ic_notification_notes)
          .setContentTitle(n.title)
          .setContentText(n.text)
          .setStyle(NotificationCompat.BigTextStyle().bigText(n.text))
          .setAutoCancel(true)
          .build(),
      )
    } catch (_: Exception) {
      // POST_NOTIFICATIONS denied — the resume still happens, only the telling is lost.
    }
  }
```

and in the companion object, beside `NOTIF_ID` (anchor: `    private const val NOTIF_ID = 43`):

```kotlin
    /** Its own id: the progress notification is being torn down at the same moment. */
    private const val NOTIF_TIMEOUT_ID = 44
```

**4c. The test.** New file
`android/app/src/test/java/com/innocorelabs/verbale/pipeline/ServiceTimeoutTest.kt`, in the shape of
`ResumePlanTest.kt` (JUnit 4, `@Test fun …`, `assertEquals`/`assertNull`):

- `nothingInFlightIsNotWorthANotification` — `assertNull(ServiceTimeout.notice(null, 0))`.
- `aRunningMeetingIsAlwaysWorthOne` — `notice("m1", 0)` is not null, its `title` is
  `"Paused for today"`, its `text` contains `"six hours"` and `"Open Verbale"` and does NOT contain
  `"waiting"`.
- `aQueueIsCountedAndPluralised` — `notice("m1", 1)!!.text` ends with `"1 more meeting is waiting."`;
  `notice("m1", 3)!!.text` ends with `"3 more meetings are waiting."`.
- `aQueueWithNothingRunningStillSpeaks` — `notice(null, 2)` is not null (the queue was cleared, so
  those two need the same "open the app" as the running one).

**Run:** `(cd android && ./gradlew :app:testDebugUnitTest --tests '*ServiceTimeoutTest*' 2>&1 | grep -E "BUILD|tests? completed|FAILED" | tail -5)`
→ `BUILD SUCCESSFUL`. Then compile the service:
`(cd android && ./gradlew :app:compileDebugKotlin 2>&1 | grep -E "BUILD|error:|^e: " | tail -20)` → `BUILD SUCCESSFUL`.

**Mutant:** in `ServiceTimeout.notice`, change `if (running == null && queued == 0)` to
`if (running == null)` → `aQueueWithNothingRunningStillSpeaks` must FAIL. Restore.

**Do not** try to provoke a real six-hour timeout, and do not add a debug hook that fakes one. It
is not reachable on a bench and a fake would only test the fake. Say so in the report.

**Commit:** `fix(processing): Android's six-hour limit pauses a meeting instead of killing the app`

---

### Session B — the screens

Start by reading the progress file. Session A is committed; do not re-run its steps.

#### Step 5. The card must not offer a trial that is over

**Why.** After the third trial summary the Summary card still says "Try it free for 7 days". The
paywall behind it explains that the trial is spent, but the button promised something that no
longer exists.

**The decision, already taken:** the trial wording appears **only** when
`trial.status === 'unstarted'`, matching `PaywallScreen`, which already hides its trial button the
same way. Every other state — ended, or unknown because the mock or the call did not say — gets
`Get Pro`. The honest default for an unknown state is the one that promises nothing.

**5a. `src/screens/meeting/SummaryTab.tsx`.** Beside the `paid` state (anchor:
`  const [paid, setPaid] = React.useState(false);`), add:

```tsx
  // Whether the free trial is still there to be offered. Read from the same entitlement call
  // below, and false until it answers: a button that promises a trial somebody has already spent
  // is the one thing this card must not do (A07, 22 Sep).
  const [trialOffer, setTrialOffer] = React.useState(false);
```

In the effect, beside `setPaid(ent.paid);` (anchor: `        setPaid(ent.paid);`), add:

```tsx
        setTrialOffer(ent.trial?.status === 'unstarted');
```

(the `?.` is required: several existing tests mock `entitlement` as `{ paid: false }` with no
`trial`.)

Then the CTA (anchor: `                  label={\`Try it free for ${TRIAL_DAYS} days\`}`) becomes:

```tsx
                  label={trialOffer ? `Try it free for ${TRIAL_DAYS} days` : 'Get Pro'}
```

**5b. Tests** in `src/screens/meeting/__tests__/SummaryTab.test.tsx`, two, in the file's existing
style (`(entitlement as jest.Mock).mockResolvedValue(...)`, render, find by
`accessibilityLabel`/props):

- `offers the trial to somebody who has not started one` — `entitlement` resolves
  `{ paid: false, trial: { status: 'unstarted' } }`, no prose → a button labelled
  `Try it free for 7 days` exists.
- `never offers a spent trial` — `entitlement` resolves `{ paid: false, trial: { status: 'ended' } }`
  → a button labelled `Get Pro` exists and **no** node's label contains `Try it free`.

**Run:** `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx --forceExit --silent 2>&1 | tail -6` → all passed.

**Mutant:** make the label unconditional (`` label={`Try it free for ${TRIAL_DAYS} days`} ``) → the
second test must FAIL. Restore.

**Commit:** `fix(summary): a spent trial is not offered again — the card says Get Pro`

---

#### Step 6. BACK with the keyboard up closes the keyboard

**Why.** On the A07 (recorded 14 Sep, hit twice again on 22 Sep) BACK with the keyboard up closes
the whole prompt and discards what was typed. On Android the first BACK belongs to the keyboard.

**6a. `src/components/ui.tsx`.** Add `Keyboard` to the `react-native` import list (anchor: the
`  KeyboardAvoidingView,` line — `Keyboard` sorts immediately before it). Inside `TextPrompt`,
after the `useEffect` that resets the fields (anchor: `  const trimmed = value.trim();`), insert
above that line:

```tsx
  // A Modal's onRequestClose is Android's BACK. With the keyboard up, BACK belongs to the
  // keyboard: on the A07 the first press closed the whole prompt and threw away what had been
  // typed. Tracked with the keyboard's own events rather than Keyboard.isVisible(), which is a
  // snapshot taken before the event this handler is reacting to.
  const keyboardUp = React.useRef(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => { keyboardUp.current = true; });
    const hide = Keyboard.addListener('keyboardDidHide', () => { keyboardUp.current = false; });
    return () => { show.remove(); hide.remove(); };
  }, []);
  const onBack = React.useCallback(() => {
    if (keyboardUp.current) { Keyboard.dismiss(); return; }
    onCancel();
  }, [onCancel]);
```

and change the Modal's prop (anchor: `    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>`)
to `onRequestClose={onBack}`. **The backdrop `Pressable` keeps `onPress={onCancel}`** — tapping
outside is a decision to leave, not a keyboard dismissal.

**6b. Tests** appended to `src/components/__tests__/TextPrompt.test.tsx`:

```tsx
// BACK with the keyboard up belongs to the keyboard (A07). The listeners are captured rather than
// emitted, so the test does not depend on a native event ever arriving in jest.
```

- `the first BACK closes the keyboard, not the prompt` — spy on `Keyboard.addListener` to capture
  the handlers and on `Keyboard.dismiss`; render with `visible`; invoke the captured
  `keyboardDidShow`; call the Modal's `onRequestClose` prop; assert `Keyboard.dismiss` was called
  once and `onCancel` not at all.
- `BACK with no keyboard closes the prompt` — same, but fire `keyboardDidHide` first (or never fire
  show); assert `onCancel` called once and `Keyboard.dismiss` not called.

**Run:** `npx jest src/components/__tests__/TextPrompt.test.tsx --forceExit --silent 2>&1 | tail -6` → all passed.

**Mutant:** in `onBack`, delete the `if (keyboardUp.current)` guard → the first test must FAIL.
Restore.

**Commit:** `fix(prompt): BACK closes the keyboard before it closes the prompt`

---

#### Step 7. A sheet never runs off the top of the screen

**Why.** `MeetingScreen`'s overflow sheet has nine rows (`sheetActions`, line 857). On the A07 the
card is taller than the screen, so its grip and title sit under the status bar and the first row is
unreachable.

**The decision, already taken:** cap the card at **85% of the window height** and scroll the rows;
the grip, the title and Cancel stay put. `useWindowDimensions()`, not safe-area insets: `ui.tsx` is
rendered in tests that have no `SafeAreaProvider`, and `useSafeAreaInsets` throws without one.

**7a. `src/components/ui.tsx`.** Add `ScrollView` and `useWindowDimensions` to the `react-native`
import list. In `Sheet`, after `const { colors } = useTheme();` (anchor inside `export function Sheet({`):

```tsx
  // Nine rows are taller than a 720-dp phone: on the A07 the grip and the title sat under the
  // status bar and the top row could not be reached. The card is capped and the rows scroll; the
  // title and Cancel are not part of the scroll, so they are always where the thumb expects them.
  const { height } = useWindowDimensions();
```

Add `maxHeight: height * SHEET_MAX_FRACTION,` inside the object literal that already sets
`backgroundColor: colors.card` in the `Animated.View`'s style array (anchor:
`            backgroundColor: colors.card,`), and wrap the `actions.map(...)` block in:

```tsx
        <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
          {actions.map(a => {
            ...unchanged...
          })}
        </ScrollView>
```

With, beside the other module constants at the top of the styles section:

```tsx
/** How much of the screen a sheet may take before its rows scroll instead. */
const SHEET_MAX_FRACTION = 0.85;
```

**7b. Test** — new file `src/components/__tests__/Sheet.test.tsx`, two tests:

- `a long sheet scrolls instead of growing past the screen` — render `Sheet` with nine actions;
  find the `ScrollView`; assert it exists and that all nine rows are inside it
  (`scroll.findAllByProps({ accessibilityRole: 'button' }, { deep: false })` includes each label);
  assert the animated card's flattened style has `maxHeight` ≤ 0.85 × the jest window height
  (`Dimensions.get('window').height`).
- `the title and Cancel are not inside the scroll` — the node with the title text and the one
  labelled `Cancel` are NOT descendants of the ScrollView.

Wrap the render in the same theme provider the other `src/components/__tests__` files use — copy
the harness from `GradientFill.test.tsx`.

**Run:** `npx jest src/components/__tests__/Sheet.test.tsx --forceExit --silent 2>&1 | tail -6` → all passed,
then `npx jest src/screens/__tests__/MeetingScreen.test.tsx src/screens/__tests__/LibraryScreen.test.tsx --forceExit --silent 2>&1 | tail -6`
→ still all passed (they find sheet rows by label; the ScrollView must not have moved them out of reach).

**Mutant:** remove `maxHeight` from the card's style → the first test must FAIL. Restore.

**Commit:** `fix(sheet): nine rows scroll instead of pushing the title off the screen`

---

#### Step 8. The Summary card's header row at 384 dp

**Why.** On the A07 (384 dp wide) the header row holds SUMMARY, the type chip, "43 min · 3
speakers", Edit and Copy; "Copy" renders as "Co". This is not the Android 15 text-clip bug fixed in
`0d9910e` — it is a row with more siblings than fit, and nothing in it is allowed to shrink.

**The decision, already taken:** the meta line is the one part that can lose characters without
losing meaning, so it shrinks and ellipsises; the chip and the tools do not. Do not remove the
overline, do not wrap the row, do not shorten "Copy".

**8a. `src/screens/meeting/SummaryTab.tsx`.** In the styles (anchor: `    headRow: {`):

```tsx
    headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: s(6) },
```

add, beside `dim` (anchor: `    dim: { opacity: 0.8 },`):

```tsx
    // The one member of the header row that may lose characters: at 384 dp the chip, the meta,
    // Edit and Copy do not fit, and without this the row overflows and clips "Copy" to "Co".
    meta: { flexShrink: 1 },
```

and change `tools` (anchor: `    tools: { flexDirection: 'row', gap: s(14) },`) to:

```tsx
    tools: { flexDirection: 'row', gap: s(14), flexShrink: 0 },
```

Then the meta `Txt` (anchor: `              <Txt variant="chipSoft" color={colors.onPrimary} style={st.dim}>`) becomes:

```tsx
              <Txt variant="chipSoft" color={colors.onPrimary} style={[st.dim, st.meta]} numberOfLines={1}>
```

**8b. Test** in `SummaryTab.test.tsx`: `the meeting meta is the part of the header that shrinks` —
render with prose so Edit and Copy are present; find the `Text` whose content matches `/min ·/`;
assert `numberOfLines === 1` and that its flattened style has `flexShrink: 1`; and assert the node
holding the Copy button has a style with `flexShrink: 0`.

**Run:** `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx --forceExit --silent 2>&1 | tail -6` → all passed.

**Mutant:** drop `numberOfLines={1}` → the test must FAIL. Restore.

**Commit:** `fix(summary): the header row shrinks the meta instead of clipping Copy`

---

#### Step 9. The paywall answers where you are looking

**Why.** Tapping "Try Pro free for 7 days" replaces the hero copy at the top of the scroll with the
confirmation — which is out of view, because the button is near the bottom. On the A07 it looked
like nothing had happened.

**9a. `src/screens/PaywallScreen.tsx`.** Add a ref beside the other state (top of the component):

```tsx
  // The trial's confirmation is the hero line at the top of the scroll, and the button that starts
  // it is near the bottom. Without this the screen answers somewhere the reader is not looking.
  const scroller = React.useRef<ScrollView>(null);
```

This file imports its hooks by name — `import React, { useCallback, useEffect, useMemo, useState } from 'react';`
— so add `useRef` to that list and write `useRef`, not `React.useRef`.

Put it on the ScrollView (anchor: `      <ScrollView`) as `ref={scroller}`, and in `onStartTrial`,
immediately after `      await load();`:

```tsx
      scroller.current?.scrollTo({ y: 0, animated: true });
```

**9b. Test** — new file `src/screens/__tests__/PaywallScreen.test.tsx`. Mocks, in the shape of
`ActionsScreen.test.tsx`: `react-native-safe-area-context` (`useSafeAreaInsets` → zeros),
`../../billing/trial` (`TRIAL_DAYS: 7`, `TRIAL_SUMMARIES: 3`, `entitlement`, `startTrial`,
`markPaywallSeen`), `../../billing/subscription` (`playAvailable` → false, `playPlans` → [],
`playPrice` → null, `buyWithPlay`, `referencePrice`), `../../native/NativeModelManager`
(`list` → `'[]'`, `deviceFit` → `'{"freeBytes":100000000000}'`, `download`), and
`../../billing/SignInForm` (a null component). Two tests:

- `starting the trial scrolls back to the answer` — `entitlement` resolves
  `{ paid: false, viaTrial: false, trial: { status: 'unstarted' }, licence: null }`; render; find
  the button labelled `Try Pro free for 7 days`; spy on the ScrollView instance's `scrollTo`; press;
  await; assert `scrollTo` was called with `{ y: 0, animated: true }`.
- `an ended trial is not offered one` — `trial.status: 'ended'` → no node labelled
  `Try Pro free for 7 days` (this pins the behaviour Step 5 mirrors).

If the ScrollView's `scrollTo` cannot be spied on through `react-test-renderer`, assert instead on
a mocked `ScrollView` — but try the instance first, and record in *Decisions* which one you used.

**Run:** `npx jest src/screens/__tests__/PaywallScreen.test.tsx --forceExit --silent 2>&1 | tail -6` → all passed.

**Mutant:** delete the `scroller.current?.scrollTo(...)` line → the first test must FAIL. Restore.

**Commit:** `fix(paywall): starting the trial scrolls back to the sentence that answers it`

---

### Step 10. The gate, then the report

1. `npx tsc --noEmit 2>&1 | tail -3` → nothing.
2. `npx jest --silent 2>&1 | tail -6` → every suite passes. (Never pipe jest into `head`; it hangs.)
3. `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh > /tmp/gate.log 2>&1; grep -E "^==>|ok |FAIL|all clear" /tmp/gate.log`
   → `gate: all clear`. If a stage fails in a file this session did not touch, do not investigate:
   record the last 20 lines and report.
4. Write `docs/superpowers/reports/2026-09-22-layer-1-cleanup.md` to the contract in §8, commit it,
   and delete the progress file in the same commit.

---

### Session D — the device checks (only with the A07 attached)

`adb -s R9ZL402YH5A`. The phone is the founder's bench device: its data is disposable but **never
run `pm clear`, never uninstall, and never run `connectedDebugAndroidTest`** without being told to.
Install the release build (`android/app/build/outputs/apk/release/app-release.apk`) with
`adb -s R9ZL402YH5A install -r`, and do not install a debug build over it — the debug build has no
JS bundle.

| # | What | What must happen |
|---|---|---|
| D1 | Open any meeting, tap ⋮ | The sheet's title is fully visible below the status bar and all nine rows are reachable by scrolling (Step 7) |
| D2 | On the same meeting, long-press a line → Correct the words → type, then press BACK once | The keyboard closes, the prompt and the typed text stay (Step 6) |
| D3 | A meeting with prose, screenshot the Summary card | The header reads "Copy" in full; the meta may be shortened with "…" (Step 8) |
| D4 | Settings → the trial is spent on this phone → open any meeting without prose | The button reads "Get Pro" (Step 5) |
| D5 | Paywall → "Try Pro free for 7 days" is NOT offered (trial spent). If a fresh install is ever made: tap it and watch | The screen scrolls to the top and the hero line answers (Step 9) |

Screenshot each of D1–D4 into `/tmp` and say in the report what each showed. Do not fix anything
found here: record it.

---

## 4. Expected interfaces after this sheet

```ts
// src/pipeline/minutes.ts
export const DECISION: RegExp;
export const SCHEDULE_VERB: RegExp;
export const SCHEDULE_WHEN: RegExp;
export function isDecision(sentence: string): boolean;
export function isQuestion(sentence: string): boolean;   // unchanged signature
```

```cpp
// cpp/minutes/minutes_extractor.h — unchanged. isDecision/isQuestion keep their signatures.
// cpp/minutes/templates.h — unchanged signature for foldSections; the contract comment grows.
```

```kotlin
object ServiceTimeout {
  data class Notice(val title: String, val text: String)
  fun notice(running: String?, queued: Int): Notice?
}
// ProcessingService gains: override fun onTimeout(startId: Int, fgsType: Int)
```

```tsx
// src/components/ui.tsx — Sheet and TextPrompt keep their props exactly. No prop is added.
// SummaryTab, PaywallScreen — no prop changes; internal state only.
```

---

## 5. Tests and commands

| Step | Command | Must show |
|---|---|---|
| 1, 2 | `npx jest src/pipeline/__tests__/minutes.golden.test.ts --forceExit --silent 2>&1 \| tail -6` | all passed |
| 1, 2 | `(cd cpp/cli/build && ctest -R "test_minutes\|test_evidence" --output-on-failure 2>&1 \| tail -8)` | 100% tests passed |
| 3 | `(cd cpp/cli/build && ctest -R test_templates --output-on-failure 2>&1 \| tail -6)` | 100% tests passed |
| 4 | `(cd android && ./gradlew :app:testDebugUnitTest --tests '*ServiceTimeoutTest*' 2>&1 \| grep -E "BUILD\|FAILED" \| tail -5)` | BUILD SUCCESSFUL |
| 4 | `(cd android && ./gradlew :app:compileDebugKotlin 2>&1 \| grep -E "BUILD\|error:\|^e: " \| tail -20)` | BUILD SUCCESSFUL |
| 5, 8 | `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx --forceExit --silent 2>&1 \| tail -6` | all passed |
| 6 | `npx jest src/components/__tests__/TextPrompt.test.tsx --forceExit --silent 2>&1 \| tail -6` | all passed |
| 7 | `npx jest src/components/__tests__/Sheet.test.tsx src/screens/__tests__/MeetingScreen.test.tsx --forceExit --silent 2>&1 \| tail -6` | all passed |
| 9 | `npx jest src/screens/__tests__/PaywallScreen.test.tsx --forceExit --silent 2>&1 \| tail -6` | all passed |
| 10 | `npx jest --silent 2>&1 \| tail -6` | every suite passed |
| 10 | `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh > /tmp/gate.log 2>&1; grep -E "^==>\|ok \|FAIL\|all clear" /tmp/gate.log` | gate: all clear |

---

## 6. Acceptance criteria

- All ten commands in §5 green, and each step's named mutant tried and recorded.
- `git diff --stat 55d8575..HEAD` names only: `src/pipeline/minutes.ts`, `src/pipeline/evidence.ts`,
  `src/pipeline/__tests__/minutes.golden.test.ts`, `cpp/tests/golden/*.json` (generated),
  `cpp/minutes/minutes_extractor.cpp`, `cpp/minutes/templates.cpp`, `cpp/minutes/templates.h`,
  `cpp/tests/test_templates.cpp`, the two new Kotlin files plus `ProcessingService.kt`,
  `src/screens/meeting/SummaryTab.tsx`, `src/screens/meeting/__tests__/SummaryTab.test.tsx`,
  `src/components/ui.tsx`, `src/components/__tests__/TextPrompt.test.tsx`,
  `src/components/__tests__/Sheet.test.tsx`, `src/screens/PaywallScreen.tsx`,
  `src/screens/__tests__/PaywallScreen.test.tsx`, `docs/superpowers/reports/2026-09-22-layer-1-cleanup.md`.
  Nothing else. No golden edited by hand.
- `grep -n "Try it free" src/screens/meeting/SummaryTab.tsx` shows it inside the `trialOffer ?` line
  and nowhere else.
- `grep -c "useBoundsForWidth" android/app/src/main/res/values-v35/styles.xml` is still 1 — Step 8 is
  a layout fix and must not touch the theme.
- `git status` clean. No file left in the tree that is not committed.

---

## 7. Stop conditions

- A step needs a change in a §2 file: stop, write what and why in the progress file, commit, report.
- Two unsuccessful fixes of the same failing test or compile error: stop, record the error and both
  attempts, commit, report.
- A gate stage fails in a file this session did not touch: do not investigate; record the last 20
  lines, commit, report.
- The device is absent or in use: do every non-device step, mark Session D "not run — device
  unavailable", commit, report. Never wait more than ten minutes.
- 150 steps: finish the current step, commit, update the progress file, stop.

---

## 8. The report contract

`docs/superpowers/reports/2026-09-22-layer-1-cleanup.md`:

1. **Status in one line.**
2. **What was built**, one short paragraph per step.
3. **Decisions taken** — only those this sheet left open (there should be at most the one in Step
   9b). Anything else you decided is a defect in this sheet: say so plainly.
4. **A table of tests**: name · result · mutant tried · what the mutant did.
5. **The gate summary**, pasted.
6. **Session D**, each row with what the phone showed, or "not run — device unavailable".
7. **For the founder to test by hand** — numbered, each with the exact thing to look for.
8. **Known gaps.**
9. **Commits**, `git log --oneline 55d8575..HEAD`.

If something was not run, say so. Never mark it done.

---

## 9. The prompts that start each session

One line each. Nothing else — everything the session needs is in this sheet.

**Session A** (the rules layer; no device):

> Read `docs/superpowers/specs/2026-09-22-layer-1-cleanup-execution.md` and execute Session A
> exactly as written: Steps 1–4, under its §0 token rules. Stop after committing Step 4 and the
> progress file, when a §7 stop condition is met, or at 150 steps. Do not push.

**Session B** (the screens; no device):

> Read `docs/superpowers/specs/2026-09-22-layer-1-cleanup-execution.md` and then
> `docs/superpowers/reports/layer-1-cleanup-progress.md`. Execute Session B exactly as written:
> Steps 5–9, then Step 10, under its §0 token rules. Stop when the report is committed, when a §7
> stop condition is met, or at 150 steps. Do not push.

**Session D** (device; start it only with the A07 plugged in and the app on screen):

> The Galaxy A07 (`adb -s R9ZL402YH5A`) is attached with the release build installed. Read
> `docs/superpowers/specs/2026-09-22-layer-1-cleanup-execution.md` §Session D and
> `docs/superpowers/reports/layer-1-cleanup-progress.md`. Run D1–D5 exactly as written, write §6
> and §7 of the report from what the phone showed, commit. Fix nothing. Do not push.

---

## 10. What is deliberately NOT in this sheet

These are the remaining Layer 1 items, and they are not a builder's work:

- **The human consent clip** — waiting on the founder's recording (point A of
  `docs/FOUNDER_TODO_2026-09-22.md`), then the final gate and the AAB.
- **The 90-minute capture** — needs the Mac's speakers for ninety minutes and a person watching the
  memory. Mine.
- **Phase 4 steps 3 and 5** — a fresh install and a second real human voice. The founder's.
- **The templates suggester threshold** — a calibration the founder owns (Phase 2 review, 17 Sep).
