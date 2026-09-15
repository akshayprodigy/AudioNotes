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
