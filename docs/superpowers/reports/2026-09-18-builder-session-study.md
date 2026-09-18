# Builder sessions, studied: brief vs execution sheet — Phase 4, 18 September 2026

*Two sessions of the same builder (Laguna S 2.1 via OpenRouter, 262k context) built Phase 4
(remembered voices). Session A worked from a **brief** (what to build, tests as the definition of
done, decisions fixed); Session B from an **execution sheet** (every edit with its code, every
test with its assertions, every command with its filter, stop conditions). Both were reviewed by
Opus against the code the same day. This is what they cost and what they produced.*

## 1. The raw numbers (from OpenRouter)

| | Session A, run 1 | Session A, run 2 (free endpoint) | Session B |
|---|---|---|---|
| Steps | 196 | 51 | 170 |
| Uncached input tokens ("In") | 352,881 | 506,464 | 307,098 |
| Output tokens | 71,842 | 10,775 | 39,189 |
| Reasoning tokens | 46,635 | 12,819 | 135,657 |
| Cache reads | 34,466,912 | 3,462,560 | 24,575,232 |
| Cache hit rate | 99.0% | 87.2% | 98.8% |
| Billed | $0.363 | $0.00 | $0.280 |

Session A needed a second run: 196 steps filled the 262k context (average context per step
178k, so the last steps were at the ceiling) and the work continued in a fresh context on the
free endpoint. Run 2's shape is the signature of a context reset — 9,931 uncached tokens per step
against 1,800 in the other two runs, and an 87% hit rate: it was re-reading what run 1 already
knew. Session B finished in one run at an average of 146k per step.

Prices, derived from the two paid runs (assuming reasoning is billed as output and a cache read
costs a tenth of uncached input, the usual shape): input $0.090/M, output $0.180/M, cache read
$0.009/M. On those prices run 2 would have billed **$0.081**, so Session A's true cost is
**$0.444**. The relative conclusions below do not depend on the price assumption.

## 2. Where the money went

| | A (both runs) | B |
|---|---|---|
| Cache reads (context size × steps) | 85% of run 1 | 79% |
| Uncached input | ~9% | ~10% |
| Output | ~4% | ~3% |
| Reasoning | **2–3%** | **9%** |

**The cost driver is context size multiplied by step count, not thinking.** Session B reasoned
3.5 tokens per output token (A: 0.7) — the execution sheet made the model check its work *more*,
not less — and that was still under a tenth of its bill. What decides cost is how big the context
is on every step and how many steps there are. "Don't think, execute" saved nothing on reasoning;
it saved steps and context.

## 3. What each session produced

| | Session A (brief) | Session B (sheet) |
|---|---|---|
| Work | schema (both mirrors), the Kotlin match rule + golden, JNI, six `AudioDb` functions, the pipeline hook, the bridge, three device tests | four screens changed, one new component, 23 jest tests, the report |
| Lines added: code / tests / docs | 467 / 451 / 34 | 264 / 294 / 106 |
| Wall-clock, first→last commit | 49 min | 47 min |
| Commits | 6 | 5 code + 3 progress ticks + 1 report |
| Steps per code commit | 41 | 34 |
| Cost per 1,000 lines | $0.47 | $0.42 |
| Cost per test | $0.044 (10, three on-device) | $0.012 (23, all jest) |
| **Review findings** | 1 logic defect (a sentence in the brief contradicted its own margin rule and was followed literally), dirty tree at hand-over, a whole block indented one space off, a git worktree left inside the repo | **none** |
| Deviations from the instructions | several taken, none recorded | 2 taken, both recorded, both correct |
| Stop conditions | none defined | one met (phone absent) and handled exactly as written |
| Device steps | run (phone was attached) | not run (phone absent) — by the sheet's own rule |

Caveat, stated plainly: A did the native half and B the screens, so this is instruction style
*and* work type, not a clean A/B. The native half has heavier tests (three on a phone) and
touches files that are harder to edit safely. Even so, the direction is not in doubt.

## 4. Findings

1. **The sheet cut steps by 31% (247 → 170) and cost by 37% ($0.444 → $0.280), and produced
   zero review defects.** Per line the two cost about the same; per *correct* line the sheet wins
   outright, because A's lines came back with four things to fix.
2. **A context reset costs about fifty steps and $0.08 — 18% of Session A.** The 262k ceiling
   is real and the builder does not notice it coming; it noticed only when the run died. The
   brief's "stop at two thirds" rule was never acted on because the model has no way to measure
   its own context. Steps are what it can count.
3. **The builder's defects were instruction defects.** The one logic error was a contradiction in
   the brief (tie-break vs margin), executed faithfully. The hygiene faults (dirty tree,
   indentation) are what a builder does when nobody wrote "run `git status` before you stop" and
   "indent like the surrounding code" — Session B's sheet had both implicitly (commit per step,
   code given in full) and had neither fault.
4. **Reasoning is cheap; let it think.** Suppressing reasoning would save under 10%. What the
   sheet actually changed is that the model spent its reasoning verifying against explicit
   assertions rather than deciding what to build.
5. **Both sessions lost their device steps to the phone being absent** — B correctly, A
   fortuitously not. That is a process gap on our side, not the builder's.

## 5. What changes for Phase 5

- **Execution sheets for every session, native included.** The brief stays as the reference for
  copy and the report contract; the sheet is what the builder reads.
- **A hard step budget in every sheet: hand over at 150 steps.** "Two thirds of context" is
  unmeasurable from inside; steps are not. 150 leaves room for the handover commit and progress
  file at a context the next session can pick up cheaply.
- **Three sessions, not two, when there are device steps:** native, screens, and a short
  device-only session (~30 steps) that the founder starts only with the Pixel on the desk and
  Verbale focused. A session that starts without the phone must never carry device steps.
- **Two lines every sheet now carries:** "`git status` must be clean before you stop" and
  "indentation is the surrounding file's, two spaces".
- **Keep the read list under 8k tokens.** Session A's average context ran 30k higher than B's
  from the start; the difference is the size of what it read first.
- **Never continue a dead context on another endpoint.** Start the next session from the
  progress file instead; that is what it is for.

## 6. Sources

OpenRouter usage for the three runs as pasted by the founder on 18 Sep; git
(`5c16e3a..a5704e5` Session A, `7363106..41767f9` Session B) for timestamps, lines and tests;
the two reviews (`9750864`, and Session B's review in the Phase 4 report's discussion, 18 Sep).
