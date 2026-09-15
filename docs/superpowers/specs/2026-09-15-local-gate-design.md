# The local gate — design

**15 September 2026.** First of the sub-projects agreed that day, ahead of the record-screen
cluster. Decision taken: no cloud CI. The gate runs on the developer's machine, before every push,
and includes the phone when one is attached.

## Why

Every check this project has — eleven of them — is run by hand. On 14 September the meeting
screen's focus effect broke 24 tests in a suite nobody re-ran, and it was caught only because the
full jest run happened to precede the merge. A gate that runs itself is the difference between
"we run the tests" and "the tests ran".

## What

One script, `scripts/gate.sh`, runnable by hand (`npm run gate`) and by git (`pre-push`).
Stages in order; the first failure stops the run and names itself; each stage prints one line
with its time.

| # | Stage | Command | Typical |
|---|---|---|---|
| 1 | Types | `npx tsc --noEmit` | 10 s |
| 2 | JavaScript | `npx jest --silent` | 40 s |
| 3 | Scans | `check:egress`, `check:fence`, their Python tests, `check-diar-constants.py`, `check-engine-encapsulation.py`, `check-live-transcript.py` | 5 s |
| 4 | Reconciler mutations | `scripts/mutate-reconciler.py` — must end "all N mutations caught" | 60 s |
| 5 | Kotlin | `./gradlew :app:testDebugUnitTest -q` | 60 s |
| 6 | C++ | build `cpp/cli/build` (cmake from the Android SDK; configure if absent), then `ctest` | 30 s warm |
| 7 | Device | one authorised device on `adb` → `npm run test:device`; none → "no phone — device tests skipped", pass; unauthorised → say so, pass | 8 min |

Stages 1–6 are required. Stage 7 never blocks on a missing phone: the phone's absence is a fact
about the desk, not the code, and the run says plainly that it was skipped.

`scripts/hooks/pre-push` calls the gate; a non-zero exit refuses the push. `git push --no-verify`
bypasses it, on purpose, for the person who knows what they are doing.

`npm run hooks:install` runs `git config core.hooksPath scripts/hooks`. The hooks directory is
versioned; nothing else is installed.

## What the gate does not do

- Build an APK or bundle. A release is a deliberate act (`npm run apk`, `bundleRelease`) with its
  own guards in `build.gradle`.
- Lint. `eslint .` reports 12 pre-existing warnings and no errors; adding it as a gate would either
  be a no-op or a fight with warnings that predate this work. It stays `npm run lint`.
- Run unattended. There is no scheduler.

## The gate must be able to fail

`scripts/__tests__/test_gate.py` runs `gate.sh` with `GATE_STAGES` narrowed to a single stage
and a deliberately failing command substituted (`GATE_FAKE_FAIL=<stage>`), and asserts exit 1
with that stage named; and with no substitution, asserts stage 1 passes. Without this the gate is
another claim nothing can see.

## Where it is written down

`docs/ANDROID_TESTING.md` gains a short "The gate" section: how to install the hook, how to run
it by hand, what it skips without a phone, and that `--no-verify` exists.

## Measured, 15 September

Two runs on the development Mac, warm caches, no phone attached (the Pixel had just dropped off
USB): by hand `npm run gate` **114 s**; by the hook on the next push **87 s**. Per stage: types
2–3 s · jest 2–5 s (362 tests; jest's cache makes an unchanged tree cheap — a real change costs
~40 s) · scans 2–3 s · reconciler mutations 70–78 s (the floor of every run: 31 gradle test
invocations) · Kotlin 4–5 s when up to date, ~60 s after a change · C++ 3–24 s · device 0 s
skipped. With the Pixel attached the device stage adds the 72-test suite, measured at about five
minutes the previous evening. So: **about two minutes without a phone, about seven with**, and the
mutation harness is where any future speed-up lives.

The hook has refused a push once already, in Task 2's dry run with a forced failing stage, and
passed one for real: `8020e1d..4a8f07e main -> main` went out behind an all-clear.
