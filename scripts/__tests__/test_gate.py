"""
The gate must be able to fail, and must be able to skip.

`gate.sh` is what stands between a broken change and origin. Three things are pinned here, each
by driving the script from outside rather than by reading it:

 - a stage that fails stops the run, exit 1, with the stage named and nothing run after it;
 - a real stage passes on its own (the scans, the fastest real one);
 - no phone on adb is a SKIP with a message, exit 0 — the phone's absence is a fact about the
   desk, not about the code;
 - with several devices attached, ANDROID_SERIAL names the one to run on — two emulators next
   to the Pixel used to turn every push into "3 phones attached — skipped";
 - a device suite that FAILS fails the gate. The stage used to `return 0` under the suite,
   and printed "FAILED — full output in /tmp/instr.out" followed by "ok device" and "all clear".

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

    def test_android_serial_picks_the_phone_out_of_a_crowd(self):
        with tempfile.TemporaryDirectory() as d:
            stub = pathlib.Path(d) / "adb"
            # `devices` answers with the crowd; anything else fails fast, so the suite the stage
            # goes on to start stops at its first adb call instead of hanging.
            stub.write_text(
                "#!/bin/sh\n"
                'if [ "$1" = "devices" ]; then\n'
                '  printf "List of devices attached\\n36091FDH30034G\\tdevice\\n'
                'emulator-5554\\tdevice\\nemulator-5560\\tdevice\\n"\n'
                "  exit 0\n"
                "fi\n"
                "exit 1\n"
            )
            stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
            r = run_gate(GATE_STAGES="device", ADB=str(stub), ANDROID_SERIAL="36091FDH30034G")
        self.assertIn("36091FDH30034G", r.stdout, r.stdout + r.stderr)
        self.assertNotIn("skipped", r.stdout)

    def test_a_failing_device_suite_fails_the_gate(self):
        with tempfile.TemporaryDirectory() as d:
            stub = pathlib.Path(d) / "adb"
            # One authorised phone, so the stage runs the suite; every other adb call fails, so
            # the suite fails at its first step. The gate must say so and exit 1.
            stub.write_text(
                "#!/bin/sh\n"
                'if [ "$1" = "devices" ]; then\n'
                '  printf "List of devices attached\\nPHONE1\\tdevice\\n"\n'
                "  exit 0\n"
                "fi\n"
                "exit 1\n"
            )
            stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
            r = run_gate(GATE_STAGES="device", ADB=str(stub))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("FAILED  device", r.stdout)

if __name__ == "__main__":
    unittest.main()
