"""The judge runner: prompt shape, verdict parsing, and the batching that makes it affordable.

No model is loaded here. What is tested is everything around the model, because that is where a
wrong answer would be silent — a verdict parser that defaults to YES on unparseable output would
quietly report perfect recall.
"""
import unittest

from eval.metrics.judge import (BatchedJudge, capture_prompt, parse_verdict, render_minutes,
                                support_prompt)

PRODUCED = {
    "decisions": ["We decided on 25 Euro."],
    "actions": [{"text": "I'll do the casing.", "owner": "Ana", "due": "Friday"}],
    "questions": [],
}


class VerdictTest(unittest.TestCase):
    def test_yes_with_evidence(self):
        v = parse_verdict("VERDICT: YES\nEVIDENCE: We decided on 25 Euro.")
        self.assertTrue(v.matched)
        self.assertEqual(v.evidence, "We decided on 25 Euro.")

    def test_no(self):
        self.assertFalse(parse_verdict("VERDICT: NO\nEVIDENCE: NONE").matched)

    def test_evidence_none_is_empty(self):
        self.assertEqual(parse_verdict("VERDICT: YES\nEVIDENCE: NONE").evidence, "")

    def test_chatter_around_the_answer_is_tolerated(self):
        v = parse_verdict("Sure! Here is my assessment.\n\nVERDICT: YES\nEVIDENCE: line one\nHope that helps")
        self.assertTrue(v.matched)
        self.assertEqual(v.evidence, "line one")

    def test_unparseable_is_NO_and_says_so(self):
        """The dangerous default is YES: a judge whose output drifts would report perfect recall
        and nobody would look again."""
        v = parse_verdict("I'm not sure what you're asking.")
        self.assertFalse(v.matched)
        self.assertIn("unparseable", v.note)

    def test_lowercase_and_punctuation(self):
        self.assertTrue(parse_verdict("verdict: yes.\nevidence: x").matched)


class PromptTest(unittest.TestCase):
    def test_capture_prompt_carries_item_and_minutes(self):
        p = capture_prompt("The remote will sell for 25 Euro.", "decisions", PRODUCED)
        self.assertIn("The remote will sell for 25 Euro.", p)
        self.assertIn("We decided on 25 Euro.", p)
        self.assertIn("VERDICT:", p)

    def test_support_prompt_carries_transcript(self):
        p = support_prompt("We decided on 25 Euro.", "decisions", "we said twenty five euro")
        self.assertIn("we said twenty five euro", p)

    def test_rendered_minutes_are_labelled_by_category(self):
        r = render_minutes(PRODUCED)
        self.assertIn("DECISIONS", r.upper())
        self.assertIn("I'll do the casing.", r)

    def test_empty_minutes_say_so_rather_than_render_blank(self):
        # A blank section invites the judge to hallucinate agreement with nothing.
        self.assertIn("none", render_minutes(
            {"decisions": [], "actions": [], "questions": []}).lower())


class BatchingTest(unittest.TestCase):
    def test_one_model_run_for_the_whole_meeting(self):
        calls = []

        def fake_run(prompts):
            calls.append(len(prompts))
            return ["VERDICT: YES\nEVIDENCE: We decided on 25 Euro."] * len(prompts)

        reference = {"decisions": ["a", "b"], "actions": [], "questions": ["c"]}
        doc = {"minutes": [{"kind": "decision", "content": "We decided on 25 Euro."}]}
        judge = BatchedJudge(fake_run)
        result = judge.score(reference, doc, transcript="")
        self.assertEqual(calls, [3])          # 3 reference items, ONE batch
        self.assertEqual(result["recall"]["overall"], 1.0)

    def test_answers_line_up_with_their_questions(self):
        """Off-by-one here would silently attribute one item's verdict to another."""
        def fake_run(prompts):
            return ["VERDICT: YES\nEVIDENCE: e" if "keep" in p else "VERDICT: NO\nEVIDENCE: NONE"
                    for p in prompts]

        reference = {"decisions": ["drop", "keep"], "actions": [], "questions": []}
        doc = {"minutes": []}
        r = BatchedJudge(fake_run).score(reference, doc, transcript="")
        by_item = {v["item"]: v["matched"] for v in r["verdicts"]}
        self.assertEqual(by_item, {"drop": False, "keep": True})

    def test_extractive_items_are_confirmed_without_asking_the_model(self):
        """Our minutes quote the transcript verbatim. Asking a 7B model whether a sentence it can
        see appears in text it can see is a waste of an inference AND a chance to be wrong."""
        asked = []

        def fake_run(prompts):
            asked.extend(prompts)
            return ["VERDICT: NO\nEVIDENCE: NONE"] * len(prompts)

        doc = {"minutes": [{"kind": "decision", "content": "we ship on friday"}]}
        r = BatchedJudge(fake_run).score({"decisions": [], "actions": [], "questions": []},
                                         doc, transcript="so we ship on Friday, agreed")
        self.assertEqual(r["precision"]["decisions"], 1.0)
        self.assertEqual(asked, [])


