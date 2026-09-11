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
        #
        # Asserted under a NEUTRAL path as well, because on its own the real path cannot tell
        # "the checker judged this line" from "the checker skipped this file".
        source = '    out.push_back(who + ": " + u.text);\n'
        self.assertEqual(violations("cpp/minutes/llm_prompts.cpp", source), [])
        self.assertEqual(violations("cpp/minutes/x.cpp", source), [])

    def test_no_file_is_exempt(self):
        """The invariant the whole design rests on, and the one nothing could see.

        There is no allowlist, and three comments say so — which is worth nothing while a path
        exemption for llm_prompts.cpp, the one file where the risk actually lives, could be added
        with every test still green. check-network-egress.py pins its allowlist; this pins the
        absence of one.
        """
        source = '  std::string prompt = "Summarise this meeting:\\n" + utterance.text;\n'
        here = violations("cpp/minutes/llm_prompts.cpp", source)
        elsewhere = violations("cpp/minutes/x.cpp", source)
        self.assertNotEqual([], here, "the file that feeds a model is exempt")
        self.assertEqual(here, elsewhere, "the verdict depends on the path, so some file is exempt")

    def test_a_one_word_label_is_still_an_instruction(self):
        # The other side of the same decision. "Q:\n" carries no three-letter word, so it is caught
        # by the newline arm rather than the word arm — without which a terse label would be a hole.
        source = '  std::string prompt = "Q:\\n" + chunk;\n'
        self.assertEqual(len(violations("cpp/minutes/x.cpp", source)), 1)

    def test_the_narrative_prompts_own_parameter_name_is_covered(self):
        # narrativePrompt receives raw dialogue on the single-chunk path — the hidden surface this
        # whole check exists for — and its parameter is `record`. With that word missing from the
        # list, the guard could watch it be un-fenced and say nothing.
        source = '  return "RECORD:\\n" + record + "\\n";\n'
        self.assertEqual(len(violations("cpp/minutes/x.cpp", source)), 1)

    def test_a_trailing_underscore_member_is_still_transcript(self):
        # This repo names members cfg_, active_, arena_. The boundary that stops `chunks_failed`
        # must not also stop `chunk_`.
        for src in ('  std::string p = "Below is:\\n" + chunk_;\n',
                    '  std::string p = "Below is:\\n" + this->transcript_;\n'):
            with self.subTest(src=src):
                self.assertEqual(len(violations("cpp/minutes/x.cpp", src)), 1)

    def test_an_identifier_that_merely_begins_with_a_transcript_word_is_not_transcript(self):
        # The other side of the trailing-underscore boundary. Named for what it pins: the
        # IDENTIFIER rule, not the count shape — `chunks_failed` is rejected because the name ends
        # in `failed`, and it would still be rejected outside any std::to_string.
        source = '  logLine("asr: every chunk failed (" + asr_run.chunks_failed);\n'
        self.assertEqual(violations("cpp/pipeline/x.cpp", source), [])

    def test_a_count_of_transcript_things_is_a_number_not_a_transcript(self):
        """std::to_string is exempt by SIGNATURE, not by path — the count shape the guard meets.

        Every overload takes an arithmetic type, so the result is the decimal form of a number and
        can never be speech. `std::to_string(chunks.size())` would otherwise be flagged from both
        directions at once: the wrapper rule reaches into it after a literal, and the closing-paren
        rule reaches out of it before one.
        """
        for src in ('  fail("asr: every chunk failed (" + std::to_string(run.chunks) + ")");\n',
                    '  fail("asr: failed (" + std::to_string(chunks.size()) + ")");\n',
                    '  log("turns: " + std::to_string(turns));\n',
                    '  log("sentences: " + std::to_string(sentences.size()));\n',
                    '  log("records: " + std::to_string(db.records));\n'):
            with self.subTest(src=src):
                self.assertEqual(violations("cpp/pipeline/x.cpp", src), [])

    def test_a_transcript_beside_a_count_is_still_caught(self):
        # The accept above must not become a way in: blanking the count leaves everything else.
        source = '  std::string p = "seen " + std::to_string(n) + " lines:\\n" + chunk;\n'
        self.assertEqual(len(violations("cpp/minutes/x.cpp", source)), 1)

    def test_a_std_string_wrapper_does_not_hide_the_violation(self):
        # The idiom the plan's own fence.cpp listing is written in.
        for src in ('  std::string p = std::string("Below is:\\n") + chunk;\n',
                    '  std::string p = "Below is:\\n" + std::string(chunk);\n',
                    '  std::string p = "Below is:\\n" + (chunk);\n'):
            with self.subTest(src=src):
                self.assertEqual(len(violations("cpp/minutes/x.cpp", src)), 1)

    def test_a_fenced_prompt_inside_a_wrapper_is_still_fenced(self):
        # The accept side of the same widening — it must not start crying wolf on the real code.
        source = '  std::string p = "TRANSCRIPT:\\n" + std::string(fenceTranscript(chunk));\n'
        self.assertEqual(violations("cpp/minutes/x.cpp", source), [])

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

    def test_every_search_root_is_checked(self):
        """Narrowing SEARCH_ROOTS back to the listing's three left all eleven tests green.

        cpp/jni, cpp/capi and cpp/cli are scope beyond the listing and were argued for in the
        docstring; an argument in a comment is not a gate. One planted violation per root.

        The roots are RESTATED here rather than read from the module. Written as
        `for root in _mod.SEARCH_ROOTS` this test passed happily against a checker narrowed to
        `("cpp/minutes",)` — it simply iterated less. A fixture that asks the implementation what
        the answer should be cannot fail when the implementation is wrong.
        """
        for root in ("cpp/minutes", "cpp/llm", "cpp/pipeline", "cpp/jni", "cpp/capi", "cpp/cli"):
            with self.subTest(root=root):
                tree = tempfile.mkdtemp()
                self.addCleanup(shutil.rmtree, tree)
                path = os.path.join(tree, *root.split("/"))
                os.makedirs(path)
                with open(os.path.join(path, "planted.cpp"), "w") as f:
                    f.write('std::string p = "Summarise:\\n" + utterance_text;\n')
                result = run_against(tree)
                self.assertEqual(1, result.returncode, f"{root} is not searched")
                self.assertIn("planted.cpp", result.stderr)

    def test_a_tree_with_nothing_to_scan_is_not_a_pass(self):
        """A guard that examined no files must not print OK.

        Every root is a hard-coded path. Copy cpp/minutes to cpp/prompts and the checker reports
        success over a tree holding a real violation — a directory rename disables it with no
        signal at all, which is worse than not having it, because somebody is relying on it.
        """
        tree = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tree)
        os.makedirs(os.path.join(tree, "cpp", "prompts"))
        with open(os.path.join(tree, "cpp", "prompts", "moved.cpp"), "w") as f:
            f.write('std::string p = "Summarise:\\n" + utterance_text;\n')
        result = run_against(tree)
        self.assertEqual(1, result.returncode, "a run that scanned nothing reported success")
        self.assertIn("SEARCH_ROOTS", result.stderr)

    def test_the_real_repository_passes(self):
        # The check is worthless if it does not hold on the tree it ships with — and this is the
        # assertion that was RED when the fence was written, because llm_prompts.cpp was building
        # three prompts out of raw transcript at the time.
        result = run_against(ROOT)
        self.assertEqual(0, result.returncode, result.stderr)


if __name__ == "__main__":
    unittest.main()
