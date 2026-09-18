# Building with Kilo: the practices that worked

*Written 18 September 2026 from four builder sessions on the Verbale app (two with Sonnet, two
with Laguna S 2.1 on OpenRouter, 262k context), each reviewed against the code the same day and
one pair measured for cost. Project-agnostic on purpose — copy this file into any repository
that uses a cheaper model in Kilo to build what a stronger model designs. Nothing here is theory;
every rule is something we paid for once.*

---

## 1. The division of labour

- **The brain** (a strong model in an interactive session: Claude Opus here) designs, decides,
  measures anything model-dependent, writes the instructions, and reviews the result.
- **The builder** (Kilo, running a cheaper model) executes the instructions in a fresh session,
  from a one-line prompt, and stops when a defined condition is met.
- **The human** tests by hand from the report's "for you to test" section, pushes, and decides.

The builder does not design and does not decide. When it is made to, it will do so faithfully
and literally — including executing a contradiction the brain wrote. Every defect we found in a
builder's work was an instruction defect.

## 2. Give the builder an execution sheet, not a brief

A **brief** says what to build, fixes the decisions, and lists the tests as the definition of
done. It worked with Sonnet. With a smaller, cheaper model it cost 31% more steps, 37% more
money, needed a second run after filling its context, and came back with four things to fix.

An **execution sheet** says exactly what to do, in order, with the code. Same builder, same
phase: one run, fewer steps, zero defects. Its sections, in this order:

1. **Rules** — token discipline, TDD-with-mutant, commit per step, never push, the progress
   file, the phone/device rule. Compressed; the builder already knows how to work.
2. **Relevant files** — a table: file · **line ranges** · why. These are the only files it may
   read. Verified against the code *on the day the sheet is written* (line numbers drift).
3. **Files that must not change** — named explicitly. Anything the brain owns (native code,
   schema, shared mocks, the design system) goes here.
4. **Implementation sequence** — numbered steps. Each step gives: the file; the code to insert
   (in full — a smaller model's rewrite of "add a banner like the review banner" is where the
   bugs are); the anchor to insert at (a grep-able line, never a line number); the test file with
   **each test's assertions spelled out**; the exact command with its output filter and what it
   must print; the **named mutant** (what to break, which test must then fail); the commit
   subject.
5. **Expected interfaces** — the signatures, props, settings keys and JSON shapes that exist
   after each step. The builder checks itself against these instead of inventing.
6. **Exact tests and commands** — one table: step · command · must show.
7. **Acceptance criteria** — the green list; `git diff --stat <base>..HEAD` may name only the
   listed files; a grep that proves the copy is verbatim.
8. **Stop conditions** — see §6.

Write statements, not conditionals. "If the icon `trash` exists use it, else …" makes the
builder investigate; "the icon `trash` exists" (because you checked) makes it execute. Never
write a sentence a test could contradict: our one logic defect was "ties break to the first
listed" next to "refuse unless the margin is 0.10" — the builder chose the sentence, not the
test.

## 3. Do the risky work before writing the sheet

The brain, not the builder, does:

- **Every model-dependent number.** Thresholds, cosines, prompt wording. Measure on the real
  model, on real data, pin the measurement with a live test that skips itself when the model is
  absent, and put the table of numbers in the sheet with "do not retune to make a case pass".
- **Code that touches a model or an engine** (the C++ that reads the speaker model, the prompt
  builder). Give the builder a tested function to call.
- **The adversarial fixture.** A test whose fixture cannot provoke the failure passes for the
  wrong reason: ours passed on discussion-shaped text while list-shaped text lost its sections on
  the phone. For every list or rendering, name the awkward case in the sheet.
- **Verification levers** the by-hand run will need (reset a one-time prompt, end a trial),
  so the builder never has to touch the layer that owns them.
- **Anchor verification.** Every file path, line range, prop name, icon name, theme key and
  export in the sheet is grepped the day it is written.

## 4. Budget the session: it is context × steps that costs

Measured on OpenRouter (Laguna S 2.1; input $0.09/M, output $0.18/M, cache read $0.009/M):

| | Brief session | Sheet session |
|---|---|---|
| Steps | 196 + 51 (second run) | 170 |
| Average context per step | 178k (then hit 262k) | 146k |
| Cache reads as share of cost | 85% | 79% |
| Reasoning as share of cost | 2–3% | 9% |
| Cost | $0.444 | $0.280 |

- **Cache reads — the whole context re-read every step — are 80–85% of the bill.** Reasoning is
  under a tenth. Do not try to make the builder think less; make its context smaller and its
  steps fewer. The sheet session reasoned *more* per output token (checking against explicit
  assertions) and still cost less.
- **A context reset costs about fifty steps and a fifth of the session.** The builder cannot
  measure its own context; it can count steps. So every sheet carries a **hard hand-over at
  150 steps**: commit, update the progress file, stop.
