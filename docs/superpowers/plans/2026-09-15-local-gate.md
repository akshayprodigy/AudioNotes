# The Local Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One script that runs every check this project has, by hand and before every push, with the phone included when one is attached and never required.

**Architecture:** `scripts/gate.sh` runs seven stages in order and stops at the first failure. `scripts/hooks/pre-push` calls it; `npm run hooks:install` points git at the versioned hooks directory. A Python test drives the gate with a substituted failing stage and a stubbed `adb`, so the gate's own promises can be seen to fail.

**Tech Stack:** bash, git `core.hooksPath`, Python `unittest`, the existing gates (tsc, jest, gradle, cmake/ctest, the scripts under `scripts/`).

Spec: `docs/superpowers/specs/2026-09-15-local-gate-design.md`.

---

## File structure

- Create `scripts/gate.sh` — the gate. Stage functions, one runner, env overrides for the test (`GATE_STAGES`, `GATE_FAKE_FAIL`, `ADB`, `CMAKE`).
- Create `scripts/__tests__/test_gate.py` — three tests: a failing stage stops the run and is named; a real stage passes; no phone is a skip.
- Create `scripts/hooks/pre-push` — two lines, calls the gate.
- Modify `package.json` scripts — `gate`, `gate:test`, `hooks:install`.
- Modify `docs/ANDROID_TESTING.md` — a "The gate" section.

Nothing in `scripts/__tests__/test_gate.py` is discovered by the gate's own scans stage: that stage discovers only `test_check_*.py`, so the gate never runs its own test inside itself.

---

### Task 1: The gate script, driven by its test

**Files:**
- Create: `scripts/__tests__/test_gate.py`
- Create: `scripts/gate.sh`

- [ ] **Step 1: Write the failing tests**

```python
"""
The gate must be able to fail, and must be able to skip.

`gate.sh` is what stands between a broken change and origin. Three things are pinned here, each
by driving the script from outside rather than by reading it:

 - a stage that fails stops the run, exit 1, with the stage named and nothing run after it;
 - a real stage passes on its own (the scans, the fastest real one);
 - no phone on adb is a SKIP with a message, exit 0 — the phone's absence is a fact about the
   desk, not about the code.

`GATE_STAGES` narrows the run and `GATE_FAKE_FAIL` substitutes a failing command for one stage;
`ADB` points the device stage at a stub. These are the script's documented overrides, not
test-only branches.
"""
import os
import pathlib
import stat
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts" / "gate.sh"


def run_gate(**env):
    merged = dict(os.environ)
    merged.update(env)
    return subprocess.run(
        [str(GATE)], cwd=ROOT, env=merged, capture_output=True, text=True, timeout=600,
    )


class GateTest(unittest.TestCase):
    def test_a_failing_stage_stops_the_run_and_is_named(self):
        r = run_gate(GATE_STAGES="scans types", GATE_FAKE_FAIL="scans")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("scans", r.stdout)
        self.assertIn("FAILED", r.stdout)
        after = r.stdout.split("FAILED", 1)[1]
        self.assertNotIn("types", after, "a stage ran after the failure")

    def test_a_real_stage_passes_on_its_own(self):
        r = run_gate(GATE_STAGES="scans")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("scans", r.stdout)
        self.assertNotIn("FAILED", r.stdout)

    def test_no_phone_is_a_skip_not_a_failure(self):
        with tempfile.TemporaryDirectory() as d:
            stub = pathlib.Path(d) / "adb"
            stub.write_text('#!/bin/sh\necho "List of devices attached"\necho\n')
            stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
            r = run_gate(GATE_STAGES="device", ADB=str(stub))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("skipped", r.stdout)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest discover -s scripts/__tests__ -p 'test_gate.py' -v`
Expected: 3 errors, each `FileNotFoundError` for `scripts/gate.sh`.

- [ ] **Step 3: Write the gate**

