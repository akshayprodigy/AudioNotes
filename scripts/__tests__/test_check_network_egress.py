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


# Restated here rather than imported: a fixture that asks the implementation what the answer
# should be cannot fail when the implementation is wrong.
ROOTS = ("src", os.path.join("android", "app", "src", "main"))


def run_against(tree):
    return subprocess.run(
        [sys.executable, CHECK, "--root", tree], capture_output=True, text=True
    )


class TestNetworkEgressCheck(unittest.TestCase):
    def setUp(self):
        self.tree = self.a_tree()

    def a_tree(self, roots=ROOTS):
        """A temp tree with the given roots present — by default BOTH of them.

        A tempdir holding only src/ is a tree in which android/app/src/main has been deleted, so
        anything asserted against it also asserts the behaviour of a repository somebody has taken
        an axe to. The checker now refuses such a tree, and rightly.
        """
        tree = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tree)
        for r in roots:
            os.makedirs(os.path.join(tree, r), exist_ok=True)
        return tree

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

    def test_one_renamed_root_with_its_sibling_intact_is_not_a_pass(self):
        """Rename src/ and android/app/src/main still scans, so a total count never fires.

        The privacy screen claims to count every byte that leaves this phone. This is the shape
        that would let it go on claiming that over a tree where the entire JavaScript side is
        invisible — and 47 files still get scanned, so nothing looks wrong.
        """
        tree = self.a_tree([os.path.join("android", "app", "src", "main")])
        path = os.path.join(tree, "renamed_src")
        os.makedirs(path)
        with open(os.path.join(path, "leak.ts"), "w") as f:
            f.write("await fetch('https://analytics.example.com/ping');\n")
        result = run_against(tree)
        self.assertEqual(1, result.returncode, "a renamed root was skipped in silence")
        self.assertIn("src", result.stderr)

    def test_a_tree_with_neither_root_is_not_a_pass(self):
        tree = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tree)
        os.makedirs(os.path.join(tree, "app"))
        result = run_against(tree)
        self.assertEqual(1, result.returncode)
        self.assertIn("SEARCH_ROOTS", result.stderr)

    def test_roots_that_exist_but_hold_no_sources_are_not_a_pass(self):
        # Both roots present, every source moved out from under them.
        result = run_against(self.a_tree())
        self.assertEqual(1, result.returncode, "a run that opened no file reported success")
        self.assertIn("examined nothing", result.stderr)

    def test_the_real_repository_passes(self):
        # The check is worthless if it does not hold on the tree it ships with.
        result = run_against(ROOT)
        self.assertEqual(0, result.returncode, result.stderr)


if __name__ == "__main__":
    unittest.main()
