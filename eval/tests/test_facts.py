"""The schema for the hand-labelled reference. A reference that silently accepts a typo'd state or
a span that runs off the end of the audio would corrupt every score computed from it, so every
way a facts.json can be wrong has a test that names the problem it must report."""
import unittest

from eval import facts


def good():
    return {
        "prices": [{"id": "pr1", "span_ms": [1000, 4000], "spoken": "four ninety nine a month",
                    "amount": 4.99, "currency": "USD", "period": "month"}],
        "dates": [{"id": "d1", "span_ms": [5000, 6000], "spoken": "Thursday",
                   "resolved_date": "2026-10-08", "relative_to": "2026-10-05"}],
        "commitments": [{"id": "c1", "span_ms": [7000, 9000], "text": "Rahul will recruit two people",
                         "owner": "Rahul", "due_spoken": "before Wednesday", "due_date": None,
                         "state": "promised"}],
        "decisions": [{"id": "dc1", "span_ms": [10000, 12000], "text": "ship on Thursday"}],
        "owners_note": "",
    }


def problems_of(doc, audio_ms=None):
    return facts.validate(doc, audio_ms=audio_ms)


class ValidFileTest(unittest.TestCase):
    def test_a_good_file_has_no_problems(self):
        self.assertEqual(problems_of(good(), audio_ms=60000), [])

    def test_the_empty_skeleton_is_valid(self):
        self.assertEqual(problems_of(facts.empty_facts()), [])

    def test_enums_are_named_constants(self):
        self.assertEqual(facts.STATES, ("promised", "completed", "conditional", "withdrawn"))
        self.assertEqual(facts.CLASSES, ("prices", "dates", "commitments", "decisions"))


class ProblemTest(unittest.TestCase):
    def assertProblem(self, doc, needle, audio_ms=None):
        found = problems_of(doc, audio_ms)
        self.assertTrue(any(needle in p for p in found), f"{needle!r} not in {found}")

    def test_duplicate_id_within_a_class(self):
        d = good()
        d["prices"].append(dict(d["prices"][0]))
        self.assertProblem(d, "duplicate id 'pr1'")

    def test_duplicate_id_across_classes(self):
        d = good()
        d["decisions"][0]["id"] = "pr1"
        self.assertProblem(d, "duplicate id 'pr1'")

    def test_span_end_before_start(self):
        d = good()
        d["dates"][0]["span_ms"] = [6000, 5000]
        self.assertProblem(d, "ends (5000) before it starts (6000)")

    def test_span_must_be_two_integers(self):
        d = good()
        d["dates"][0]["span_ms"] = [6000]
        self.assertProblem(d, "span_ms must be [start, end]")

    def test_unknown_state(self):
        d = good()
        d["commitments"][0]["state"] = "done"
        self.assertProblem(d, "unknown state 'done'")

    def test_span_outside_audio(self):
        d = good()
        d["decisions"][0]["span_ms"] = [59000, 61000]
        self.assertProblem(d, "outside the audio (0-60000 ms)", audio_ms=60000)

    def test_span_outside_audio_not_checked_without_truth(self):
        d = good()
        d["decisions"][0]["span_ms"] = [59000, 61000]
        self.assertEqual(problems_of(d), [])

    def test_missing_required_field(self):
        d = good()
        del d["prices"][0]["amount"]
        self.assertProblem(d, "missing field 'amount'")

    def test_missing_id(self):
        d = good()
        del d["decisions"][0]["id"]
        self.assertProblem(d, "needs a non-empty string id")

    def test_bad_date_format(self):
        d = good()
        d["dates"][0]["resolved_date"] = "Thursday"
        self.assertProblem(d, "resolved_date must be YYYY-MM-DD or null")

    def test_bad_due_date_format(self):
        d = good()
        d["commitments"][0]["due_date"] = "next week"
        self.assertProblem(d, "due_date must be YYYY-MM-DD or null")

    def test_amount_must_be_a_number(self):
        d = good()
        d["prices"][0]["amount"] = "four ninety nine"
        self.assertProblem(d, "amount must be a number")

    def test_unknown_top_level_key(self):
        d = good()
        d["price"] = []
        self.assertProblem(d, "unknown top-level key 'price'")

    def test_a_class_must_be_a_list(self):
        d = good()
        d["prices"] = {}
        self.assertProblem(d, "'prices' must be a list")

    def test_owner_may_be_null(self):
        d = good()
        d["commitments"][0]["owner"] = None
        self.assertEqual(problems_of(d), [])

    def test_structured_problems_carry_the_item_id(self):
        d = good()
        d["commitments"][0]["state"] = "done"
        issues = facts.check(d)
        self.assertEqual([(i.cls, i.item_id) for i in issues], [("commitments", "c1")])


if __name__ == "__main__":
    unittest.main()
