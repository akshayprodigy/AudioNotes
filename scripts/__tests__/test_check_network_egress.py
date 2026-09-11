"""The check has to catch a violation, not merely run and exit zero.

A guard nobody has seen fail is a guard nobody knows works. The engine-encapsulation check exists
because Qwen3-ASR shipped compiled-in and unreachable with every test green; this one exists so
the privacy screen cannot quietly start under-reporting, and it deserves the same proof.

    python3 -m unittest discover -s scripts/__tests__ -v
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHECK = os.path.join(ROOT, "scripts", "check-network-egress.py")


def run_against(tree):
    return subprocess.run(
        [sys.executable, CHECK, "--root", tree], capture_output=True, text=True
    )


class TestNetworkEgressCheck(unittest.TestCase):
    def setUp(self):
        self.tree = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tree)

    def write(self, rel, text):
        path = os.path.join(self.tree, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def test_clean_tree_passes(self):
        self.write(os.path.join("src", "screens", "Fine.tsx"), "export const x = 1;\n")
        self.assertEqual(0, run_against(self.tree).returncode)

    def test_a_new_fetch_fails_the_build(self):
        self.write(
            os.path.join("src", "screens", "Sneaky.tsx"),
            "await fetch('https://analytics.example.com/ping');\n",
        )
        result = run_against(self.tree)
        self.assertEqual(1, result.returncode)
        self.assertIn("Sneaky.tsx", result.stderr)

    def test_a_new_kotlin_connection_fails_the_build(self):
        self.write(
            os.path.join("android", "app", "src", "main", "java", "Ping.kt"),
            "val c = URL(u).openConnection() as HttpURLConnection\n",
        )
        result = run_against(self.tree)
        self.assertEqual(1, result.returncode)
        self.assertIn("Ping.kt", result.stderr)

    def test_the_registered_call_sites_are_allowed(self):
        self.write(
            os.path.join("src", "billing", "subscription.ts"),
            "const res = await fetch(url, { method: 'POST' });\n",
        )
        self.assertEqual(0, run_against(self.tree).returncode)

    def test_a_mention_in_a_comment_is_not_a_call(self):
        # Otherwise every doc comment explaining the rule would trip it.
        self.write(
            os.path.join("src", "screens", "Doc.tsx"),
            "// nothing here calls fetch( on purpose\n",
        )
        self.assertEqual(0, run_against(self.tree).returncode)

    def test_a_tree_with_nothing_to_scan_is_not_a_pass(self):
        # Same defect, found while writing check-prompt-fencing.py against this file: no sources
        # under SEARCH_ROOTS meant "no violations" meant exit 0, so renaming src/ would have turned
        # the privacy gate into a green tick while the screen kept claiming it counts every byte.
        self.write(os.path.join("app", "screens", "Sneaky.tsx"), "await fetch('https://x/');\n")
        result = run_against(self.tree)
        self.assertEqual(1, result.returncode, "a run that scanned nothing reported success")
        self.assertIn("SEARCH_ROOTS", result.stderr)

    def test_the_real_repository_passes(self):
        # The check is worthless if it does not hold on the tree it ships with.
        result = run_against(ROOT)
        self.assertEqual(0, result.returncode, result.stderr)


if __name__ == "__main__":
    unittest.main()
