"""MOM scoring arithmetic, with a scripted judge in place of a model.

Everything here is deliberately model-free: the judge is the weakest link in the harness, so the
arithmetic around it has to be provably right before any of its verdicts are believed.
"""
import unittest

from eval.metrics.mom import Verdict, from_document, parse_action, score_minutes

REFERENCE = {
    "decisions": ["The remote will sell for 25 Euro."],
    "actions": [
        {"text": "The designer will work on the casing.", "owner": "Ana", "due": "Friday"},
        {"text": "Marketing will run a survey.", "owner": "", "due": ""},
    ],
    "questions": ["Whether the remote is only for televisions."],
}

DOCUMENT = {"minutes": [
    {"kind": "summary", "content": "2 action items, 1 decision.", "source": "rule"},
    {"kind": "decision", "content": "We decided on 25 Euro.", "source": "rule"},
    {"kind": "action", "content": "I'll do the casing. — Ana (due Friday)", "source": "rule"},
    {"kind": "action", "content": "Someone should survey users. — Unassigned", "source": "rule"},
]}


class Scripted:
    """A judge whose answers are fixed in advance, so the arithmetic is what gets tested."""

    def __init__(self, captures=None, supported=None):
        self._captures = captures or {}
        self._supported = supported or {}
        self.asked = []

    def captures(self, item, category, produced):
        self.asked.append(("captures", item))
        return self._captures.get(item, Verdict(False))

    def supported(self, item, category, transcript):
        self.asked.append(("supported", item))
        return self._supported.get(item, Verdict(True))


class ParseActionTest(unittest.TestCase):
    def test_owner_and_due(self):
        self.assertEqual(parse_action("I'll do the casing. — Ana (due Friday)"),
                         ("I'll do the casing.", "Ana", "Friday"))

    def test_owner_only(self):
        self.assertEqual(parse_action("Send the deck. — Unassigned"),
                         ("Send the deck.", "Unassigned", ""))

    def test_no_owner_at_all(self):
        self.assertEqual(parse_action("Just a sentence."), ("Just a sentence.", "", ""))

    def test_an_em_dash_inside_the_sentence_is_not_the_owner_separator(self):
        # The separator is the LAST " — ", because the sentence itself may contain one.
        self.assertEqual(parse_action("Ship it — and quickly. — Bo (due Monday)"),
                         ("Ship it — and quickly.", "Bo", "Monday"))


class FromDocumentTest(unittest.TestCase):
    def test_categories_and_summary_dropped(self):
        p = from_document(DOCUMENT)
        self.assertEqual(p["decisions"], ["We decided on 25 Euro."])
        self.assertEqual(len(p["actions"]), 2)
        self.assertEqual(p["actions"][0], {"text": "I'll do the casing.", "owner": "Ana",
                                           "due": "Friday"})
        self.assertEqual(p["questions"], [])


class RecallTest(unittest.TestCase):
    def test_everything_captured(self):
        judge = Scripted(captures={
            "The remote will sell for 25 Euro.": Verdict(True, "We decided on 25 Euro."),
            "The designer will work on the casing.": Verdict(True, "I'll do the casing."),
            "Marketing will run a survey.": Verdict(True, "Someone should survey users."),
            "Whether the remote is only for televisions.": Verdict(True, "x"),
        })
        r = score_minutes(REFERENCE, DOCUMENT, judge, transcript="")
        self.assertEqual(r["recall"]["decisions"], 1.0)
        self.assertEqual(r["recall"]["actions"], 1.0)
        self.assertEqual(r["recall"]["overall"], 1.0)

    def test_partial_recall(self):
        judge = Scripted(captures={
            "The designer will work on the casing.": Verdict(True, "I'll do the casing.")})
        r = score_minutes(REFERENCE, DOCUMENT, judge, transcript="")
        self.assertEqual(r["recall"]["actions"], 0.5)
        self.assertEqual(r["recall"]["decisions"], 0.0)
        self.assertEqual(r["recall"]["overall"], 0.25)  # 1 of 4 reference items

    def test_empty_reference_category_is_none_not_zero(self):
        """A category the reference never mentions is unmeasured, not failed.

        Scoring it 0% would drag the overall number down for a meeting that simply had no
        decisions in it, and 0% reads as a bug in the product rather than an absence in the
        reference.
        """
        ref = {"decisions": [], "actions": [], "questions": ["Q?"]}
        r = score_minutes(ref, DOCUMENT, Scripted(), transcript="")
        self.assertIsNone(r["recall"]["decisions"])
        self.assertEqual(r["recall"]["questions"], 0.0)
        self.assertNotIn("decisions", [c for c, v in r["recall"].items() if v == 0.0])

    def test_no_reference_items_at_all_leaves_overall_none(self):
        r = score_minutes({"decisions": [], "actions": [], "questions": []}, DOCUMENT,
                          Scripted(), transcript="")
        self.assertIsNone(r["recall"]["overall"])


