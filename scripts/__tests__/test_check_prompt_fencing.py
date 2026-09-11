"""The fence guard, checked against a planted violation and against the code it must not cry wolf on.

A guard nobody has seen fail is a guard nobody knows works — the same argument as
test_check_network_egress.py, which this is modelled on: subprocess runs over a temp tree for the
exit codes and the message, plus direct calls into `violations()` for the line-level decisions.

The hard part of this particular check is not catching a violation. It is NOT catching
`who + ": " + u.text`, which builds a transcript line and is not a prompt at all. A guard that
trips on legitimate code earns an allowlist entry, and an allowlist entry covers everything in the
file that follows — including the next real violation. So the accept cases below are as load-bearing
as the reject cases, and each pair sits on either side of one decision the checker makes.

    python3 -m unittest discover -s scripts/__tests__ -p 'test_check_prompt_fencing.py' -v
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHECK = os.path.join(ROOT, "scripts", "check-prompt-fencing.py")

# The script's filename has dashes, so it is not importable by name. Load it by path rather than
# renaming a file that the package.json script and every other scripts/check-*.py agree about.
_spec = importlib.util.spec_from_file_location("check_prompt_fencing", CHECK)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
violations = _mod.violations


def run_against(tree):
    return subprocess.run(
        [sys.executable, CHECK, "--root", tree], capture_output=True, text=True
    )


class TestPromptFencing(unittest.TestCase):
    # --- what a fenced prompt looks like, and what an unfenced one looks like ---

    def test_accepts_a_fenced_prompt(self):
        # Deliberately a case the checker could plausibly reject: the literal IS instruction text
        # and the expression it is concatenated with contains the word "Transcript". Only the
        # fenceTranscript call makes this legal, so the test fails if that exemption is dropped.
        source = '  return "TRANSCRIPT:\\n" + fenceTranscript(chunk) + "\\n";\n'
        self.assertEqual(violations("cpp/minutes/x.cpp", source), [])

    def test_rejects_transcript_text_concatenated_into_a_prompt(self):
        source = '  std::string prompt = "Summarise this meeting:\\n" + utterance.text;\n'
        found = violations("cpp/minutes/x.cpp", source)
        self.assertEqual(len(found), 1)
        self.assertIn("utterance.text", found[0])

    def test_rejects_transcript_text_placed_before_the_instruction(self):
        # The listing only caught literal-first. An instruction after the data is the shape every
        # one of these prompts already uses, so it is the likelier way to write the violation.
        source = '  std::string prompt = chunk + "\\n\\nNow list the decisions.";\n'
        found = violations("cpp/minutes/x.cpp", source)
        self.assertEqual(len(found), 1)
        self.assertIn("chunk", found[0])

    # --- assembly is not prompt-building: the two sides of the instruction-text decision ---

    def test_a_transcript_line_being_assembled_is_not_a_prompt(self):
        # cpp/minutes/llm_prompts.cpp builds the transcript itself, one line per utterance. The
        # literal is punctuation glue, not an instruction, and there is no model anywhere near it.
        source = '    out.push_back(who + ": " + u.text);\n'
        self.assertEqual(violations("cpp/minutes/llm_prompts.cpp", source), [])

    def test_a_one_word_label_is_still_an_instruction(self):
        # The other side of the same decision. "Q:\n" carries no three-letter word, so it is caught
        # by the newline arm rather than the word arm — without which a terse label would be a hole.
        source = '  std::string prompt = "Q:\\n" + chunk;\n'
        self.assertEqual(len(violations("cpp/minutes/x.cpp", source)), 1)

    def test_joining_a_newline_onto_a_chunk_is_not_a_prompt(self):
        source = '    joined += "\\n\\n" + chunk;\n'
        self.assertEqual(violations("cpp/minutes/x.cpp", source), [])

    # --- a comment is not code ---

    def test_a_mention_in_a_comment_is_not_a_prompt(self):
        # fence.h's own header quotes the violation it exists to prevent. Tripping on that would
        # make the rule undocumentable next to the code it constrains.
        source = '  // never write "Summarise this:\\n" + chunk — that is the whole point\n'
        self.assertEqual(violations("cpp/minutes/fence.h", source), [])

    # --- a violation split over two lines is still a violation ---

    def test_a_violation_wrapped_across_lines_is_caught(self):
        source = '  std::string prompt = "Summarise this meeting:\\n" +\n                       chunk;\n'
        self.assertEqual(len(violations("cpp/minutes/x.cpp", source)), 1)

    # --- the checker as a build gate ---

    def test_a_clean_tree_passes(self):
        tree = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tree)
        path = os.path.join(tree, "cpp", "minutes")
        os.makedirs(path)
        with open(os.path.join(path, "fine.cpp"), "w") as f:
            f.write('std::string p = "TRANSCRIPT:\\n" + fenceTranscript(chunk);\n')
        self.assertEqual(0, run_against(tree).returncode)

    def test_a_planted_prompt_fails_the_build(self):
        tree = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tree)
        path = os.path.join(tree, "cpp", "minutes")
        os.makedirs(path)
        with open(os.path.join(path, "sneaky.cpp"), "w") as f:
            f.write('std::string p = "Summarise:\\n" + utterance_text;\n')
        result = run_against(tree)
        self.assertEqual(1, result.returncode)
        self.assertIn("sneaky.cpp", result.stderr)
        self.assertIn("utterance_text", result.stderr)
        self.assertIn("fenceTranscript", result.stderr)

    def test_the_real_repository_passes(self):
        # The check is worthless if it does not hold on the tree it ships with — and this is the
        # assertion that was RED when the fence was written, because llm_prompts.cpp was building
        # three prompts out of raw transcript at the time.
        result = run_against(ROOT)
        self.assertEqual(0, result.returncode, result.stderr)


if __name__ == "__main__":
    unittest.main()