```bash
#!/bin/bash
# The gate: every check this project has, in order, stopping at the first failure.
# Run by hand (`npm run gate`) and by git before every push (scripts/hooks/pre-push).
# Design: docs/superpowers/specs/2026-09-15-local-gate-design.md
#
# Overrides, all optional:
#   GATE_STAGES="types js"     run only these stages, in this order
#   GATE_FAKE_FAIL=<stage>     make that stage fail without running it (the gate's own test)
#   ADB=/path/to/adb           where adb is; discovered from the SDK otherwise
#   CMAKE=/path/to/cmake       where cmake is; the Android SDK's copy otherwise
set -u
cd "$(dirname "$0")/.." || exit 2

STAGES="${GATE_STAGES:-types js scans mutations kotlin cpp device}"
FAKE_FAIL="${GATE_FAKE_FAIL:-}"
CMAKE="${CMAKE:-$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake}"
NINJA="$(dirname "$CMAKE")/ninja"
CTEST="$(dirname "$CMAKE")/ctest"

# adb is not on PATH in a plain shell on this machine; the SDK location is. Same search as
# scripts/device-verify.sh, so the two never disagree about which adb they mean.
ADB="${ADB:-$(command -v adb || true)}"
if [ -z "$ADB" ]; then
  for candidate in "${ANDROID_HOME:-}/platform-tools/adb" "$HOME/Library/Android/sdk/platform-tools/adb"; do
    [ -x "$candidate" ] && ADB="$candidate" && break
  done
fi

# ---- stages ---------------------------------------------------------------------------------

stage_types() { npx tsc --noEmit; }

stage_js() { npx jest --silent; }

stage_scans() {
  python3 scripts/check-network-egress.py &&
  python3 scripts/check-prompt-fencing.py &&
  python3 -m unittest discover -s scripts/__tests__ -p 'test_check_*.py' -q &&
  python3 scripts/check-diar-constants.py &&
  python3 scripts/check-engine-encapsulation.py &&
  python3 scripts/check-live-transcript.py
}

stage_mutations() { python3 scripts/mutate-reconciler.py; }

stage_kotlin() { (cd android && ./gradlew :app:testDebugUnitTest -q); }

stage_cpp() {
  if [ ! -f cpp/cli/build/build.ninja ]; then
    "$CMAKE" -S cpp/cli -B cpp/cli/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_MAKE_PROGRAM="$NINJA" || return 1
  fi
  "$CMAKE" --build cpp/cli/build -j 8 && (cd cpp/cli/build && "$CTEST" --output-on-failure)
}

# The phone is included when it is there and never required. Exactly one authorised device runs
# the suite; anything else is reported and passed — a missing phone is a fact about the desk.
stage_device() {
  if [ -z "$ADB" ] || [ ! -x "$ADB" ]; then
    echo "    no adb — device tests skipped"; return 0
  fi
  local listing authorised unauthorised
  listing=$("$ADB" devices 2>/dev/null | tail -n +2 | awk 'NF')
  authorised=$(printf '%s\n' "$listing" | awk '$2=="device"' | wc -l | tr -d ' ')
  unauthorised=$(printf '%s\n' "$listing" | awk '$2=="unauthorized"' | wc -l | tr -d ' ')
  if [ "$authorised" = "1" ]; then
    npm run -s test:device
  elif [ "$unauthorised" != "0" ]; then
    echo "    phone attached but not authorised — accept the USB debugging prompt; device tests skipped"
  elif [ "$authorised" = "0" ]; then
    echo "    no phone — device tests skipped"
  else
    echo "    $authorised phones attached — device tests skipped (attach one)"
  fi
  return 0
}

# ---- runner ---------------------------------------------------------------------------------

run_stage() {
  local name=$1 start rc elapsed
  start=$(date +%s)
  echo "==> $name"
  if [ "$FAKE_FAIL" = "$name" ]; then
    echo "    (GATE_FAKE_FAIL: failing this stage on purpose)"
    rc=1
  else
    "stage_$name"
    rc=$?
  fi
  elapsed=$(( $(date +%s) - start ))
  if [ $rc -eq 0 ]; then
    echo "    ok  $name (${elapsed}s)"
  else
    echo "    FAILED  $name (${elapsed}s)"
  fi
  return $rc
}

overall_start=$(date +%s)
for stage in $STAGES; do
  if ! declare -f "stage_$stage" >/dev/null; then
    echo "unknown stage: $stage (known: types js scans mutations kotlin cpp device)"; exit 2
  fi
  if ! run_stage "$stage"; then
    echo
    echo "gate: $stage failed after $(( $(date +%s) - overall_start ))s — push refused. (git push --no-verify skips the gate.)"
    exit 1
  fi
done
echo
echo "gate: all clear in $(( $(date +%s) - overall_start ))s"
exit 0
```

Then make it executable:

Run: `chmod +x scripts/gate.sh`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s scripts/__tests__ -p 'test_gate.py' -v`
Expected: `Ran 3 tests ... OK`. The failing-stage test finishes in under a second (nothing real runs); the scans test in ~10 s; the device test in under a second.

- [ ] **Step 5: Commit**

```bash
git add scripts/gate.sh scripts/__tests__/test_gate.py
git commit -m "feat(gate): one script for every check, and a test that watches it fail"
```

---

### Task 2: The hook and the npm entry points

**Files:**
- Create: `scripts/hooks/pre-push`
- Modify: `package.json` (the `scripts` block)

- [ ] **Step 1: Write the hook**

```sh
#!/bin/sh
# Runs the gate before anything leaves this machine. Installed by `npm run hooks:install`
# (git config core.hooksPath scripts/hooks). `git push --no-verify` bypasses it on purpose.
exec "$(git rev-parse --show-toplevel)/scripts/gate.sh"
```

Run: `chmod +x scripts/hooks/pre-push`

- [ ] **Step 2: Add the npm scripts**

In `package.json`, inside `"scripts"`, after the `"test:device"` line, add:

```json
    "gate": "scripts/gate.sh",
    "gate:test": "python3 -m unittest discover -s scripts/__tests__ -p 'test_gate.py' -v",
    "hooks:install": "git config core.hooksPath scripts/hooks && echo 'pre-push hook installed (scripts/hooks). git push --no-verify bypasses it.'",
```

- [ ] **Step 3: Install and verify the hook is wired**

Run: `npm run hooks:install && git config core.hooksPath && ls -l scripts/hooks/pre-push`
Expected: `scripts/hooks`, and the file listed with `x` permission.

- [ ] **Step 4: Prove the hook refuses a failing push without touching origin**

Run: `GATE_STAGES=scans GATE_FAKE_FAIL=scans git push --dry-run origin main; echo "exit=$?"`
Expected: the gate output ending `gate: scans failed ... push refused`, and `exit=1`. (The hook inherits the environment, so the overrides reach it; `--dry-run` would not have sent anything anyway.)

- [ ] **Step 5: Commit**

```bash
git add scripts/hooks/pre-push package.json
git commit -m "feat(gate): pre-push hook, and npm run gate / gate:test / hooks:install"
```

---

### Task 3: Write it down

**Files:**
- Modify: `docs/ANDROID_TESTING.md` — insert after the "Verifying the native core" section (after the paragraph that ends "...so pushed files show up as installed.")

- [ ] **Step 1: Add the section**

```markdown
---

## The gate — every check, before every push

```bash
npm run hooks:install   # once per clone: points git at scripts/hooks
npm run gate            # the same thing, by hand
npm run gate:test       # the gate's own test: it can fail, and it can skip
```

`scripts/gate.sh` runs, in order and stopping at the first failure: TypeScript, jest, the scans
(`check:egress`, `check:fence` and their tests, diarization constants, engine encapsulation, the
live-transcript invariant), the 31 reconciler mutations, the Kotlin unit tests, the C++ build and
ctest, and — **only if exactly one authorised phone is on adb** — `npm run test:device`. No phone
is a skip with a message, never a failure. About three minutes without a phone, eleven with.

`git push --no-verify` bypasses it. That is deliberate; use it when you know why.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ANDROID_TESTING.md
git commit -m "docs: the gate, in the testing guide"
```

---

### Task 4: Run it for real, then let the hook run it again

**Files:** none — this is verification.

- [ ] **Step 1: Full run by hand, phone attached**

Run: `npm run gate 2>&1 | tail -30`
Expected: seven `ok` lines and `gate: all clear in Ns`. Note each stage's time; the device stage should report 72 tests across 10 classes with zero skips (device-verify prints its own summary).

- [ ] **Step 2: Push, and let the hook be the gate**

Run: `git push origin main`
Expected: the gate runs again (the hook), ends `all clear`, then the push proceeds. If the phone was unplugged between steps, the device stage says so and passes.

- [ ] **Step 3: Record the timings in the spec**

Append to `docs/superpowers/specs/2026-09-15-local-gate-design.md`:

```markdown
## Measured, 15 September

<stage>: <s> — fill each of the seven from Step 1's output, and the total with and without the
phone.
```

(Replace the placeholder line with the actual numbers before committing — this step exists to
make sure the numbers in the spec are measured, not the estimates in the table above.)

```bash
git add docs/superpowers/specs/2026-09-15-local-gate-design.md
git commit -m "docs(gate): measured timings"
git push origin main
```