- **Split the work into sessions of ≤150 steps by layer:** native/data, screens, and a short
  device-only session (~30 steps) started only with the device attached. A session that starts
  without the device must never carry device steps.
- **Never continue a dead context on another endpoint.** Start the next session from the
  progress file. That is what it is for.
- **Keep the initial read list under ~8k tokens.** The brief session's context ran 30k higher
  than the sheet session's from step one, and that gap is the size of what it read first.

## 5. Token discipline the builder must follow (put these in every sheet)

- Read only the files and line ranges listed. Never print a file over 200 lines; `grep -n` to
  locate, then `sed -n 'A,Bp'` for at most 60 lines.
- Every build and test command ends in a filter. Gradle: `2>&1 | grep -E "BUILD|error:|FAILED" | tail -20`
  then read counts from the XML. jest: `--silent 2>&1 | tail -15`. Long runs: redirect to a
  log file and grep it. Logcat: `-d | grep <tag> | tail -20`, never streaming.
- Do not re-read a file just edited; the edit tool reports success.
- Do not paste code into chat; commit it and name the file.
- Record decisions and mutants in the progress file **as they happen**, not from memory at the
  end.

## 6. Stop conditions (copy these)

- If a step needs a change in a file under "must not change": stop, write what and why in the
  progress file, commit, report.
- After two unsuccessful fixes of the same failing test or compile error: stop, record the error
  and both attempts, commit, report.
- If a gate stage fails in a file this session did not touch: do not investigate; record the
  last 20 lines, commit, report.
- If the device is absent or in someone else's use: do every non-device step, mark the device
  steps "not run — device unavailable" in the report, commit, report. Never wait more than ten
  minutes.
- At 150 steps: finish the current step, commit, update the progress file, stop.

## 7. Repository hygiene for Kilo

- **Kilo creates git worktrees inside the repository** under `.kilo/worktrees/`. Left there,
  jest collected every test suite twice (520 → 885) and the gate lied about its counts. Add
  `.kilo/` to `.gitignore`, to jest's `testPathIgnorePatterns` and `modulePathIgnorePatterns`,
  and to `tsconfig.json`'s `exclude` — before the first Kilo session, not after. Remove stale
  worktrees with `git worktree remove --force <path>` and `git worktree prune`.
- Two lines in every sheet: "**`git status` must be clean before you stop**" and "**indent like
  the surrounding file**". Without them we got a dirty tree at hand-over and a whole block
  indented one space off.
- Commit after every green step, with a subject in the repository's style (point the builder at
  `git log --oneline -6`). Never push — the human pushes.
- Name the destructive commands the builder must never run (for us: the instrumented-test
  Gradle task that uninstalls the app and wipes its data).
- One progress file per phase, committed with each step: the task list as checkboxes, then
  *Decisions*, *Mutants*, *Notes for the next session*. The next session reads it first and
  trusts it. The final session deletes it once the report holds its content.

## 8. The report the builder writes, and the review the brain does

The sheet ends with a report contract: status in one line; what was built; decisions taken;
a table of tests with names, results, mutants tried and their result; the gate summary; each
device item with what the device showed; **numbered steps for the human to test by hand, each
with the exact thing to look for**; known gaps; commits. "If something was not run, say so —
never mark it done."

The brain's review, before the human tests:

1. Re-run the gate. Force any cached test suites to actually execute (Gradle serves 0.000 s
   results from cache).
2. Read every changed file against the sheet — the builder does what the tests say, so the
   review reads what the tests do not cover.
3. `git diff --stat <base>..HEAD`: only the listed files, plus type-driven fixups.
4. Hygiene: `git status` clean, indentation, no stray worktrees or scratch files.
5. Run the real model on the adversarial case yourself if the phase touches a model.
6. Write the findings into the report (or the progress file) and fix what is the sheet's fault.

## 9. Prompts

Start each session with one line. Session A:

> Read `<sheet>` and execute Session A exactly as written: Steps 1–6, under its token rules.
> Stop after committing Step 6 and the progress file, or at 150 steps. Do not push.

Session B:

> Read `<sheet>` and then `<progress file>`. Execute Session B exactly as written: Steps 7–12,
> under its token rules. Stop when the report is committed, when a stop condition is met, or at
> 150 steps. Do not push.

Device session:

> The device is attached and the app is focused. Read `<sheet>` §Device and `<progress file>`.
> Run the device steps exactly as written, write §6 and §7 of the report from what the device
> showed, commit. Do not push.

## 10. The one-page checklist

Before a session: sheet written and anchors grepped today · model numbers measured and pinned ·
`.kilo/` ignored · device attached if the session has device steps · progress file in place.

In the sheet: line-ranged reads · must-not-change list · code in full with grep anchors · tests
with assertions · commands with filters and expected output · mutants named · interfaces ·
acceptance · stop conditions · 150-step hand-over · clean-tree and indentation lines.

After a session: gate re-run · cached suites forced · diff read against the sheet · file set
checked · hygiene · findings written down · then the human tests.