class HallucinationTest(unittest.TestCase):
    def test_unsupported_items_are_counted(self):
        judge = Scripted(supported={"We decided on 25 Euro.": Verdict(False, note="not said")})
        r = score_minutes(REFERENCE, DOCUMENT, judge, transcript="t")
        self.assertEqual(r["hallucinated"]["decisions"], 1)
        self.assertEqual(r["precision"]["decisions"], 0.0)
        self.assertEqual(r["precision"]["actions"], 1.0)

    def test_precision_needs_a_transcript(self):
        """Without ground-truth text there is nothing to check support against, so precision is
        not computed rather than assumed perfect."""
        r = score_minutes(REFERENCE, DOCUMENT, Scripted(), transcript="")
        self.assertIsNone(r["precision"]["decisions"])
        self.assertEqual(r["hallucinated"], {})


class OwnerDueTest(unittest.TestCase):
    def test_owner_and_due_checked_only_on_matched_actions(self):
        judge = Scripted(captures={
            "The designer will work on the casing.": Verdict(True, "I'll do the casing. — Ana (due Friday)"),
            "Marketing will run a survey.": Verdict(True, "Someone should survey users. — Unassigned"),
        })
        r = score_minutes(REFERENCE, DOCUMENT, judge, transcript="")
        # Ana/Friday match; the second reference action leaves both fields empty, so it is skipped
        # rather than counted as a pass or a failure.
        self.assertEqual(r["owner"], {"correct": 1, "checked": 1})
        self.assertEqual(r["due"], {"correct": 1, "checked": 1})


class AuditTest(unittest.TestCase):
    def test_every_verdict_is_retained(self):
        r = score_minutes(REFERENCE, DOCUMENT, Scripted(), transcript="")
        self.assertEqual(len(r["verdicts"]), 4)
        self.assertTrue(all("item" in v and "matched" in v for v in r["verdicts"]))


if __name__ == "__main__":
    unittest.main()


class EvidenceIsAPointerTest(unittest.TestCase):
    """The judge quotes the minutes as RENDERED, not as the CLI composed them.

    render_minutes prints "text   [owner: Ana due: Friday]"; the CLI composes
    "text — Ana (due Friday)". Re-parsing the judge's quote with the CLI's grammar therefore
    finds no owner at all and scores every matched action as wrong. The evidence is a pointer to
    a produced item — resolve it back to that item and read the fields off it.
    """

    def test_owner_read_from_the_produced_item_not_the_quote(self):
        judge = Scripted(captures={
            "The designer will work on the casing.":
                Verdict(True, "I'll do the casing.   [owner: Ana due: Friday]"),
        })
        r = score_minutes(REFERENCE, DOCUMENT, judge, transcript="")
        self.assertEqual(r["owner"], {"correct": 1, "checked": 1})
        self.assertEqual(r["due"], {"correct": 1, "checked": 1})

    def test_a_quote_matching_nothing_is_not_credited(self):
        judge = Scripted(captures={
            "The designer will work on the casing.": Verdict(True, "something else entirely"),
        })
        r = score_minutes(REFERENCE, DOCUMENT, judge, transcript="")
        self.assertEqual(r["owner"], {"correct": 0, "checked": 1})