if __name__ == "__main__":
    unittest.main()


class BareVerdictTest(unittest.TestCase):
    """Smoke-tested against Qwen2.5-7B: with the real prompts it emits `VERDICT: YES`, but on a
    terser prompt it answered with a bare `YES`. A different judge model may do the same, and
    silently scoring that as NO would understate recall for a reason nobody would find."""

    def test_bare_yes_on_its_own_line(self):
        self.assertTrue(parse_verdict("YES\nEVIDENCE: the line").matched)
        self.assertEqual(parse_verdict("YES\nEVIDENCE: the line").evidence, "the line")

    def test_bare_no(self):
        self.assertFalse(parse_verdict("NO\nEVIDENCE: NONE").matched)

    def test_prose_containing_the_word_yes_is_still_unparseable(self):
        # "Yes, if you squint" is not a verdict, and guessing at it is how a judge starts
        # inventing agreement.
        v = parse_verdict("Yes, this one is arguably captured if you read it generously.")
        self.assertFalse(v.matched)
        self.assertIn("unparseable", v.note)


class BatchedSupportTest(unittest.TestCase):
    """Support checks must not re-send the transcript once per claim.

    Measured: one claim against a 35k-char transcript costs ~9k tokens of prefill and ~40s. At 42
    produced items per fixture that is an hour of GPU for a question the model could answer for
    all of them from a single reading. The first run appeared fast only because a conservative
    transcript cap made three fixtures skip the check entirely.
    """

    def test_one_prompt_carries_every_claim(self):
        from eval.metrics.judge import support_batch_prompt
        # A distinctive sentinel: the words "the transcript" also appear in the instructions.
        p = support_batch_prompt(["claim one", "claim two"], "decisions", "ZZTRANSCRIPTBODYZZ")
        self.assertEqual(p.count("ZZTRANSCRIPTBODYZZ"), 1)
        self.assertIn("1.", p)
        self.assertIn("2.", p)
        self.assertIn("claim two", p)

    def test_verdicts_parse_per_line(self):
        from eval.metrics.judge import parse_batch_verdicts
        vs = parse_batch_verdicts("1: YES\n2: NO\n3: YES", 3)
        self.assertEqual([v.matched for v in vs], [True, False, True])

    def test_a_missing_line_is_NO_not_a_shifted_answer(self):
        """Padding with NO keeps every claim aligned with its own verdict. Returning a short list
        would slide claim 3's answer onto claim 2."""
        from eval.metrics.judge import parse_batch_verdicts
        vs = parse_batch_verdicts("1: YES\n3: YES", 3)
        self.assertEqual(len(vs), 3)
        self.assertEqual([v.matched for v in vs], [True, False, True])

    def test_garbage_yields_all_NO(self):
        from eval.metrics.judge import parse_batch_verdicts
        vs = parse_batch_verdicts("I could not determine this.", 2)
        self.assertEqual([v.matched for v in vs], [False, False])
        self.assertTrue(all("unparseable" in v.note for v in vs))

    def test_end_to_end_uses_one_call_per_category(self):
        seen = []

        def fake_run(prompts):
            seen.append(prompts)
            out = []
            for p in prompts:
                out.append("1: NO\n2: NO" if "TRANSCRIPT" in p else "VERDICT: NO\nEVIDENCE: NONE")
            return out

        doc = {"minutes": [{"kind": "decision", "content": "alpha"},
                           {"kind": "decision", "content": "beta"}]}
        r = BatchedJudge(fake_run).score({"decisions": [], "actions": [], "questions": []},
                                         doc, transcript="nothing like those",
                                         own_transcript="alpha beta")
        self.assertEqual(r["unsupported"]["decisions"], 2)
        # decisions is the only non-empty category, so exactly one support prompt exists.
        support_prompts = [p for batch in seen for p in batch if "TRANSCRIPT" in p]
        self.assertEqual(len(support_prompts), 1)
