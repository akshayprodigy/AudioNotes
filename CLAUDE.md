# Verbale — how work is done here

## Standard development process (founder's standing rule, 22 Oct 2026)

Every change is built **subagent-driven**. Do not ask the founder to repeat this.

- **All subagents run on Sonnet** (`model: "sonnet"`): implementers, spec reviewers, code-quality
  reviewers, investigators, device/emulator checkers.
- **The main session (Opus) only oversees.** It decides scope with the founder, writes the plan
  (task specs with acceptance criteria), dispatches the subagents, and checks that the work is
  really done: reads the diffs, re-runs the gate, looks at the app. It does not write the
  feature code itself.
- Per task, following `superpowers:subagent-driven-development`: one Sonnet **implementer**
  (TDD), then a Sonnet **spec-compliance reviewer**, then a Sonnet **code-quality reviewer**
  (`superpowers:code-reviewer`). Issues go back to the implementer and are re-reviewed until clean.
  Implementers run one at a time, never in parallel.
- Plans live in `docs/superpowers/plans/`, reports in `docs/superpowers/reports/`.

## House rules every subagent prompt must carry

- Work on the feature branch named in the plan, never on `main`. Never push.
- TDD: the test first and watched failing; each task names a mutant that must make a test fail
  (then restore the code). macOS `sed` is BSD — use python for mutants.
- Gate: only `GATE_STAGES="types js scans" scripts/gate.sh` inside a task. Never the bare gate
  (its device stage runs on any attached phone). Never run `adb` against a physical phone.
- The Galaxy A07 (serial R9ZL402YH5A) is the founder's phone with a Play install and real
  meetings: never install to it, never uninstall, never wipe.
- Run single jest files with `--forceExit` (the Mascot's `Animated.loop` keeps jest alive, and
  orphaned jest processes make later gate runs flaky). The full gate exits on its own.
- Indent like the surrounding file (2 spaces). Pipe long output through `tail`/`grep`.
- `git status` clean at the end; commit messages end with
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Product rules that keep coming back

- No screen names a model ("Whisper small", "Qwen…"); say what it is for. The Notices screen is
  the exception (licence attribution).
- Features the phone is entitled to download by themselves; no Get/Remove buttons.
- English only at launch.
